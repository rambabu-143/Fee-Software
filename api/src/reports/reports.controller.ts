import { BadRequestException, Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise } from '../billing/bill.js';

const sumOf = (b: { installments: Record<K, number>[] }, k: K) => b.installments.reduce((s, i) => s + i[k], 0);
type K = 'charges' | 'fine' | 'paid' | 'due';

const day = (s: string | undefined, name: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(+d)) throw new BadRequestException(`Bad ${name} date`);
  return d;
};

@Controller('reports')
export class ReportsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  // Every enrolled student's position as of a date. Defaulters = overdue > 0; class summary is a group-by of this.
  @Get('dues')
  async dues(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf') asOf?: string,
    @Query('standardId', new ParseIntPipe({ optional: true })) standardId?: number,
    @Query('sectionId', new ParseIntPipe({ optional: true })) sectionId?: number,
    // Restrict every figure to one installment (e.g. "who hasn't paid the second installment").
    @Query('installmentId', new ParseIntPipe({ optional: true })) installmentId?: number,
  ) {
    assertSchool(u, schoolId);
    const at = day(asOf, 'asOf') ?? new Date();
    // ponytail: computes every bill in memory; fine to a few thousand students, cache or materialise beyond that.
    const bills = await this.billing.buildMany(yearId, at, { schoolId, standardId, sectionId });
    return bills
      .map((b) => ({ ...b, installments: installmentId ? b.installments.filter((i) => i.installmentId === installmentId) : b.installments }))
      .map((b) => ({ ...b, totals: { charges: sumOf(b, 'charges'), fine: sumOf(b, 'fine'), paid: sumOf(b, 'paid'), due: sumOf(b, 'due') } }))
      .filter((b) => !installmentId || b.installments.length > 0)
      .map((b) => ({
        studentId: b.student.id, admissionNo: b.student.admissionNo, name: b.student.name, active: b.student.active,
        className: b.student.className, standardId: b.student.standardId, standard: b.student.standard, sortOrder: b.student.sortOrder,
        charges: fromPaise(b.totals.charges), fine: fromPaise(b.totals.fine), paid: fromPaise(b.totals.paid), due: fromPaise(b.totals.due),
        // Only installments already past their due date.
        overdue: fromPaise(b.installments.filter((i) => i.dueDate <= at).reduce((s, i) => s + i.due, 0)),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.className.localeCompare(b.className) || a.admissionNo.localeCompare(b.admissionNo));
  }

  // Head-count per class & section (empty sections included): enrolled = everyone on the roll for the year,
  // studying = still active, of which new admissions vs continuing, plus those withdrawn.
  @Get('strength')
  async strength(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('yearId', ParseIntPipe) yearId: number) {
    assertSchool(u, schoolId);
    const [sections, enrollments] = await Promise.all([
      this.prisma.section.findMany({ where: { standard: { schoolId } }, include: { standard: true } }),
      this.prisma.enrollment.findMany({
        where: { yearId, student: { schoolId } },
        select: { sectionId: true, isNewAdmission: true, student: { select: { active: true } }, withdrawal: { select: { id: true } } },
      }),
    ]);
    const rows = new Map(sections.map((s) => [s.id, {
      standardId: s.standardId, standard: s.standard.name, sortOrder: s.standard.sortOrder, sectionId: s.id, section: s.name,
      enrolled: 0, studying: 0, newAdmissions: 0, continuing: 0, withdrawn: 0,
    }]));
    for (const e of enrollments) {
      const r = rows.get(e.sectionId)!;
      r.enrolled++;
      if (e.withdrawal) r.withdrawn++;
      if (e.student.active) {
        r.studying++;
        if (e.isNewAdmission) r.newAdmissions++;
        else r.continuing++;
      }
    }
    return [...rows.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.section.localeCompare(b.section));
  }

  // Bus lists: for every route, each stop in order with the students boarding (pickup) and alighting (drop) there.
  @Get('transport')
  async transport(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('yearId', ParseIntPipe) yearId: number) {
    assertSchool(u, schoolId);
    const [stops, assignments] = await Promise.all([
      this.prisma.stop.findMany({ where: { route: { schoolId } }, include: { route: true, slab: true }, orderBy: [{ route: { name: 'asc' } }, { sequence: 'asc' }] }),
      this.prisma.transportAssignment.findMany({
        where: { enrollment: { yearId, student: { schoolId, active: true } } },
        select: { pickupStopId: true, dropStopId: true, enrollment: { select: { student: { select: { id: true, admissionNo: true, name: true } }, section: { include: { standard: true } } } } },
      }),
    ]);
    const who = (a: (typeof assignments)[number]) => ({ ...a.enrollment.student, className: `${a.enrollment.section.standard.name} ${a.enrollment.section.name}` });
    const routes = new Map<number, { routeId: number; route: string; stops: unknown[]; pickups: number; drops: number }>();
    for (const s of stops) {
      const r = routes.get(s.routeId) ?? { routeId: s.routeId, route: s.route.name, stops: [], pickups: 0, drops: 0 };
      const pickup = assignments.filter((a) => a.pickupStopId === s.id).map(who);
      const drop = assignments.filter((a) => a.dropStopId === s.id).map(who);
      r.pickups += pickup.length;
      r.drops += drop.length;
      r.stops.push({ stopId: s.id, sequence: s.sequence, name: s.name, slab: s.slab.name, pickupTime: s.pickupTime, dropTime: s.dropTime, pickup, drop });
      routes.set(s.routeId, r);
    }
    return [...routes.values()];
  }

  // Valid (non-cancelled) receipts per day and payment mode.
  @Get('collection')
  async collection(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    assertSchool(u, schoolId);
    const f = day(from, 'from'), t = day(to, 'to');
    const rows = await this.prisma.payment.groupBy({
      by: ['date', 'mode'],
      where: { schoolId, yearId, cancelledAt: null, ...(f || t ? { date: { ...(f && { gte: f }), ...(t && { lte: t }) } } : {}) },
      _sum: { amount: true },
      _count: true,
      orderBy: [{ date: 'asc' }, { mode: 'asc' }],
    });
    return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), mode: r.mode, receipts: r._count, amount: r._sum.amount?.toFixed(2) ?? '0.00' }));
  }
}
