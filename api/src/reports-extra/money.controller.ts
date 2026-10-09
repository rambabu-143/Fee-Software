import { BadRequestException, Controller, Get, ParseDatePipe, ParseIntPipe, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import { respond } from './csv.js';
import { classOf, concessionByHead, isTransportLine, live, netByBucket, paidShares, rollWhere, type Share } from './shared.js';

const opt = new ParseIntPipe({ optional: true });
const optDate = new ParseDatePipe({ optional: true });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const money = (m: Map<string, number>) => Object.fromEntries([...m].map(([k, v]) => [k, fromPaise(v)]));
const inc = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

@Roles('ADMIN', 'ACCOUNTANT')
@Controller('reports')
export class MoneyReportsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  // Per class & section: students, charges/concession/fine/paid/due and charges per fee head.
  // paid/due come from the bill engine, i.e. the same figures as /reports/dues.
  @Get('classwise')
  async classwise(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf', optDate) asOf?: Date,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const [bills, enrollments, sections] = await Promise.all([
      this.billing.buildMany(yearId, asOf ?? new Date(), { schoolId, standardId, sectionId }),
      this.prisma.enrollment.findMany({
        where: { yearId, student: { schoolId }, ...(standardId || sectionId ? { section: { ...(standardId && { standardId }), ...(sectionId && { id: sectionId }) } } : {}) },
        select: { id: true, sectionId: true, isNewAdmission: true, student: { select: { active: true } }, withdrawal: { select: { id: true } } },
      }),
      this.prisma.section.findMany({ where: { standard: { schoolId }, ...(standardId && { standardId }), ...(sectionId && { id: sectionId }) }, include: { standard: true } }),
    ]);
    const meta = new Map(enrollments.map((e) => [e.id, e]));
    const rows = new Map(sections.map((s) => [s.id, {
      sortOrder: s.standard.sortOrder, standard: s.standard.name, section: s.name,
      students: 0, newAdmissions: 0, continuing: 0, withdrawn: 0,
      charges: 0, concession: 0, fine: 0, paid: 0, due: 0, heads: new Map<string, number>(),
    }]));
    for (const e of enrollments) {
      const r = rows.get(e.sectionId)!;
      r.students++;
      if (e.withdrawal) r.withdrawn++;
      else if (e.isNewAdmission) r.newAdmissions++;
      else r.continuing++;
    }
    for (const b of bills) {
      const r = rows.get(meta.get(b.student.enrollmentId)!.sectionId)!;
      r.charges += b.totals.charges; r.fine += b.totals.fine; r.paid += b.totals.paid; r.due += b.totals.due;
      r.concession += sum([...concessionByHead(b).values()]);
      for (const i of b.installments) for (const [k, v] of netByBucket(i.lines)) inc(r.heads, k, v);
    }
    const out = [...rows.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.section.localeCompare(b.section))
      .map(({ sortOrder: _s, heads, charges, concession, fine, paid, due, ...r }) => ({
        ...r, charges: fromPaise(charges), concession: fromPaise(concession), fine: fromPaise(fine), paid: fromPaise(paid), due: fromPaise(due), ...money(heads),
      }));
    return respond(out, format, 'classwise');
  }

  @Get('studentwise')
  async studentwise(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf', optDate) asOf?: Date,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const bills = await this.billing.buildMany(yearId, asOf ?? new Date(), { schoolId, standardId, sectionId });
    const out = bills
      .sort((a, b) => a.student.sortOrder - b.student.sortOrder || a.student.className.localeCompare(b.student.className) || a.student.admissionNo.localeCompare(b.student.admissionNo))
      .map((b) => {
        const heads = new Map<string, number>();
        for (const i of b.installments) for (const [k, v] of netByBucket(i.lines)) inc(heads, k, v);
        return {
          admissionNo: b.student.admissionNo, name: b.student.name, className: b.student.className, active: b.student.active ? 'YES' : 'NO',
          charges: fromPaise(b.totals.charges), concession: fromPaise(sum([...concessionByHead(b).values()])),
          fine: fromPaise(b.totals.fine), paid: fromPaise(b.totals.paid), due: fromPaise(b.totals.due), ...money(heads),
        };
      });
    return respond(out, format, 'studentwise');
  }

  private group(shares: Share[], key: (s: Share) => string) {
    const m = new Map<string, Map<string, number>>();
    for (const s of shares) {
      const g = m.get(key(s)) ?? new Map<string, number>();
      inc(g, s.bucket, s.paise);
      m.set(key(s), g);
    }
    return m;
  }

  // What was collected, split into fee heads (+ Fine, Arrear, Bounce charge). groupBy=class (default) | student.
  // Withdrawn students' receipts are included: money collected is money collected.
  @Get('bifurcation')
  async bifurcation(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('groupBy') groupBy = 'class',
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('admissionNo') admissionNo?: string,
    @Query('from', optDate) from?: Date,
    @Query('to', optDate) to?: Date,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    if (groupBy !== 'class' && groupBy !== 'student') throw new BadRequestException('groupBy must be class or student');
    const { bills, shares } = await paidShares(this.prisma, this.billing, { schoolId, yearId, standardId, sectionId, from, to });
    const who = new Map(bills.map((b) => [b.student.id, b.student]));
    const kept = shares.filter((s) => !admissionNo || who.get(s.studentId)?.admissionNo === admissionNo);
    const grouped = this.group(kept, (s) => (groupBy === 'class' ? who.get(s.studentId)!.className : String(s.studentId)));
    const out = [...grouped.entries()].map(([k, heads]) => {
      const st = groupBy === 'student' ? who.get(Number(k))! : undefined;
      return {
        ...(st ? { admissionNo: st.admissionNo, name: st.name, className: st.className } : { className: k }),
        ...money(heads), total: fromPaise(sum([...heads.values()])),
      };
    }).sort((a, b) => (a.className as string).localeCompare(b.className as string) || String((a as { admissionNo?: string }).admissionNo ?? '').localeCompare(String((b as { admissionNo?: string }).admissionNo ?? '')));
    return respond(out, format, 'bifurcation');
  }

  // Transport charged vs collected, per class or student. Stop-based transport only.
  // staff=true is legacy's "STAFF" view: only students who have a guardian flagged isStaff.
  @Get('transport-bifurcation')
  async transportBifurcation(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('groupBy') groupBy = 'class',
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('staff') staff?: string,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    if (groupBy !== 'class' && groupBy !== 'student') throw new BadRequestException('groupBy must be class or student');
    if (staff !== undefined && !['true', 'false', '1', '0'].includes(staff)) throw new BadRequestException('staff must be true or false');
    const all = await paidShares(this.prisma, this.billing, { schoolId, yearId, standardId, sectionId });
    let { bills, shares } = all;
    if (staff === 'true' || staff === '1') {
      const staffIds = new Set((await this.prisma.guardian.findMany({ where: { isStaff: true, student: { schoolId } }, select: { studentId: true } })).map((g) => g.studentId));
      bills = bills.filter((b) => staffIds.has(b.student.id));
      shares = shares.filter((x) => staffIds.has(x.studentId));
    }
    const key = (b: (typeof bills)[number]['student']) => (groupBy === 'class' ? b.className : b.admissionNo);
    const rows = new Map<string, { admissionNo?: string; name?: string; className: string; charged: number; paid: number }>();
    const row = (b: (typeof bills)[number]['student']) => {
      const r = rows.get(key(b)) ?? { ...(groupBy === 'student' ? { admissionNo: b.admissionNo, name: b.name } : {}), className: b.className, charged: 0, paid: 0 };
      rows.set(key(b), r);
      return r;
    };
    for (const b of bills) {
      const charged = sum(b.installments.flatMap((i) => i.lines.filter((l) => isTransportLine(l.feeHeadId)).map((l) => l.amount)));
      if (charged) row(b.student).charged += charged;
    }
    const byId = new Map(bills.map((b) => [b.student.id, b.student]));
    for (const s of shares) if (s.bucket === 'Transport') row(byId.get(s.studentId)!).paid += s.paise;
    const out = [...rows.values()]
      .sort((a, b) => a.className.localeCompare(b.className) || (a.admissionNo ?? '').localeCompare(b.admissionNo ?? ''))
      .map((r) => ({ ...r, charged: fromPaise(r.charged), paid: fromPaise(r.paid), balance: fromPaise(r.charged - r.paid) }));
    return respond(out, format, 'transport-bifurcation');
  }

  // Class XII leavers: Earmarked Levies XI / XII received (exact per-head receipts, live ones only) against the
  // refund vouchers already paid out. A voucher's remarks mention "XI" or "XII" to say which levy it returns;
  // with neither it counts against XII, as legacy only ever refunded XII. pending=1 hides fully refunded students
  // (legacy dropped anyone already refunded). Legacy's "XI shows the XII figure when XI is zero" quirk is not carried over.
  // ponytail: the XII class is found by name (XII / 12 / Class XII); a school using another name gets an empty report.
  @Get('alumni')
  async alumni(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('pending') pending?: string,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const standards = (await this.prisma.standard.findMany({ where: { schoolId } })).filter((x) => /^(class\s*)?(xii|12)$/i.test(x.name.trim()));
    const std = standards.sort((a, b) => b.sortOrder - a.sortOrder)[0];
    if (!std) return respond([], format, 'alumni');
    const [{ bills, shares }, enrollments] = await Promise.all([
      paidShares(this.prisma, this.billing, { schoolId, yearId, standardId: std.id, sectionId }),
      this.prisma.enrollment.findMany({
        where: rollWhere(schoolId, yearId, std.id, sectionId),
        select: { id: true, studentId: true, section: { select: { name: true } } },
      }),
    ]);
    const vouchers = await this.prisma.voucher.findMany({ where: { schoolId, yearId, cancelledAt: null, enrollmentId: { in: enrollments.map((e) => e.id) } } });
    const levy = (bucket: string) => (/earmarked\s+levies?\s+xii\b/i.test(bucket) ? 'XII' : /earmarked\s+levies?\s+xi\b/i.test(bucket) ? 'XI' : null);
    const refundOf = (remarks: string | null) => (/\bxii\b/i.test(remarks ?? '') ? 'XII' : /\bxi\b/i.test(remarks ?? '') ? 'XI' : 'XII');
    const acc = new Map(enrollments.map((e) => [e.studentId, { enr: e, XI: 0, XII: 0, rXI: 0, rXII: 0 }]));
    for (const x of shares) {
      const l = levy(x.bucket);
      if (l) acc.get(x.studentId)![l] += x.paise;
    }
    const studentOf = new Map(enrollments.map((e) => [e.id, e.studentId]));
    for (const v of vouchers) {
      const a = acc.get(studentOf.get(v.enrollmentId)!)!;
      a[refundOf(v.remarks) === 'XI' ? 'rXI' : 'rXII'] += toPaise(v.amount.toFixed(2));
    }
    const who = new Map(bills.map((b) => [b.student.id, b.student]));
    const t = { XI: 0, rXI: 0, XII: 0, rXII: 0 };
    let n = 0;
    const rows: Record<string, unknown>[] = [];
    for (const [studentId, a] of [...acc].sort((x, y) => (who.get(x[0])?.admissionNo ?? '').localeCompare(who.get(y[0])?.admissionNo ?? ''))) {
      const st = who.get(studentId);
      if (!st) continue; // not billed (e.g. no fee structure): nothing to report
      const paid = a.XI + a.XII, refunded = a.rXI + a.rXII;
      const status = !paid && !refunded ? 'NO_LEVIES' : !refunded ? 'NOT_REFUNDED' : refunded >= paid ? 'REFUNDED' : 'PARTIAL';
      if ((pending === 'true' || pending === '1') && (status === 'REFUNDED' || status === 'NO_LEVIES')) continue;
      t.XI += a.XI; t.rXI += a.rXI; t.XII += a.XII; t.rXII += a.rXII;
      rows.push({
        slNo: ++n, admissionNo: st.admissionNo, name: st.name, section: a.enr.section.name,
        leviesXI: fromPaise(a.XI), refundXI: fromPaise(a.rXI), leviesXII: fromPaise(a.XII), refundXII: fromPaise(a.rXII),
        totalLevies: fromPaise(paid), totalRefunded: fromPaise(refunded), balance: fromPaise(paid - refunded), status,
      });
    }
    if (rows.length) {
      rows.push({
        slNo: '', admissionNo: '', name: 'Total', section: '', leviesXI: fromPaise(t.XI), refundXI: fromPaise(t.rXI),
        leviesXII: fromPaise(t.XII), refundXII: fromPaise(t.rXII), totalLevies: fromPaise(t.XI + t.XII),
        totalRefunded: fromPaise(t.rXI + t.rXII), balance: fromPaise(t.XI + t.XII - t.rXI - t.rXII), status: '',
      });
    }
    return respond(rows, format, 'alumni');
  }

  // Per stop: students using it and the fare they owe (each leg is half the slab's yearly fare, as in billing).
  @Get('routes')
  async routes(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const [stops, assignments, fares] = await Promise.all([
      this.prisma.stop.findMany({ where: { route: { schoolId } }, include: { route: true, slab: true }, orderBy: [{ route: { name: 'asc' } }, { sequence: 'asc' }] }),
      this.prisma.transportAssignment.findMany({ where: { enrollment: rollWhere(schoolId, yearId) }, select: { pickupStopId: true, dropStopId: true } }),
      this.prisma.facilityFeeStructure.groupBy({ by: ['facilityId'], where: { yearId, facility: { schoolId } }, _sum: { amount: true } }),
    ]);
    const fare = new Map(fares.map((f) => [f.facilityId, toPaise(f._sum.amount?.toFixed(2) ?? '0')]));
    const rows = stops.map((s) => {
      const pickups = assignments.filter((a) => a.pickupStopId === s.id).length;
      const drops = assignments.filter((a) => a.dropStopId === s.id).length;
      const f = fare.get(s.slabId) ?? 0;
      const half = Math.floor(f / 2);
      return {
        route: s.route.name, slab: s.slab.name, sequence: s.sequence, stop: s.name, pickupTime: s.pickupTime ?? '', dropTime: s.dropTime ?? '',
        pickups, drops, amount: fromPaise(pickups * half + drops * (f - half)),
      };
    });
    return respond(rows, format, 'routes');
  }

  // Concessions on the roll. Default = one row per concession; summary=1 = class x category matrix.
  // concessionAmount is the real discount on the year's bill (percent/cap/withdrawal already applied).
  @Get('concessions')
  async concessions(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('category') category?: string,
    @Query('summary') summary?: string,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const [concessions, bills] = await Promise.all([
      this.prisma.concession.findMany({
        where: { enrollment: rollWhere(schoolId, yearId, standardId, sectionId), ...(category ? { category } : {}) },
        include: { feeHead: true, enrollment: { include: { student: true, section: { include: { standard: true } } } } },
        orderBy: [{ enrollment: { student: { admissionNo: 'asc' } } }, { feeHeadId: 'asc' }],
      }),
      this.billing.buildMany(yearId, new Date(), { schoolId, standardId, sectionId }),
    ]);
    const given = new Map(bills.map((b) => [b.student.enrollmentId, concessionByHead(b)]));
    const rows = concessions.map((c) => ({
      admissionNo: c.enrollment.student.admissionNo, name: c.enrollment.student.name, className: c.enrollment.section.standard.name,
      section: c.enrollment.section.name, category: c.category ?? 'UNCATEGORISED', feeHead: c.feeHead.name,
      percent: c.percent?.toFixed(2) ?? '', amountPerInstallment: c.amount?.toFixed(2) ?? '', reason: c.reason,
      concessionAmount: fromPaise(given.get(c.enrollmentId)?.get(c.feeHeadId) ?? 0),
      _paise: given.get(c.enrollmentId)?.get(c.feeHeadId) ?? 0, _class: classOf(c.enrollment),
    }));
    if (!summary || summary === '0') return respond(rows.map(({ _paise, _class, ...r }) => r), format, 'concessions');
    const matrix = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const m = matrix.get(r._class) ?? new Map<string, number>();
      inc(m, r.category, r._paise);
      matrix.set(r._class, m);
    }
    const cats = [...new Set(rows.map((r) => r.category))].sort();
    const out = [...matrix.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([className, m]) => ({
      className, ...Object.fromEntries(cats.map((c) => [c, fromPaise(m.get(c) ?? 0)])), total: fromPaise(sum([...m.values()])),
    }));
    return respond(out, format, 'concessions-summary');
  }

  // Collection by payment mode, or split into fee heads (+ Fine, Arrear, Bounce charge), for a date range.
  @Get('payments-summary')
  async paymentsSummary(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('groupBy') groupBy = 'mode',
    @Query('from', optDate) from?: Date,
    @Query('to', optDate) to?: Date,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    if (groupBy === 'mode') {
      const rows = await this.prisma.payment.groupBy({
        by: ['mode'], _sum: { amount: true }, _count: true, orderBy: { mode: 'asc' },
        where: { schoolId, yearId, ...live, ...(from || to ? { date: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}) },
      });
      return respond(rows.map((r) => ({ mode: r.mode, receipts: r._count, amount: r._sum.amount?.toFixed(2) ?? '0.00' })), format, 'payments-by-mode');
    }
    if (groupBy !== 'head') throw new BadRequestException('groupBy must be mode or head');
    const { shares } = await paidShares(this.prisma, this.billing, { schoolId, yearId, from, to });
    const heads = new Map<string, number>();
    for (const s of shares) inc(heads, s.bucket, s.paise);
    const rows = [...heads].sort(([a], [b]) => a.localeCompare(b)).map(([head, p]) => ({ head, amount: fromPaise(p) }));
    return respond(rows, format, 'payments-by-head');
  }
}
