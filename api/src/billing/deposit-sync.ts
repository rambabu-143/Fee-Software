import { BadRequestException } from '@nestjs/common';
import type { DepositKind, Prisma } from '../generated/prisma/client.js';
import { fromPaise, toPaise } from './bill.js';
import type { BillingService } from './billing.service.js';

type Tx = Prisma.TransactionClient;
type Bill = Awaited<ReturnType<BillingService['build']>>;

// Which refundable head is which deposit: type REFUNDABLE plus the name. Anything else (e.g. a "Library Deposit")
// is left alone. A head named like 'security' is the transport security deposit (billed by bill.ts only to students
// on transport, once; refund it through the deposit refund endpoint when transport stops).
export const depositKind = (headName: string): DepositKind | null =>
  /advance/i.test(headName) ? 'ADVANCE' : /caution/i.test(headName) ? 'CAUTION' : /security/i.test(headName) ? 'TRANSPORT' : null;

// The voucher kind that pays out each deposit kind.
export const voucherKindOf = (k: DepositKind) => (k === 'ADVANCE' ? 'ADVANCE_REFUND' : k === 'CAUTION' ? 'CAUTION_REFUND' : null);

// After a receipt: a deposit exists once its refundable head's own charge is fully paid (exact per-head receipts,
// splitHeads in bill.ts puts deposits last, so a partial payment never counts). Rows without head data (receipts
// from before per-head allocation, not yet backfilled) fall back to "the whole installment is settled".
// Amount = the head's net charge (after concession). An existing (student, kind) deposit is never touched.
export async function autoDeposits(tx: Tx, bill: Bill, yearId: number, paymentId: number, username: string) {
  const heads = await tx.feeHead.findMany({ where: { schoolId: bill.student.schoolId, type: 'REFUNDABLE' } });
  const paidRows = await tx.paymentAllocationHead.groupBy({
    by: ['feeHeadId'], _sum: { amount: true },
    where: { allocation: { payment: { studentId: bill.student.id, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } } } },
  });
  const headPaid = new Map(paidRows.map((r) => [r.feeHeadId, toPaise((r._sum.amount ?? 0).toString())]));
  const kinds = new Map<DepositKind, { paise: number; covered: boolean }>();
  for (const h of heads) {
    const kind = depositKind(h.name);
    if (!kind) continue;
    const here = bill.installments.filter((i) => i.lines.some((l) => l.feeHeadId === h.id));
    if (!here.length) continue; // not billed to this student (continuing students owe no refundable head)
    const k = kinds.get(kind) ?? { paise: 0, covered: true };
    const net = here.reduce((s, i) => s + i.lines.filter((l) => l.feeHeadId === h.id).reduce((n, l) => n + l.amount, 0), 0);
    k.paise += net;
    k.covered &&= (headPaid.get(h.id) ?? 0) >= net || here.every((i) => i.chargesDue === 0);
    kinds.set(kind, k);
  }
  for (const [kind, { paise, covered }] of kinds) {
    if (!covered || paise <= 0) continue;
    const studentId = bill.student.id;
    if (await tx.deposit.findUnique({ where: { studentId_kind: { studentId, kind } } })) continue;
    await tx.deposit.create({ data: { studentId, kind, amount: fromPaise(paise), receivedYearId: yearId, paymentId, createdBy: username } });
  }
}

// Cancelling or bouncing a receipt takes back the deposits it created. Blocked once any refund
// or voucher payout exists against them: cancel those first.
export async function voidDeposits(tx: Tx, paymentId: number) {
  for (const d of await tx.deposit.findMany({ where: { paymentId } })) {
    const vk = voucherKindOf(d.kind);
    const paidOut = vk ? await tx.voucher.count({ where: { enrollment: { studentId: d.studentId }, kind: vk, cancelledAt: null } }) : 0;
    if (d.status !== 'HELD' || paidOut) {
      throw new BadRequestException(`The ${d.kind.toLowerCase()} deposit taken on this receipt was already refunded; cancel the refund first`);
    }
    await tx.deposit.delete({ where: { id: d.id } });
  }
}
