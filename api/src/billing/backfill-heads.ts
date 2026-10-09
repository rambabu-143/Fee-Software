import type { PrismaClient } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';
import { fromPaise, splitHeads, toPaise } from './bill.js';

// Gives receipts made before per-head allocation their PaymentAllocationHead rows. Idempotent: only allocations
// with charges and no head rows are touched. Replays each student-year's receipts in order against the CURRENT
// bill lines with the same rule as collect() (splitHeads). If the fee structure changed since a receipt, the
// split is best effort; shares always add up to the allocation's charges (overflow goes to the last head, or
// "Unallocated" when the student has no bill).
export async function backfillHeads(prisma: PrismaClient, only: { schoolId?: number } = {}) {
  const billing = new BillingService(prisma as unknown as PrismaService);
  const todo = { installmentId: { not: null }, charges: { gt: 0 }, heads: { none: {} } } as const;
  const pairs = await prisma.payment.findMany({
    where: { ...only, allocations: { some: todo } }, distinct: ['schoolId', 'yearId'], select: { schoolId: true, yearId: true },
  });
  let filled = 0, rows = 0;
  for (const { schoolId, yearId } of pairs) {
    const refundableIds = new Set((await prisma.feeHead.findMany({ where: { schoolId, type: 'REFUNDABLE' }, select: { id: true } })).map((h) => h.id));
    const bills = new Map((await billing.buildMany(yearId, new Date(), { schoolId })).map((b) => [b.student.id, b]));
    const students = await prisma.payment.findMany({ where: { schoolId, yearId, allocations: { some: todo } }, distinct: ['studentId'], select: { studentId: true } });
    for (const { studentId } of students) {
      const pays = await prisma.payment.findMany({
        where: { schoolId, yearId, studentId }, orderBy: [{ date: 'asc' }, { receiptNo: 'asc' }],
        include: { allocations: { include: { heads: { select: { id: true } } }, orderBy: { id: 'asc' } } },
      });
      const before = new Map<number, number>(); // installmentId -> charges paid by live receipts so far
      for (const p of pays) {
        const live = !p.cancelledAt && p.clearStatus !== 'BOUNCED';
        for (const a of p.allocations) {
          if (a.installmentId === null) continue;
          const charges = toPaise(a.charges.toFixed(2));
          const prior = before.get(a.installmentId) ?? 0;
          if (charges > 0 && a.heads.length === 0) {
            const lines = bills.get(studentId)?.installments.find((i) => i.installmentId === a.installmentId)?.lines ?? [];
            const data = splitHeads(lines, refundableIds, prior, charges).map((h) => ({
              allocationId: a.id, feeHeadId: h.feeHeadId, name: h.name, refundable: h.refundable, amount: fromPaise(h.amount),
            }));
            await prisma.paymentAllocationHead.createMany({ data });
            filled++; rows += data.length;
          }
          if (live) before.set(a.installmentId, prior + charges);
        }
      }
    }
  }
  return { filled, rows };
}

// Installment allocations with charges whose head rows are missing, or don't add up to the charges.
export async function headGaps(prisma: PrismaClient, schoolId?: number) {
  const [r] = await prisma.$queryRaw<{ missing: bigint; wrong: bigint }[]>`
    SELECT count(*) FILTER (WHERE h.total IS NULL) AS missing, count(*) FILTER (WHERE h.total IS NOT NULL AND h.total <> a.charges) AS wrong
    FROM "PaymentAllocation" a
    JOIN "Payment" p ON p.id = a."paymentId"
    LEFT JOIN (SELECT "allocationId", sum(amount) AS total FROM "PaymentAllocationHead" GROUP BY 1) h ON h."allocationId" = a.id
    WHERE a."installmentId" IS NOT NULL AND a.charges > 0 AND (${schoolId ?? null}::int IS NULL OR p."schoolId" = ${schoolId ?? null}::int)`;
  return { missing: Number(r.missing), wrong: Number(r.wrong) };
}
