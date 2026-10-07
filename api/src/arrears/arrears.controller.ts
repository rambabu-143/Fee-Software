import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService, netArrear } from '../billing/billing.service.js';
import { fromPaise, toPaise } from '../billing/bill.js';

class CarryDto {
  @IsInt() schoolId: number;
  @IsInt() fromYearId: number;
  @IsInt() toYearId: number;
}

class UpdateArrearDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) amount?: number; // negative = credit
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) waivedAmount?: number;
  @IsString() @MinLength(3) reason: string;
  @IsOptional() @IsInt() fromYearId?: number;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));

// Previous year's closing balance carried into this year's bill (see BillingService / allocate()).
@Controller('arrears')
export class ArrearsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('yearId', ParseIntPipe) yearId: number) {
    assertSchool(u, schoolId);
    const bills = await this.billing.buildMany(yearId, today(), { schoolId });
    const carries = await this.prisma.arrearCarry.findMany({ where: { enrollment: { yearId, student: { schoolId } } }, include: { fromYear: true } });
    const byEnrollment = new Map(carries.map((c) => [c.enrollmentId, c]));
    return bills.flatMap((b) => {
      const c = byEnrollment.get(b.student.enrollmentId);
      if (!c) return [];
      return [{
        enrollmentId: c.enrollmentId, studentId: b.student.id, admissionNo: b.student.admissionNo, name: b.student.name, className: b.student.className,
        fromYear: c.fromYear.label, amount: c.amount.toFixed(2), waivedAmount: c.waivedAmount.toFixed(2), waiveReason: c.waiveReason, source: c.source,
        net: fromPaise(netArrear(c)), paid: fromPaise(b.arrear.paid), due: fromPaise(b.arrear.due), credit: fromPaise(b.arrear.excess),
      }];
    }).sort((a, b) => a.admissionNo.localeCompare(b.admissionNo));
  }

  // Idempotent: students who already have a carry row (computed or manual) are left alone.
  // Closing balance = what fromYear's bill shows as due today (fine included) minus anything owed back.
  @Roles('ADMIN')
  @Post('carry')
  async carry(@CurrentUser() u: AuthUser, @Body() dto: CarryDto) {
    assertSchool(u, dto.schoolId);
    if (dto.fromYearId === dto.toYearId) throw new BadRequestException('fromYearId and toYearId must differ');
    const [from, to] = await Promise.all([
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: dto.fromYearId } }),
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: dto.toYearId } }),
    ]);
    if (from.startDate >= to.startDate) throw new BadRequestException('toYearId must be a later year than fromYearId');

    const targets = await this.prisma.enrollment.findMany({
      where: {
        yearId: dto.toYearId, student: { schoolId: dto.schoolId, active: true },
        arrearCarry: null, withdrawal: null,
      },
      select: { id: true, studentId: true },
    });
    const result = { carried: 0, credits: 0, zero: 0, skippedWithdrawn: 0, skippedNotEnrolled: 0, skippedExisting: 0 };
    for (const t of targets) {
      await this.prisma.$transaction(async (tx) => {
        const prev = await tx.enrollment.findUnique({
          where: { studentId_yearId: { studentId: t.studentId, yearId: dto.fromYearId } }, include: { withdrawal: true },
        });
        if (!prev) return void result.skippedNotEnrolled++;
        if (prev.withdrawal) return void result.skippedWithdrawn++;
        // Same lock payments take, so a receipt can't land between reading the balance and freezing it.
        await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${prev.id} FOR UPDATE`;
        const bill = await this.billing.build(t.studentId, dto.fromYearId, today(), tx);
        const closing = bill.totals.due - bill.installments.reduce((s, i) => s + i.excess, 0) - bill.arrear.excess;
        if (closing === 0) return void result.zero++;
        const { count } = await tx.arrearCarry.createMany({
          data: [{ enrollmentId: t.id, fromYearId: dto.fromYearId, amount: fromPaise(closing), source: 'COMPUTED', createdBy: u.username }],
          skipDuplicates: true,
        });
        if (!count) return void result.skippedExisting++;
        if (closing > 0) result.carried++;
        else result.credits++;
      });
    }
    return result;
  }

  // Manual set / waive. Never lets the net arrear fall below what has already been paid against it.
  @Roles('ADMIN')
  @Patch(':enrollmentId')
  async update(@CurrentUser() u: AuthUser, @Param('enrollmentId', ParseIntPipe) enrollmentId: number, @Body() dto: UpdateArrearDto) {
    if (dto.amount === undefined && dto.waivedAmount === undefined) throw new BadRequestException('Give amount and/or waivedAmount');
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId }, include: { student: true, year: true, arrearCarry: true } });
      assertSchool(u, e.student.schoolId);
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${e.id} FOR UPDATE`;

      const amount = dto.amount ?? (e.arrearCarry ? Number(e.arrearCarry.amount) : undefined);
      if (amount === undefined) throw new BadRequestException('amount is required when no arrear exists yet');
      const waived = dto.waivedAmount ?? (e.arrearCarry ? Number(e.arrearCarry.waivedAmount) : 0);
      if (waived > 0 && amount <= 0) throw new BadRequestException('Only a positive arrear can be waived');
      if (toPaise(String(waived)) > toPaise(String(Math.max(0, amount)))) throw new BadRequestException('Waiver is more than the arrear');

      const paid = await tx.paymentAllocation.aggregate({
        _sum: { arrear: true },
        where: { payment: { studentId: e.studentId, yearId: e.yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } } },
      });
      const net = amount > 0 ? toPaise(String(amount)) - toPaise(String(waived)) : toPaise(String(amount));
      if (Math.max(0, net) < toPaise((paid._sum.arrear ?? 0).toString())) {
        throw new BadRequestException(`₹${paid._sum.arrear?.toFixed(2)} is already paid against this arrear; cancel those receipts first`);
      }

      let fromYearId = dto.fromYearId ?? e.arrearCarry?.fromYearId;
      if (!fromYearId) {
        const prev = await tx.academicYear.findFirst({ where: { startDate: { lt: e.year.startDate } }, orderBy: { startDate: 'desc' } });
        if (!prev) throw new BadRequestException('No earlier year to carry from');
        fromYearId = prev.id;
      }
      const from = await tx.academicYear.findUniqueOrThrow({ where: { id: fromYearId } });
      if (from.startDate >= e.year.startDate) throw new BadRequestException('fromYearId must be earlier than the enrollment year');
      const data = { amount, waivedAmount: waived, waiveReason: dto.reason, source: 'MANUAL', fromYearId };
      const row = await tx.arrearCarry.upsert({
        where: { enrollmentId }, update: data, create: { ...data, enrollmentId, createdBy: u.username },
      });
      return { ...row, amount: row.amount.toFixed(2), waivedAmount: row.waivedAmount.toFixed(2), net: fromPaise(net) };
    });
  }
}
