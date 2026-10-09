import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService, netArrear } from '../billing/billing.service.js';
import { fromPaise, toPaise } from '../billing/bill.js';

class CarryDto {
  @IsInt() schoolId: number;
  @IsInt() fromYearId: number;
  @IsInt() toYearId: number;
  // Preview: same evaluation, nothing written.
  @IsOptional() @IsBoolean() dryRun?: boolean;
  // Only these students (e.g. after fixing one left-behind case).
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsInt({ each: true }) studentIds?: number[];
}

class UpdateArrearDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) amount?: number; // negative = credit
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) waivedAmount?: number;
  @IsString() @MinLength(3) reason: string;
  @IsOptional() @IsInt() fromYearId?: number;
}

type Outcome = 'CARRIED' | 'SKIPPED_EXISTING' | 'SKIPPED_WITHDRAWN' | 'SKIPPED_NOT_ENROLLED_NEXT_YEAR' | 'SKIPPED_ZERO';

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

  private async yearsOrThrow(fromYearId: number, toYearId: number) {
    if (fromYearId === toYearId) throw new BadRequestException('fromYearId and toYearId must differ');
    const [from, to] = await Promise.all([
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: fromYearId } }),
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: toYearId } }),
    ]);
    if (from.startDate >= to.startDate) throw new BadRequestException('toYearId must be a later year than fromYearId');
  }

  // Walks the FROM-year roster (not the to-year's), so nobody's balance can vanish unreported.
  // One outcome per student. Closing balance = what fromYear's bill shows as due today (fine included) minus anything owed back.
  // ponytail: one bill build per candidate; fine for school sizes, batch via buildMany if a school passes ~5k students.
  private async scan(
    schoolId: number, fromYearId: number, toYearId: number,
    o: { studentIds?: number[]; commit?: string; onlyLeftBehind?: boolean },
  ) {
    const prevs = await this.prisma.enrollment.findMany({
      where: { yearId: fromYearId, student: { schoolId, ...(o.studentIds ? { id: { in: o.studentIds } } : {}) } },
      include: { student: true, withdrawal: true, section: { include: { standard: true } } },
    });
    const nexts = await this.prisma.enrollment.findMany({
      where: { yearId: toYearId, studentId: { in: prevs.map((p) => p.studentId) } },
      select: { id: true, studentId: true, arrearCarry: { select: { id: true } } },
    });
    const nextOf = new Map(nexts.map((n) => [n.studentId, n]));
    const rows: { studentId: number; enrollmentId: number | null; admissionNo: string; name: string; className: string; outcome: Outcome; amount: string | null }[] = [];

    for (const prev of prevs.sort((a, b) => a.student.admissionNo.localeCompare(b.student.admissionNo))) {
      const next = nextOf.get(prev.studentId);
      const row = (outcome: Outcome, amount: number | null = null) => rows.push({
        studentId: prev.studentId, enrollmentId: next?.id ?? null, admissionNo: prev.student.admissionNo, name: prev.student.name,
        className: `${prev.section.standard.name} ${prev.section.name}`, outcome, amount: amount === null ? null : fromPaise(amount),
      });
      if (o.onlyLeftBehind && next) continue;
      // An inactive student without a withdrawal row is treated like a withdrawn one (matches the old behaviour of skipping inactive students).
      if (prev.withdrawal || !prev.student.active) { row('SKIPPED_WITHDRAWN'); continue; }
      if (next?.arrearCarry) { row('SKIPPED_EXISTING'); continue; }

      await this.prisma.$transaction(async (tx) => {
        // Same lock payments take, so a receipt can't land between reading the balance and freezing it.
        await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${prev.id} FOR UPDATE`;
        const bill = await this.billing.build(prev.studentId, fromYearId, today(), tx);
        const closing = bill.totals.due - bill.installments.reduce((n, i) => n + i.excess, 0) - bill.arrear.excess;
        if (closing === 0) return void row('SKIPPED_ZERO');
        // Money is owed (or credited) but there is no to-year enrollment to hang it on: report, never drop silently.
        if (!next) return void row('SKIPPED_NOT_ENROLLED_NEXT_YEAR', closing);
        if (o.commit) {
          const { count } = await tx.arrearCarry.createMany({
            data: [{ enrollmentId: next.id, fromYearId, amount: fromPaise(closing), source: 'COMPUTED', createdBy: o.commit }],
            skipDuplicates: true,
          });
          if (!count) return void row('SKIPPED_EXISTING');
        }
        row('CARRIED', closing);
      });
    }
    return rows;
  }

  // Idempotent: students who already have a carry row (computed or manual) are left alone, and a student
  // who was left behind is picked up by the next run once they are enrolled in toYear.
  @Roles('ADMIN')
  @Post('carry')
  async carry(@CurrentUser() u: AuthUser, @Body() dto: CarryDto, @Query('dryRun') dryRunQ?: string) {
    assertSchool(u, dto.schoolId);
    await this.yearsOrThrow(dto.fromYearId, dto.toYearId);
    const dryRun = dto.dryRun ?? dryRunQ === 'true';
    const rows = await this.scan(dto.schoolId, dto.fromYearId, dto.toYearId, { studentIds: dto.studentIds, commit: dryRun ? undefined : u.username });
    const n = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
    const carried = rows.filter((r) => r.outcome === 'CARRIED');
    const left = rows.filter((r) => r.outcome === 'SKIPPED_NOT_ENROLLED_NEXT_YEAR');
    return {
      dryRun,
      carried: carried.filter((r) => Number(r.amount) > 0).length,
      credits: carried.filter((r) => Number(r.amount) < 0).length,
      zero: n('SKIPPED_ZERO'), skippedWithdrawn: n('SKIPPED_WITHDRAWN'), skippedExisting: n('SKIPPED_EXISTING'), skippedNotEnrolled: left.length,
      leftBehindDue: fromPaise(left.reduce((sum, r) => sum + toPaise(r.amount!), 0)),
      rows,
    };
  }

  // Students enrolled in fromYear with a non-zero balance and no toYear enrollment: their money is NOT carried.
  @Get('unpromoted')
  async unpromoted(
    @CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('fromYearId', ParseIntPipe) fromYearId: number, @Query('toYearId', ParseIntPipe) toYearId: number,
  ) {
    assertSchool(u, schoolId);
    await this.yearsOrThrow(fromYearId, toYearId);
    const rows = (await this.scan(schoolId, fromYearId, toYearId, { onlyLeftBehind: true })).filter((r) => r.outcome === 'SKIPPED_NOT_ENROLLED_NEXT_YEAR');
    return rows.map(({ studentId, admissionNo, name, className, amount }) => ({ studentId, admissionNo, name, className, due: amount! }));
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
