import {
  BadRequestException, Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res, StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateIf } from 'class-validator';
import { PaymentMode, VoucherKind, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import { voucherPdf, voucherReportPdf } from './voucher-pdf.js';

class CreateVoucherDto {
  @IsInt() schoolId: number;
  @IsInt() yearId: number;
  @IsInt() enrollmentId: number;
  @IsEnum(VoucherKind) kind: VoucherKind;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsDateString() date: string;
  @IsEnum(PaymentMode) mode: PaymentMode;
  @ValidateIf((o) => o.mode !== 'CASH') @IsString() @MinLength(3) reference?: string;
  @IsOptional() @IsString() remarks?: string;
}

class CancelVoucherDto {
  @IsString() @MinLength(3) reason: string;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));
const day = (s: string | undefined, name: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(+d)) throw new BadRequestException(`Bad ${name} date`);
  return d;
};

const include = {
  enrollment: { include: { student: { select: { admissionNo: true, name: true } }, section: { include: { standard: true } } } },
  year: { select: { label: true } },
} satisfies Prisma.VoucherInclude;
type Row = Prisma.VoucherGetPayload<{ include: typeof include }>;
const className = (v: Row) => `${v.enrollment.section.standard.name} ${v.enrollment.section.name}`;
const present = (v: Row) => {
  const { enrollment, year, ...rest } = v;
  return { ...rest, amount: v.amount.toFixed(2), student: enrollment.student, className: className(v), year: year.label };
};

@Controller('vouchers')
export class VouchersController {
  constructor(private prisma: PrismaService) {}

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateVoucherDto) {
    assertSchool(u, dto.schoolId);
    const date = new Date(dto.date);
    if (date > today()) throw new BadRequestException('Voucher date cannot be in the future');
    if (dto.kind === 'OTHER' && !dto.remarks) throw new BadRequestException('Remarks are required for OTHER vouchers');
    const amount = toPaise(String(dto.amount));

    const created = await this.prisma.$transaction(async (tx) => {
      const e = await tx.enrollment.findUniqueOrThrow({ where: { id: dto.enrollmentId }, include: { student: true, withdrawal: true } });
      if (e.student.schoolId !== dto.schoolId || e.yearId !== dto.yearId) throw new BadRequestException('Enrollment does not belong to this school and year');

      // Serialise payouts per student so two counters can't both refund the same money.
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${e.studentId} FOR UPDATE`;

      // What the family can still be paid for this purpose, minus live vouchers already issued for it.
      let ceiling: number | null = null;
      let held: { id: number; amount: Prisma.Decimal } | null = null; // HELD deposit these vouchers pay out
      let left = 0;
      if (dto.kind === 'CAUTION_REFUND' || dto.kind === 'ADVANCE_REFUND') {
        // Deposit refund decisions live on Deposit; the voucher is the payout against it.
        const dep = await tx.deposit.findUnique({ where: { studentId_kind: { studentId: e.studentId, kind: dto.kind === 'CAUTION_REFUND' ? 'CAUTION' : 'ADVANCE' } } });
        if (!dep || (dep.status !== 'HELD' && dep.status !== 'REFUNDED')) throw new BadRequestException('No refundable deposit for this student');
        ceiling = toPaise((dep.status === 'REFUNDED' ? dep.refundAmount! : dep.amount).toFixed(2));
        if (dep.status === 'HELD') held = dep;
      } else if (dto.kind === 'EXCESS_REFUND') {
        if (!e.withdrawal) throw new BadRequestException('Excess refunds need a recorded withdrawal');
        ceiling = toPaise(e.withdrawal.excessPaid.toFixed(2));
      }
      if (ceiling !== null) {
        const issued = await tx.voucher.aggregate({
          _sum: { amount: true },
          where: { enrollment: { studentId: e.studentId }, kind: dto.kind, cancelledAt: null, ...(dto.kind === 'EXCESS_REFUND' ? { enrollmentId: e.id } : {}) },
        });
        left = ceiling - toPaise((issued._sum.amount ?? 0).toString());
        if (amount > left) throw new BadRequestException(`Amount is more than the refundable balance (₹${fromPaise(Math.max(left, 0))})`);
      }

      const { last: voucherNo } = await tx.voucherCounter.upsert({
        where: { schoolId_yearId: { schoolId: dto.schoolId, yearId: dto.yearId } },
        create: { schoolId: dto.schoolId, yearId: dto.yearId, last: 1 },
        update: { last: { increment: 1 } },
      });
      const v = await tx.voucher.create({
        data: {
          schoolId: dto.schoolId, yearId: dto.yearId, enrollmentId: e.id, voucherNo, date, kind: dto.kind, amount: fromPaise(amount),
          mode: dto.mode, reference: dto.mode === 'CASH' ? null : dto.reference, remarks: dto.remarks, createdBy: u.username,
        },
        include,
      });
      // Paid out in full with no refund decision recorded: the deposit is refunded (a cancelled voucher undoes this).
      if (held && amount === left) {
        await tx.deposit.update({
          where: { id: held.id },
          data: {
            status: 'REFUNDED', autoRefunded: true, refundedAt: date, refundAmount: held.amount, deduction: '0.00',
            refundMode: dto.mode, refundRef: dto.mode === 'CASH' ? null : dto.reference,
          },
        });
      }
      return v;
    });
    return present(created);
  }

  // JSON list, or the class-wise register as a PDF with ?pdf=1.
  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('kind') kind?: string,
    @Query('standardId', new ParseIntPipe({ optional: true })) standardId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('pdf') pdf?: string,
  ) {
    assertSchool(u, schoolId);
    if (kind && !(kind in VoucherKind)) throw new BadRequestException('Bad kind');
    const f = day(from, 'from'), t = day(to, 'to');
    const rows = await this.prisma.voucher.findMany({
      where: {
        schoolId, yearId, ...(kind ? { kind: kind as VoucherKind } : {}),
        ...(standardId ? { enrollment: { section: { standardId } } } : {}),
        ...(f || t ? { date: { ...(f && { gte: f }), ...(t && { lte: t }) } } : {}),
      },
      include, orderBy: { voucherNo: 'desc' }, take: 1000, // ponytail: cap instead of pagination
    });
    if (!pdf) return rows.map(present);

    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
    const total = rows.filter((r) => !r.cancelledAt).reduce((s, r) => s + toPaise(r.amount.toFixed(2)), 0);
    const buf = await voucherReportPdf(school.name, `Voucher Register · ${rows[0]?.year.label ?? ''}`, rows.map((r) => ({
      voucherNo: r.voucherNo, date: r.date, admissionNo: r.enrollment.student.admissionNo, name: r.enrollment.student.name,
      className: className(r), kind: r.kind, mode: r.mode, amount: r.amount.toFixed(2), cancelled: !!r.cancelledAt,
    })), fromPaise(total));
    res.setHeader('Content-Type', 'application/pdf');
    return new StreamableFile(buf, { disposition: 'inline; filename="vouchers.pdf"' });
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const v = await this.prisma.voucher.findUniqueOrThrow({ where: { id }, include });
    assertSchool(u, v.schoolId);
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: v.schoolId } });
    const buf = await voucherPdf(school.name, {
      ...v, amount: v.amount.toFixed(2), student: v.enrollment.student, className: className(v), year: v.year.label,
    });
    return new StreamableFile(buf, { disposition: `inline; filename="voucher-${v.voucherNo}.pdf"` });
  }

  // Keeps its number; stops counting against the refundable balance.
  @Roles('ADMIN')
  @Post(':id/cancel')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelVoucherDto) {
    const v = await this.prisma.voucher.findUniqueOrThrow({ where: { id }, include });
    assertSchool(u, v.schoolId);
    return this.prisma.$transaction(async (tx) => {
      // Same student lock as create(), so a cancel can't interleave with a payout against the same deposit.
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${v.enrollment.studentId} FOR UPDATE`;
      const { count } = await tx.voucher.updateMany({
        where: { id, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: dto.reason },
      });
      if (!count) throw new BadRequestException('Voucher is already cancelled');
      // A deposit that these vouchers had refunded in full goes back to HELD once they no longer cover it.
      const kind = v.kind === 'CAUTION_REFUND' ? 'CAUTION' : v.kind === 'ADVANCE_REFUND' ? 'ADVANCE' : null;
      const dep = kind && await tx.deposit.findUnique({ where: { studentId_kind: { studentId: v.enrollment.studentId, kind } } });
      if (dep && dep.autoRefunded && dep.status === 'REFUNDED') {
        const live = await tx.voucher.aggregate({
          _sum: { amount: true }, where: { enrollment: { studentId: dep.studentId }, kind: v.kind, cancelledAt: null },
        });
        if (toPaise((live._sum.amount ?? 0).toString()) < toPaise(dep.amount.toFixed(2))) {
          await tx.deposit.update({
            where: { id: dep.id },
            data: { status: 'HELD', autoRefunded: false, refundedAt: null, refundAmount: null, deduction: null, refundMode: null, refundRef: null },
          });
        }
      }
      return present(await tx.voucher.findUniqueOrThrow({ where: { id }, include }));
    });
  }
}
