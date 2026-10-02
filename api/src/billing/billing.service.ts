import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calculateBill, fromPaise, toPaise } from './bill.js';

type Db = Prisma.TransactionClient;

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
    filter: { studentId?: number; schoolId?: number; standardId?: number },
    db: Db = this.prisma,
  ) {
    const enrollments = await db.enrollment.findMany({
      where: {
        yearId,
        ...(filter.studentId ? { studentId: filter.studentId } : {}),
        ...(filter.schoolId ? { student: { schoolId: filter.schoolId } } : {}),
        ...(filter.standardId ? { section: { standardId: filter.standardId } } : {}),
      },
      include: {
        student: true,
        section: { include: { standard: true } },
        optionalHeads: { select: { id: true } },
        concessions: true,
        facilityAssignments: { include: { facility: true } },
      },
    });
    if (!enrollments.length) return [];
    const schoolId = enrollments[0].student.schoolId;
    const studentIds = enrollments.map((e) => e.studentId);
    const facilityIds = enrollments.flatMap((e) => e.facilityAssignments.map((a) => a.facilityId));

    const [installments, structure, allocations, facilityStructure] = await Promise.all([
      db.installment.findMany({ where: { schoolId, yearId } }),
      db.feeStructure.findMany({
        where: { yearId, standardId: { in: [...new Set(enrollments.map((e) => e.section.standardId))] } },
        include: { feeHead: true },
      }),
      db.paymentAllocation.findMany({
        where: { payment: { studentId: { in: studentIds }, yearId, cancelledAt: null } },
        include: { payment: { select: { date: true, studentId: true } } },
      }),
      facilityIds.length
        ? db.facilityFeeStructure.findMany({ where: { yearId, facilityId: { in: facilityIds } } })
        : [],
    ]);
    const inst = installments.map((i) => ({ ...i, finePerDay: toPaise(i.finePerDay.toFixed(2)) }));

    return enrollments.map((e) => ({
      student: {
        id: e.student.id, schoolId, admissionNo: e.student.admissionNo, name: e.student.name, active: e.student.active,
        className: `${e.section.standard.name} ${e.section.name}`, enrollmentId: e.id,
        standardId: e.section.standardId, standard: e.section.standard.name, sortOrder: e.section.standard.sortOrder,
      },
      ...calculateBill({
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
            charges: toPaise(a.charges.toFixed(2)), fine: toPaise(a.fine.toFixed(2)),
          })),
        concessions: e.concessions.map((c) => ({
          feeHeadId: c.feeHeadId, reason: c.reason,
          percent: c.percent === null ? null : Number(c.percent), amount: c.amount === null ? null : toPaise(c.amount.toFixed(2)),
        })),
        facilityLines: e.facilityAssignments.flatMap((a) =>
          facilityStructure
            .filter((s) => s.facilityId === a.facilityId)
            .map((s) => ({ facilityId: a.facilityId, name: a.facility.name, installmentId: s.installmentId, amount: toPaise(s.amount.toFixed(2)) })),
        ),
        asOf,
      }),
    }));
  }

  // Paise -> "1234.50" strings for the API.
  static present(bill: Awaited<ReturnType<BillingService['build']>>) {
    const m = (p: number) => fromPaise(p);
    const { id, admissionNo, name, className } = bill.student;
    const student = { id, admissionNo, name, className };
    return {
      student,
      installments: bill.installments.map((i) => ({
        installmentId: i.installmentId, number: i.number, label: i.label, dueDate: i.dueDate, fineDays: i.fineDays,
        lines: i.lines.map((l) => ({ ...l, amount: m(l.amount) })),
        charges: m(i.charges), fine: m(i.fine), paid: m(i.paid), due: m(i.due),
      })),
      totals: {
        charges: m(bill.totals.charges), fine: m(bill.totals.fine), paid: m(bill.totals.paid), due: m(bill.totals.due),
      },
    };
  }
}
