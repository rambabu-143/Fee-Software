import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calculateBill, fromPaise, toPaise } from './bill.js';

type Db = Prisma.TransactionClient;

// Paise owed (positive) or credited (negative) after any waiver; a waiver only trims a positive arrear.
export const netArrear = (c: { amount: Prisma.Decimal; waivedAmount: Prisma.Decimal }) => {
  const amount = toPaise(c.amount.toFixed(2));
  return amount > 0 ? Math.max(0, amount - toPaise(c.waivedAmount.toFixed(2))) : amount;
};

// Loads everything a student's bill needs and runs the pure engine.
@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

  async build(studentId: number, yearId: number, asOf: Date, db: Db = this.prisma) {
    const [bill] = await this.buildMany(yearId, asOf, { studentId }, db);
    if (!bill) throw new BadRequestException('Student is not enrolled in this year');
    return bill;
  }

  // Bills for many students in a handful of queries (reports). Callers filter to one school.
  async buildMany(
    yearId: number,
    asOf: Date,
    filter: { studentId?: number; schoolId?: number; standardId?: number; sectionId?: number },
    db: Db = this.prisma,
  ) {
    const enrollments = await db.enrollment.findMany({
      where: {
        yearId,
        ...(filter.studentId ? { studentId: filter.studentId } : {}),
        ...(filter.schoolId ? { student: { schoolId: filter.schoolId } } : {}),
        ...(filter.standardId || filter.sectionId
          ? { section: { ...(filter.standardId ? { standardId: filter.standardId } : {}), ...(filter.sectionId ? { id: filter.sectionId } : {}) } }
          : {}),
      },
      include: {
        student: true,
        section: { include: { standard: true } },
        optionalHeads: { select: { id: true } },
        concessions: true,
        fineAdjustments: true,
        withdrawal: true,
        arrearCarry: true,
        facilityAssignments: { include: { facility: true } },
        transport: { include: { pickupStop: { include: { route: true } }, dropStop: { include: { route: true } } } },
      },
    });
    if (!enrollments.length) return [];
    const schoolId = enrollments[0].student.schoolId;
    const studentIds = enrollments.map((e) => e.studentId);
    const facilityIds = enrollments.flatMap((e) => [
      ...e.facilityAssignments.map((a) => a.facilityId),
      ...[e.transport?.pickupStop?.slabId, e.transport?.dropStop?.slabId].filter((x): x is number => x != null),
    ]);

    const [installments, structure, allocations, facilityStructure, bounced, transportDeposits] = await Promise.all([
      db.installment.findMany({ where: { schoolId, yearId } }),
      db.feeStructure.findMany({
        where: { yearId, standardId: { in: [...new Set(enrollments.map((e) => e.section.standardId))] } },
        include: { feeHead: true },
      }),
      db.paymentAllocation.findMany({
        where: { payment: { studentId: { in: studentIds }, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } } },
        include: { payment: { select: { date: true, studentId: true } } },
      }),
      facilityIds.length
        ? db.facilityFeeStructure.findMany({ where: { yearId, facilityId: { in: facilityIds } } })
        : [],
      // A bounce charge is owed from the moment the cheque bounces (a bounced receipt can't be cancelled or un-bounced).
      db.payment.findMany({
        where: { studentId: { in: studentIds }, yearId, clearStatus: 'BOUNCED', cancelledAt: null, bounceCharge: { gt: 0 } },
        select: { studentId: true, receiptNo: true, bounceCharge: true },
        orderBy: { receiptNo: 'asc' },
      }),
      db.deposit.findMany({ where: { studentId: { in: studentIds }, kind: 'TRANSPORT' }, select: { studentId: true } }),
    ]);
    const inst = installments.map((i) => ({ ...i, finePerDay: toPaise(i.finePerDay.toFixed(2)) }));

    return enrollments.map((e) => {
      const items = bounced
        .filter((b) => b.studentId === e.studentId)
        .map((b) => ({ receiptNo: b.receiptNo, amount: toPaise(b.bounceCharge!.toFixed(2)) }));
      const student = {
        id: e.student.id, schoolId, admissionNo: e.student.admissionNo, name: e.student.name, active: e.student.active,
        className: `${e.section.standard.name} ${e.section.name}`, enrollmentId: e.id,
        standardId: e.section.standardId, standard: e.section.standard.name, sortOrder: e.section.standard.sortOrder,
      };
      const calc = calculateBill({
        installments: inst,
        structure: structure
          .filter((s) => s.standardId === e.section.standardId)
          .map((s) => ({
            feeHeadId: s.feeHeadId, name: s.feeHead.name, type: s.feeHead.type,
            installmentId: s.installmentId, amount: toPaise(s.amount.toFixed(2)),
          })),
        isNewAdmission: e.isNewAdmission,
        optionalHeadIds: e.optionalHeads.map((h) => h.id),
        payments: allocations
          .filter((a) => a.payment.studentId === e.studentId)
          .map((a) => ({
            installmentId: a.installmentId, date: a.payment.date,
            charges: toPaise(a.charges.toFixed(2)), fine: toPaise(a.fine.toFixed(2)), arrear: toPaise(a.arrear.toFixed(2)),
            bounce: toPaise(a.bounce.toFixed(2)),
          })),
        // A waiver only trims a positive arrear; a credit is left as is.
        arrear: e.arrearCarry ? netArrear(e.arrearCarry) : 0,
        bounceCharges: items.reduce((n, i) => n + i.amount, 0),
        onTransport: !!(e.transport?.pickupStop || e.transport?.dropStop) || e.facilityAssignments.some((a) => a.facility.kind === 'TRANSPORT'),
        holdsTransportDeposit: transportDeposits.some((d) => d.studentId === e.studentId),
        concessions: e.concessions.map((c) => ({
          feeHeadId: c.feeHeadId, reason: c.reason,
          percent: c.percent === null ? null : Number(c.percent), amount: c.amount === null ? null : toPaise(c.amount.toFixed(2)),
        })),
        withdrawnOn: e.withdrawal?.date ?? null,
        fineOverrides: e.fineAdjustments.map((f) => ({ installmentId: f.installmentId, amount: toPaise(f.amount.toFixed(2)) })),
        facilityLines: [
          ...e.facilityAssignments.flatMap((a) =>
            facilityStructure
              .filter((s) => s.facilityId === a.facilityId)
              .map((s) => ({ facilityId: a.facilityId, name: a.facility.name, installmentId: s.installmentId, amount: toPaise(s.amount.toFixed(2)) })),
          ),
          // Stop-based transport: each leg is half its slab's fare. Floor on pickup, ceil on drop, so one
          // slab used both ways sums to exactly the fare. ids sit far above real facility ids to stay unique.
          ...(['pickup', 'drop'] as const).flatMap((leg, n) => {
            const stop = leg === 'pickup' ? e.transport?.pickupStop : e.transport?.dropStop;
            if (!stop) return [];
            return facilityStructure
              .filter((s) => s.facilityId === stop.slabId)
              .map((s) => {
                const fare = toPaise(s.amount.toFixed(2));
                return {
                  facilityId: 1_000_000 + stop.id * 2 + n,
                  name: `Transport ${leg} · ${stop.name} (${stop.route.name})`,
                  installmentId: s.installmentId,
                  amount: leg === 'pickup' ? Math.floor(fare / 2) : fare - Math.floor(fare / 2),
                };
              });
          }),
        ],
        asOf,
      });
      return { student, ...calc, bounce: { ...calc.bounce, items } };
    });
  }

  // Paise -> "1234.50" strings for the API.
  static present(bill: Awaited<ReturnType<BillingService['build']>>) {
    const m = (p: number) => fromPaise(p);
    const { id, admissionNo, name, className } = bill.student;
    const student = { id, admissionNo, name, className };
    return {
      student,
      installments: bill.installments.map((i) => ({
        installmentId: i.installmentId, number: i.number, label: i.label, dueDate: i.dueDate, fineDays: i.fineDays, fineOverridden: i.fineOverridden,
        lines: i.lines.map((l) => ({ ...l, amount: m(l.amount) })),
        charges: m(i.charges), fine: m(i.fine), paid: m(i.paid), due: m(i.due),
      })),
      arrear: { amount: m(bill.arrear.amount), paid: m(bill.arrear.paid), due: m(bill.arrear.due), excess: m(bill.arrear.excess) },
      bounce: {
        amount: m(bill.bounce.amount), paid: m(bill.bounce.paid), due: m(bill.bounce.due),
        items: bill.bounce.items.map((i) => ({ receiptNo: i.receiptNo, amount: m(i.amount) })),
      },
      totals: {
        charges: m(bill.totals.charges), fine: m(bill.totals.fine), paid: m(bill.totals.paid), due: m(bill.totals.due),
      },
    };
  }
}
