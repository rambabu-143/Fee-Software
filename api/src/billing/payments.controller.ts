import {
  BadRequestException, Body, Controller, Get, Header, Param, ParseDatePipe, ParseIntPipe, Post, Query, StreamableFile,
} from '@nestjs/common';
import {
  IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateIf,
} from 'class-validator';
import { PaymentMode, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from './billing.service.js';
import { allocate, fromPaise, toPaise } from './bill.js';
import { receiptPdf } from './pdf.js';

class CollectDto {
  @IsInt() studentId: number;
  @IsInt() yearId: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsEnum(PaymentMode) mode: PaymentMode;
  // Cheque no. / UPI or bank transaction id: required for everything except cash.
  @ValidateIf((o) => o.mode !== 'CASH') @IsString() @MinLength(3) reference?: string;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsDateString() date?: string;
  // Cheques need a bank and cheque number; other non-cash modes may name the receiving bank.
  @IsOptional() @IsInt() bankId?: number;
  @ValidateIf((o) => o.mode === 'CHEQUE' || o.chequeNo !== undefined) @IsString() @MinLength(1) chequeNo?: string;
  @IsOptional() @IsDateString() chequeDate?: string;
}

class ReconcileDto {
  @IsIn(['CLEARED', 'BOUNCED']) status: 'CLEARED' | 'BOUNCED';
  @ValidateIf((o) => o.status === 'CLEARED' || o.bankDate !== undefined) @IsDateString() bankDate?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) bounceCharge?: number;
}

class CancelDto {
  @IsString() @MinLength(3) reason: string;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));

const receiptInclude = {
  student: { select: { admissionNo: true, name: true } },
  allocations: { include: { installment: { select: { label: true, number: true } } } },
} satisfies Prisma.PaymentInclude;

type ReceiptRow = Prisma.PaymentGetPayload<{ include: typeof receiptInclude }>;
// The arrear portion (no installment) is listed first, as 'Previous arrear', with its amount in charges.
const present = (p: ReceiptRow) => ({
  ...p,
  amount: p.amount.toFixed(2),
  allocations: p.allocations
    .sort((a, b) => (a.installment?.number ?? 0) - (b.installment?.number ?? 0))
    .map((a) => a.installment
      ? { installment: a.installment.label, charges: a.charges.toFixed(2), fine: a.fine.toFixed(2) }
      : { installment: 'Previous arrear', charges: a.arrear.toFixed(2), fine: a.fine.toFixed(2) }),
});

@Controller('payments')
export class PaymentsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('studentId', new ParseIntPipe({ optional: true })) studentId?: number,
    @Query('from', new ParseDatePipe({ optional: true })) from?: Date,
    @Query('to', new ParseDatePipe({ optional: true })) to?: Date,
  ) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.payment.findMany({
      where: {
        schoolId, yearId,
        ...(studentId ? { studentId } : {}),
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: receiptInclude,
      orderBy: { receiptNo: 'desc' },
      take: 20000, // ponytail: cap instead of pagination (1000 truncates one year of a 600-student school)
    });
    return rows.map(present);
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id }, include: receiptInclude });
    assertSchool(u, p.schoolId);
    return present(p);
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id }, include: { ...receiptInclude, school: true, year: true },
    });
    assertSchool(u, p.schoolId);
    const buf = await receiptPdf(p.school.name, { ...present(p), year: p.year.label });
    return new StreamableFile(buf, { disposition: `inline; filename="receipt-${p.receiptNo}.pdf"` });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  async collect(@CurrentUser() u: AuthUser, @Body() dto: CollectDto) {
    const date = dto.date ? new Date(dto.date) : today();
    if (date > today()) throw new BadRequestException('Payment date cannot be in the future');
    const amount = toPaise(String(dto.amount));
    if (dto.mode === 'CHEQUE' && !dto.bankId) throw new BadRequestException('bankId is required for cheque payments');
    if (dto.mode === 'CASH' && (dto.bankId || dto.chequeNo || dto.chequeDate)) throw new BadRequestException('Cash payments have no bank or cheque details');

    const payment = await this.prisma.$transaction(async (tx) => {
      const bill = await this.billing.build(dto.studentId, dto.yearId, date, tx);
      assertSchool(u, bill.student.schoolId);
      if (dto.bankId) {
        const bank = await tx.bank.findUnique({ where: { id: dto.bankId } });
        if (!bank || bank.schoolId !== bill.student.schoolId || !bank.active) throw new BadRequestException('Unknown or inactive bank for this school');
      }

      // Lock this student's enrollment so two counters can't collect against the same balance.
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${bill.student.enrollmentId} FOR UPDATE`;
      const fresh = await this.billing.build(dto.studentId, dto.yearId, date, tx);

      // Backdating before an existing receipt would re-split money already allocated.
      const last = await tx.payment.findFirst({
        where: { studentId: dto.studentId, yearId: dto.yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' }, date: { gt: date } },
      });
      if (last) throw new BadRequestException('A later receipt already exists for this student');

      let split;
      try {
        split = allocate(fresh.installments, amount, fresh.arrear.due);
      } catch (e) {
        if (e instanceof RangeError) throw new BadRequestException(`${e.message} (₹${fromPaise(fresh.totals.due)})`);
        throw e;
      }

      // One atomic statement: the row lock serialises counters, and GREATEST self-heals a counter that
      // lags receipts inserted outside the API (otherwise every collection would 409 forever).
      const sid = bill.student.schoolId;
      const [{ last: receiptNo }] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO "ReceiptCounter" ("schoolId", "yearId", last)
        VALUES (${sid}, ${dto.yearId}, 1 + COALESCE((SELECT MAX("receiptNo") FROM "Payment" WHERE "schoolId" = ${sid} AND "yearId" = ${dto.yearId}), 0))
        ON CONFLICT ("schoolId", "yearId") DO UPDATE SET last = 1 + GREATEST(
          "ReceiptCounter".last, COALESCE((SELECT MAX("receiptNo") FROM "Payment" WHERE "schoolId" = ${sid} AND "yearId" = ${dto.yearId}), 0))
        RETURNING last`;

      return tx.payment.create({
        data: {
          schoolId: bill.student.schoolId, yearId: dto.yearId, studentId: dto.studentId, receiptNo, date,
          mode: dto.mode, reference: dto.mode === 'CASH' ? null : dto.reference, remarks: dto.remarks,
          bankId: dto.bankId, chequeNo: dto.chequeNo, chequeDate: dto.chequeDate ? new Date(dto.chequeDate) : undefined,
          clearStatus: dto.mode === 'CASH' ? 'CLEARED' : 'PENDING',
          amount: fromPaise(amount), createdBy: u.username,
          allocations: {
            create: split.map((a) => ({
              installmentId: a.installmentId, charges: fromPaise(a.charges), fine: fromPaise(a.fine), arrear: fromPaise(a.arrear ?? 0),
            })),
          },
        },
        include: receiptInclude,
      });
    });
    return present(payment);
  }

  @Roles('ADMIN')
  @Post(':id/cancel')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelDto) {
    const updated = await this.prisma.$transaction(async (tx) => {
      // Same enrollment row lock as collect()/reconcile(): double-clicks and cancel-vs-collect can't interleave.
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      assertSchool(u, p.schoolId);
      const e = await tx.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: p.studentId, yearId: p.yearId } } });
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${e.id} FOR UPDATE`;
      const cur = await tx.payment.findUniqueOrThrow({ where: { id } });
      if (cur.cancelledAt) throw new BadRequestException('Receipt is already cancelled');
      if (cur.clearStatus === 'BOUNCED') throw new BadRequestException('Receipt is bounced; it no longer counts');
      const later = await tx.payment.findFirst({
        where: { studentId: cur.studentId, yearId: cur.yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' }, receiptNo: { gt: cur.receiptNo } },
      });
      if (later) throw new BadRequestException(`Cancel the later receipt #${later.receiptNo} first`);
      return tx.payment.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelledBy: u.username, cancelReason: dto.reason },
        include: receiptInclude,
      });
    });
    return present(updated);
  }

  // Bank credit (or return) of a cheque / online receipt. A bounced receipt stops counting, like a cancelled one.
  // ponytail: bounceCharge is only recorded on the receipt; billing it to the family is not done.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post(':id/reconcile')
  async reconcile(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ReconcileDto) {
    if (dto.status === 'CLEARED' && dto.bounceCharge !== undefined) throw new BadRequestException('bounceCharge applies only to bounced receipts');
    const bankDate = dto.bankDate ? new Date(dto.bankDate) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Same row lock as collect(), so a bounce can't interleave with a collection on the same balance.
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      assertSchool(u, p.schoolId);
      const e = await tx.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: p.studentId, yearId: p.yearId } } });
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${e.id} FOR UPDATE`;
      const cur = await tx.payment.findUniqueOrThrow({ where: { id } });
      if (cur.cancelledAt) throw new BadRequestException('Receipt is cancelled');
      if (cur.mode === 'CASH') throw new BadRequestException('Cash receipts are not reconciled');
      if (cur.clearStatus === 'BOUNCED') throw new BadRequestException('Receipt is already bounced');
      if (cur.clearStatus === dto.status) throw new BadRequestException(`Receipt is already ${dto.status.toLowerCase()}`);
      if (bankDate && (bankDate < cur.date || bankDate > today())) throw new BadRequestException('bankDate must be between the receipt date and today');
      if (dto.status === 'BOUNCED') {
        const later = await tx.payment.findFirst({
          where: { studentId: cur.studentId, yearId: cur.yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' }, receiptNo: { gt: cur.receiptNo } },
        });
        if (later) throw new BadRequestException(`Cancel the later receipt #${later.receiptNo} first`);
      }
      return tx.payment.update({
        where: { id },
        data: dto.status === 'CLEARED'
          ? { clearStatus: 'CLEARED', bankDate }
          : { clearStatus: 'BOUNCED', bouncedAt: new Date(), bankDate, bounceCharge: dto.bounceCharge },
        include: receiptInclude,
      });
    });
    return present(updated);
  }
}
