import { describe, expect, it } from 'vitest';
import { allocate, calculateBill, type BillInput } from './bill.js';

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const base = (over: Partial<BillInput> = {}): BillInput => ({
  installments: [
    { id: 1, number: 1, label: 'I1', dueDate: D('2090-06-10'), fineStartDate: null, finePerDay: 0 },
    { id: 2, number: 2, label: 'I2', dueDate: D('2090-09-10'), fineStartDate: null, finePerDay: 0 },
  ],
  structure: [1, 2].map((installmentId) => ({ feeHeadId: 1, name: 'Tuition', type: 'MONTHLY' as const, installmentId, amount: 100_000 })),
  isNewAdmission: false, optionalHeadIds: [], payments: [], concessions: [], withdrawnOn: null, fineOverrides: [], facilityLines: [],
  asOf: D('2026-10-01'), ...over,
});

describe('bounce charge', () => {
  it('folds into the totals and keeps charges + fine - paid = due', () => {
    const b = calculateBill(base({ bounceCharges: 15_000, payments: [{ installmentId: null, date: D('2026-09-01'), charges: 0, fine: 0, bounce: 5_000 }] }));
    expect(b.bounce).toEqual({ amount: 15_000, paid: 5_000, due: 10_000 });
    expect(b.totals).toEqual({ charges: 215_000, fine: 0, paid: 5_000, due: 210_000 });
    expect(b.totals.charges + b.totals.fine - b.totals.paid).toBe(b.totals.due);
  });

  it('is allocated after arrear and before installments, in one installment-less row', () => {
    const bill = calculateBill(base({ arrear: 20_000, bounceCharges: 15_000 }));
    const out = allocate(bill.installments, 50_000, bill.arrear.due, bill.bounce.due);
    expect(out).toEqual([
      { installmentId: null, charges: 0, fine: 0, arrear: 20_000, bounce: 15_000 },
      { installmentId: 1, charges: 15_000, fine: 0 },
    ]);
    expect(allocate(bill.installments, 10_000, bill.arrear.due, bill.bounce.due)).toEqual([{ installmentId: null, charges: 0, fine: 0, arrear: 10_000 }]);
    expect(allocate(bill.installments, 30_000, 0, 15_000)[0]).toEqual({ installmentId: null, charges: 0, fine: 0, bounce: 15_000 });
  });

  it('rejects more than everything owed, bounce included', () => {
    const bill = calculateBill(base({ bounceCharges: 15_000 }));
    expect(() => allocate(bill.installments, 215_001, 0, bill.bounce.due)).toThrow(RangeError);
    expect(allocate(bill.installments, 215_000, 0, bill.bounce.due).reduce((s, a) => s + a.charges + (a.bounce ?? 0), 0)).toBe(215_000);
  });

  it('is zero by default and never negative', () => {
    expect(calculateBill(base()).bounce).toEqual({ amount: 0, paid: 0, due: 0 });
    expect(calculateBill(base({ bounceCharges: -5 })).bounce.amount).toBe(0);
  });
});
