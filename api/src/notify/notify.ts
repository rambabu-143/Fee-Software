import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise } from '../billing/bill.js';

export const MAX_BATCH = 500;

type Bill = Awaited<ReturnType<BillingService['buildMany']>>[number];

export const fmtDate = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('-');
export const render = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m));

// Only installments already past their due date count (same rule as /reports/dues).
// A carried previous-year arrear and any bounce charge are overdue by definition.
export const overduePaise = (b: Bill, at: Date) =>
  b.installments.filter((i) => i.dueDate <= at).reduce((s, i) => s + i.due, 0) + b.arrear.due + b.bounce.due;

// Students of one school/year for a messaging batch, with the placeholder values for each.
// ponytail: builds the whole school's bills (like /reports/dues); fine to a few thousand students.
export async function loadTargets(prisma: PrismaService, billing: BillingService, schoolId: number, yearId: number, enrollmentIds: number[]) {
  if (new Set(enrollmentIds).size > MAX_BATCH) throw new BadRequestException(`At most ${MAX_BATCH} students per batch`);
  const now = new Date();
  const [rows, bills] = await Promise.all([
    prisma.enrollment.findMany({ where: { id: { in: enrollmentIds }, yearId, student: { schoolId } }, include: { student: true } }),
    billing.buildMany(yearId, now, { schoolId }),
  ]);
  const byStudent = new Map(bills.map((b) => [b.student.id, b]));
  return enrollmentIds.map((id) => {
    const e = rows.find((r) => r.id === id);
    if (!e) return { id, e: null, vars: {} as Record<string, string> };
    const b = byStudent.get(e.studentId);
    const next = b?.installments.find((i) => i.due > 0);
    return {
      id, e,
      vars: {
        name: e.student.name, admNo: e.student.admissionNo,
        due: b ? fromPaise(overduePaise(b, now)) : '0.00',
        lastDate: next ? fmtDate(next.dueDate) : '',
      },
    };
  });
}
