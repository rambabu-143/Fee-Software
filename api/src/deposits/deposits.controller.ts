import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { DepositKind, PaymentMode } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { fromPaise, toPaise } from '../billing/bill.js';

class CreateDepositDto {
  @IsInt() studentId: number;
  @IsEnum(DepositKind) kind: DepositKind;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsInt() receivedYearId: number;
  @IsOptional() @IsInt() paymentId?: number;
}

class ImportRow {
  @IsString() @MinLength(1) admissionNo: string;
  @IsEnum(DepositKind) kind: DepositKind;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsString() year: string; // academic year label, e.g. "2026-27"
  @IsOptional() @IsEnum({ HELD: 'HELD', REFUNDED: 'REFUNDED' }) status?: 'HELD' | 'REFUNDED';
}

class ImportDto {
  @IsInt() schoolId: number;
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => ImportRow) rows: ImportRow[];
}

class RefundDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) refundAmount: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) deduction?: number;
  @IsEnum(PaymentMode) mode: PaymentMode;
  @ValidateIf((o) => o.mode !== 'CASH') @IsString() @MinLength(3) reference?: string;
  @IsDateString() date: string;
  @IsOptional() @IsString() remarks?: string;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));
const money = (v: { toFixed(n: number): string } | null) => v?.toFixed(2) ?? null;

type Row = Awaited<ReturnType<DepositsController['rows']>>[number];
const present = (d: Row) => ({
  id: d.id, studentId: d.studentId, admissionNo: d.student.admissionNo, name: d.student.name, kind: d.kind,
  amount: money(d.amount), receivedYear: d.receivedYear.label, paymentId: d.paymentId, status: d.status,
  refundedAt: d.refundedAt, refundAmount: money(d.refundAmount), deduction: money(d.deduction),
  refundMode: d.refundMode, refundRef: d.refundRef, remarks: d.remarks,
});

@Controller('deposits')
export class DepositsController {
  constructor(private prisma: PrismaService) {}

  rows(where: object) {
    return this.prisma.deposit.findMany({
      where, include: { student: { select: { admissionNo: true, name: true } }, receivedYear: { select: { label: true } } },
      orderBy: { id: 'asc' }, take: 2000, // ponytail: cap instead of pagination
    });
  }

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', new ParseIntPipe({ optional: true })) yearId?: number,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('standardId', new ParseIntPipe({ optional: true })) standardId?: number,
  ) {
    assertSchool(u, schoolId);
    if (kind && !(kind in DepositKind)) throw new BadRequestException('Bad kind');
    if (status && !['HELD', 'REFUNDED', 'ADJUSTED', 'FORFEITED'].includes(status)) throw new BadRequestException('Bad status');
    const rows = await this.rows({
      student: {
        schoolId,
        // class filter: the student's enrollment in the chosen year
        ...(standardId && yearId ? { enrollments: { some: { yearId, section: { standardId } } } } : {}),
      },
      ...(yearId ? { receivedYearId: yearId } : {}),
      ...(kind ? { kind } : {}), ...(status ? { status } : {}),
    });
    return rows.map(present);
  }

  // Held / refunded totals per kind and year received, side by side.
  @Get('report/compare')
  async compare(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('yearIds') yearIds?: string) {
    assertSchool(u, schoolId);
    const ids = yearIds ? yearIds.split(',').map(Number) : [];
    if (ids.some((n) => !Number.isInteger(n))) throw new BadRequestException('Bad yearIds');
    const rows = await this.prisma.deposit.groupBy({
      by: ['receivedYearId', 'kind', 'status'],
      where: { student: { schoolId }, ...(ids.length ? { receivedYearId: { in: ids } } : {}) },
      _sum: { amount: true }, _count: true,
      orderBy: [{ receivedYearId: 'asc' }, { kind: 'asc' }, { status: 'asc' }],
    });
    const years = new Map((await this.prisma.academicYear.findMany({ where: { id: { in: rows.map((r) => r.receivedYearId) } } })).map((y) => [y.id, y.label]));
    return rows.map((r) => ({
      year: years.get(r.receivedYearId), kind: r.kind, status: r.status, count: r._count, amount: money(r._sum.amount) ?? '0.00',
    }));
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateDepositDto) {
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: dto.studentId } });
    assertSchool(u, student.schoolId);
    await this.prisma.academicYear.findUniqueOrThrow({ where: { id: dto.receivedYearId } });
    if (dto.paymentId) {
      const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: dto.paymentId } });
      if (p.studentId !== student.id || p.cancelledAt || p.clearStatus === 'BOUNCED') throw new BadRequestException('Payment is not a live receipt of this student');
    }
    const d = await this.prisma.deposit.create({
      data: { ...dto, amount: fromPaise(toPaise(String(dto.amount))), createdBy: u.username },
      include: { student: { select: { admissionNo: true, name: true } }, receivedYear: { select: { label: true } } },
    });
    return present(d);
  }

  // All-or-nothing opening-balance load. Existing (student, kind) rows are reported as errors, not overwritten.
  @Roles('ADMIN')
  @Post('import')
  async import(@CurrentUser() u: AuthUser, @Body() dto: ImportDto) {
    assertSchool(u, dto.schoolId);
    const [students, years, existing] = await Promise.all([
      this.prisma.student.findMany({ where: { schoolId: dto.schoolId } }),
      this.prisma.academicYear.findMany(),
      this.prisma.deposit.findMany({ where: { student: { schoolId: dto.schoolId } } }),
    ]);
    const sByNo = new Map(students.map((s) => [s.admissionNo, s.id]));
    const yByLabel = new Map(years.map((y) => [y.label, y.id]));
    const seen = new Set(existing.map((d) => `${d.studentId}:${d.kind}`));
    const errors: { row: number; msg: string }[] = [];
    const data = dto.rows.map((r, i) => {
      const studentId = sByNo.get(r.admissionNo.trim());
      const receivedYearId = yByLabel.get(r.year.trim());
      if (!studentId) errors.push({ row: i + 1, msg: `Unknown admission no ${r.admissionNo}` });
      if (!receivedYearId) errors.push({ row: i + 1, msg: `Unknown year ${r.year}` });
      const key = `${studentId}:${r.kind}`;
      if (studentId && seen.has(key)) errors.push({ row: i + 1, msg: `Deposit ${r.kind} already exists for ${r.admissionNo}` });
      seen.add(key);
      const amount = fromPaise(toPaise(String(r.amount)));
      const refunded = r.status === 'REFUNDED';
      return {
        studentId: studentId!, receivedYearId: receivedYearId!, kind: r.kind, amount, createdBy: u.username,
        ...(refunded ? { status: 'REFUNDED' as const, refundAmount: amount, deduction: '0.00', refundedAt: today() } : {}),
      };
    });
    if (errors.length) throw new BadRequestException({ message: 'Import rejected, nothing saved', errors });
    await this.prisma.deposit.createMany({ data });
    return { imported: data.length };
  }

  // refund + deduction must equal the deposit. refund 0 = fully forfeited. HELD -> final in one atomic update,
  // so two clicks (or two counters) can never refund the same deposit twice.
  @Roles('ADMIN')
  @Post(':id/refund')
  async refund(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RefundDto) {
    const d = await this.prisma.deposit.findUniqueOrThrow({ where: { id }, include: { student: { select: { schoolId: true } } } });
    assertSchool(u, d.student.schoolId);
    const date = new Date(dto.date);
    if (date > today()) throw new BadRequestException('Refund date cannot be in the future');
    const refund = toPaise(String(dto.refundAmount));
    const deduction = toPaise(String(dto.deduction ?? 0));
    if (refund + deduction !== toPaise(d.amount.toFixed(2))) {
      throw new BadRequestException(`Refund + deduction must equal the deposit (₹${d.amount.toFixed(2)})`);
    }
    const { count } = await this.prisma.deposit.updateMany({
      where: { id, status: 'HELD' },
      data: {
        status: refund === 0 ? 'FORFEITED' : 'REFUNDED', refundedAt: date, refundAmount: fromPaise(refund), deduction: fromPaise(deduction),
        refundMode: dto.mode, refundRef: dto.mode === 'CASH' ? null : dto.reference, remarks: dto.remarks,
      },
    });
    if (!count) throw new BadRequestException('Deposit is no longer held (already refunded, forfeited or adjusted)');
    const [row] = await this.rows({ id });
    return present(row);
  }
}
