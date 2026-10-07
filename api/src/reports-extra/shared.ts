import type { Prisma, PaymentMode } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { BillingService } from '../billing/billing.service.js';
import { toPaise } from '../billing/bill.js';

// Money only counts for receipts that are neither cancelled nor bounced.
export const live = { cancelledAt: null, clearStatus: { not: 'BOUNCED' } } satisfies Prisma.PaymentWhereInput;

// The current roll: enrolled this year, not withdrawn, student still active. Class filters are optional.
export const rollWhere = (schoolId: number, yearId: number, standardId?: number, sectionId?: number): Prisma.EnrollmentWhereInput => ({
  yearId,
  withdrawal: null,
  student: { schoolId, active: true },
  ...(standardId || sectionId ? { section: { ...(standardId ? { standardId } : {}), ...(sectionId ? { id: sectionId } : {}) } } : {}),
});

export const classOf = (e: { section: { name: string; standard: { name: string } } }) => `${e.section.standard.name} ${e.section.name}`;

type Bill = Awaited<ReturnType<BillingService['buildMany']>>[number];
const CONCESSION = 'Less: ';
// Facility lines carry negative ids; stop-based transport sits at -1_000_000 and below.
export const isTransportLine = (feeHeadId: number) => feeHeadId <= -1_000_000;

// Reporting bucket of a bill line: fee head name, "Transport" for every stop leg, facility name otherwise.
function bucketNames(lines: { feeHeadId: number; name: string }[]) {
  const names = new Map<number, string>();
  for (const l of lines) if (!l.name.startsWith(CONCESSION) && !names.has(l.feeHeadId)) names.set(l.feeHeadId, l.name);
  return (id: number) => (isTransportLine(id) ? 'Transport' : (names.get(id) ?? `Head ${id}`));
}

// Net charge (after concession) per bucket for one installment's lines.
export function netByBucket(lines: { feeHeadId: number; name: string; amount: number }[]) {
  const bucket = bucketNames(lines);
  const out = new Map<string, number>();
  for (const l of lines) out.set(bucket(l.feeHeadId), (out.get(bucket(l.feeHeadId)) ?? 0) + l.amount);
  return out;
}

// Concession given on a bill, in paise (positive), per fee head id.
export function concessionByHead(bill: Bill) {
  const out = new Map<number, number>();
  for (const i of bill.installments) {
    for (const l of i.lines) if (l.name.startsWith(CONCESSION)) out.set(l.feeHeadId, (out.get(l.feeHeadId) ?? 0) - l.amount);
  }
  return out;
}

// Splits `total` paise across weights, exact to the paisa (largest remainder).
export function split(total: number, weights: number[]): number[] | null {
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum) return null;
  const exact = w.map((x) => (total * x) / sum);
  const out = exact.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  [...exact.keys()].sort((a, b) => exact[b] - out[b] - (exact[a] - out[a])).forEach((i) => {
    if (rem-- > 0) out[i]++;
  });
  return out;
}

export type Share = { studentId: number; bucket: string; paise: number; date: Date; mode: PaymentMode };

// Receipts only record how much went to each installment, not to each fee head. For reports by head we split
// every allocation across that installment's net head amounts pro-rata.
// ponytail: pro-rata approximation, and it builds every bill in memory; store per-head allocations if the
// accountants need exact head receipts, and materialise bills past a few thousand students.
export async function paidShares(
  prisma: PrismaService,
  billing: BillingService,
  o: { schoolId: number; yearId: number; standardId?: number; sectionId?: number; from?: Date; to?: Date },
) {
  const bills = await billing.buildMany(o.yearId, new Date(), { schoolId: o.schoolId, standardId: o.standardId, sectionId: o.sectionId });
  const nets = new Map<string, Map<string, number>>();
  for (const b of bills) for (const i of b.installments) nets.set(`${b.student.id}:${i.installmentId}`, netByBucket(i.lines));
  const allocations = await prisma.paymentAllocation.findMany({
    where: {
      payment: {
        schoolId: o.schoolId, yearId: o.yearId, ...live,
        studentId: { in: bills.map((b) => b.student.id) },
        ...(o.from || o.to ? { date: { ...(o.from && { gte: o.from }), ...(o.to && { lte: o.to }) } } : {}),
      },
    },
    include: { payment: { select: { studentId: true, date: true, mode: true } } },
  });
  const shares: Share[] = [];
  for (const a of allocations) {
    const base = { studentId: a.payment.studentId, date: a.payment.date, mode: a.payment.mode };
    const add = (bucket: string, paise: number) => paise && shares.push({ ...base, bucket, paise });
    add('Fine', toPaise(a.fine.toFixed(2)));
    add('Arrear', toPaise(a.arrear.toFixed(2)));
    const charges = toPaise(a.charges.toFixed(2));
    const net = a.installmentId === null ? undefined : nets.get(`${base.studentId}:${a.installmentId}`);
    const parts = net && charges ? split(charges, [...net.values()]) : null;
    if (parts) [...net!.keys()].forEach((bucket, i) => add(bucket, parts[i]));
    else add(a.installmentId === null ? 'Arrear' : 'Unallocated', charges);
  }
  return { bills, shares };
}
