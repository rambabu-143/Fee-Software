import { allocate, calculateBill, splitHeads, type BillInput, type BillLine } from './bill.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const L = (feeHeadId: number, name: string, amount: number): BillLine => ({ feeHeadId, name, amount });
const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

describe('splitHeads', () => {
  const lines = [L(1, 'Tuition', 5000), L(2, 'Annual', 3000), L(3, 'Caution', 2000)];
  const refundable = new Set([3]);

  it('fills heads in bill order with refundable last', () => {
    expect(splitHeads(lines, refundable, 0, 4000)).toMatchObject([{ feeHeadId: 1, amount: 4000 }]);
    expect(splitHeads(lines, refundable, 4000, 3000)).toMatchObject([{ feeHeadId: 1, amount: 1000 }, { feeHeadId: 2, amount: 2000 }]);
    // The deposit is reached only after every fee is paid.
    const last = splitHeads(lines, refundable, 8000, 2000);
    expect(last).toMatchObject([{ feeHeadId: 3, refundable: true, amount: 2000 }]);
  });

  it('puts refundable last even when the structure lists it first', () => {
    const r = splitHeads([L(3, 'Caution', 2000), L(1, 'Tuition', 5000)], refundable, 0, 5000);
    expect(r).toMatchObject([{ feeHeadId: 1, amount: 5000 }]);
  });

  it('nets concessions into their head and takes previous-year credit off fees before deposits', () => {
    const withCredit = [L(1, 'Tuition', 5000), L(1, 'Less: Tuition concession (staff)', -1000), L(3, 'Caution', 2000), L(0, 'Less: previous year credit', -4500)];
    // tuition net 4000 -> credit eats all of it plus 500 of the deposit: 1500 left to pay in total
    expect(splitHeads(withCredit, refundable, 0, 1500)).toMatchObject([{ feeHeadId: 3, amount: 1500 }]);
  });

  it('sends overflow to the last head and keeps the sum exact', () => {
    const r = splitHeads(lines, refundable, 9000, 3000);
    expect(sum(r)).toBe(3000);
    expect(splitHeads([], refundable, 0, 700)).toMatchObject([{ feeHeadId: 0, name: 'Unallocated', amount: 700 }]);
  });
});

// Seeded PRNG so a failure is reproducible.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('splitHeads property: replayed real bills', () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i: shares add up, never overfill, deposits last', (seed) => {
    const r = rng(seed);
    const pick = (n: number) => Math.floor(r() * n);
    const heads = [
      { feeHeadId: 10, name: 'Admission', type: 'ADMISSION' as const },
      { feeHeadId: 11, name: 'Caution Money', type: 'REFUNDABLE' as const },
      { feeHeadId: 12, name: 'Tuition', type: 'MONTHLY' as const },
      { feeHeadId: 13, name: 'Annual', type: 'ANNUAL' as const },
    ];
    const insts = [1, 2, 3].map((n) => ({ id: n, number: n, label: `I${n}`, dueDate: d(`2026-0${n * 2}-10`), fineStartDate: d(`2026-0${n * 2}-20`), finePerDay: pick(3) * 500 }));
    const base: BillInput = {
      installments: insts,
      structure: insts.flatMap((i) => heads.map((h) => ({ ...h, installmentId: i.id, amount: (1 + pick(50)) * 100 + pick(100) }))),
      isNewAdmission: true, optionalHeadIds: [], payments: [],
      concessions: r() < 0.5 ? [{ feeHeadId: 12, percent: 10 * (1 + pick(5)), amount: null, reason: 'x' }] : [],
      withdrawnOn: null, fineOverrides: [], facilityLines: r() < 0.5 ? [{ facilityId: 5, name: 'Bus', installmentId: 1, amount: 4000 }] : [],
      arrear: r() < 0.5 ? (pick(2) ? 1 : -1) * (1 + pick(200)) * 100 : 0,
      bounceCharges: r() < 0.3 ? 5000 : 0,
      asOf: d('2026-12-31'),
    };
    const refundable = new Set(heads.filter((h) => h.type === 'REFUNDABLE').map((h) => h.feeHeadId));
    const paid: BillInput['payments'] = [];
    const perHead = new Map<string, number>(); // `${inst}:${head}` -> paid so far
    const chargesPaid = new Map<number, number>();
    for (let k = 0; k < 8; k++) {
      const bill = calculateBill({ ...base, payments: paid });
      if (!bill.totals.due) break;
      const amount = Math.max(1, Math.floor(bill.totals.due * (k === 7 ? 1 : r() * 0.6)));
      const split = allocate(bill.installments, amount, bill.arrear.due, bill.bounce.due);
      for (const a of split) {
        paid.push({ installmentId: a.installmentId, date: d(`2026-12-${10 + k}`), charges: a.charges, fine: a.fine, arrear: a.arrear, bounce: a.bounce });
        if (a.installmentId === null || a.charges === 0) continue;
        const inst = bill.installments.find((i) => i.installmentId === a.installmentId)!;
        const before = chargesPaid.get(inst.installmentId) ?? 0;
        const shares = splitHeads(inst.lines, refundable, before, a.charges);
        expect(sum(shares)).toBe(a.charges);
        for (const s of shares) perHead.set(`${inst.installmentId}:${s.feeHeadId}`, (perHead.get(`${inst.installmentId}:${s.feeHeadId}`) ?? 0) + s.amount);
        chargesPaid.set(inst.installmentId, before + a.charges);
        // A head can never be paid beyond its net, and a deposit gets money only once every fee head is full.
        const full = splitHeads(inst.lines, refundable, 0, inst.charges);
        const net = new Map(full.map((f) => [f.feeHeadId, f.amount]));
        for (const f of full) expect(perHead.get(`${inst.installmentId}:${f.feeHeadId}`) ?? 0).toBeLessThanOrEqual(net.get(f.feeHeadId)!);
        if (shares.some((s) => s.refundable)) {
          for (const f of full.filter((x) => !x.refundable)) expect(perHead.get(`${inst.installmentId}:${f.feeHeadId}`) ?? 0).toBe(f.amount);
        }
      }
    }
  });
});
