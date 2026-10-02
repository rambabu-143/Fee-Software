import {
  BadRequestException, Body, Controller, Get, Header, Param, ParseDatePipe, ParseIntPipe, Post, Query, StreamableFile,
} from '@nestjs/common';
import {
  IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateIf,
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
const present = (p: ReceiptRow) => ({
  ...p,
  amount: p.amount.toFixed(2),
  allocations: p.allocations
    .sort((a, b) => a.installment.number - b.installment.number)
    .map((a) => ({ installment: a.installment.label, charges: a.charges.toFixed(2), fine: a.fine.toFixed(2) })),
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
      take: 1000, // ponytail: cap instead of pagination
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

    const payment = await this.prisma.$transaction(async (tx) => {
      const bill = await this.billing.build(dto.studentId, dto.yearId, date, tx);
      assertSchool(u, bill.student.schoolId);

      // Lock this student's enrollment so two counters can't collect against the same balance.
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${bill.student.enrollmentId} FOR UPDATE`;
      const fresh = await this.billing.build(dto.studentId, dto.yearId, date, tx);

      // Backdating before an existing receipt would re-split money already allocated.
      const last = await tx.payment.findFirst({
        where: { studentId: dto.studentId, yearId: dto.yearId, cancelledAt: null, date: { gt: date } },
      });
      if (last) throw new BadRequestException('A later receipt already exists for this student');

      let split;
      try {
        split = allocate(fresh.installments, amount);
      } catch (e) {
        if (e instanceof RangeError) throw new BadRequestException(`${e.message} (₹${fromPaise(fresh.totals.due)})`);
        throw e;
      }

      const { last: receiptNo } = await tx.receiptCounter.upsert({
        where: { schoolId_yearId: { schoolId: bill.student.schoolId, yearId: dto.yearId } },
        create: { schoolId: bill.student.schoolId, yearId: dto.yearId, last: 1 },
        update: { last: { increment: 1 } },
      });

      return tx.payment.create({
        data: {
          schoolId: bill.student.schoolId, yearId: dto.yearId, studentId: dto.studentId, receiptNo, date,
          mode: dto.mode, reference: dto.mode === 'CASH' ? null : dto.reference, remarks: dto.remarks,
          amount: fromPaise(amount), createdBy: u.username,
          allocations: {
            create: split.map((a) => ({ installmentId: a.installmentId, charges: fromPaise(a.charges), fine: fromPaise(a.fine) })),
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
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id } });
    assertSchool(u, p.schoolId);
    if (p.cancelledAt) throw new BadRequestException('Receipt is already cancelled');
    const later = await this.prisma.payment.findFirst({
      where: { studentId: p.studentId, yearId: p.yearId, cancelledAt: null, receiptNo: { gt: p.receiptNo } },
    });
    if (later) throw new BadRequestException(`Cancel the later receipt #${later.receiptNo} first`);
    const updated = await this.prisma.payment.update({
      where: { id },
      data: { cancelledAt: new Date(), cancelledBy: u.username, cancelReason: dto.reason },
      include: receiptInclude,
    });
    return present(updated);
  }
}
