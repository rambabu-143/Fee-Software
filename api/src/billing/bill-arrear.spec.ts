import { allocate, calculateBill, type BillInput } from './bill.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const base: BillInput = {
  installments: [
    { id: 1, number: 1, label: 'First', dueDate: d('2026-04-10'), fineStartDate: d('2026-04-20'), finePerDay: 1000 },
    { id: 2, number: 2, label: 'Second', dueDate: d('2026-07-10'), fineStartDate: null, finePerDay: 0 },
  ],
  structure: [
    { feeHeadId: 12, name: 'Tuition', type: 'MONTHLY', installmentId: 1, amount: 500000 },
    { feeHeadId: 12, name: 'Tuition', type: 'MONTHLY', installmentId: 2, amount: 300000 },
  ],
  isNewAdmission: false, optionalHeadIds: [], payments: [], concessions: [], fineOverrides: [],
  withdrawnOn: null, facilityLines: [], asOf: d('2026-04-01'),
};

describe('arrear in the bill', () => {
  it('no arrear: unchanged totals, zero arrear block', () => {
    const b = calculateBill(base);
    expect(b.arrear).toEqual({ amount: 0, paid: 0, due: 0, excess: 0 });
    expect(b.totals).toEqual({ charges: 800000, fine: 0, paid: 0, due: 800000 });
  });

  it('positive arrear adds to charges/due, attracts no fine, even when installments are fined', () => {
    const b = calculateBill({ ...base, arrear: 120000, asOf: d('2026-04-22') });
    expect(b.arrear).toMatchObject({ amount: 120000, due: 120000 });
    expect(b.installments[0].fine).toBe(3000); // fine only from the installment, not the arrear
    expect(b.totals).toEqual({ charges: 920000, fine: 3000, paid: 0, due: 923000 });
    expect(b.totals.charges + b.totals.fine - b.totals.paid).toBe(b.totals.due);
  });

  it('allocate puts arrear first, then fine before charges, oldest installment first', () => {
    const b = calculateBill({ ...base, arrear: 120000, asOf: d('2026-04-22') });
    expect(allocate(b.installments, 100000, b.arrear.due)).toEqual([{ installmentId: null, charges: 0, fine: 0, arrear: 100000 }]);
    expect(allocate(b.installments, 130000, b.arrear.due)).toEqual([
      { installmentId: null, charges: 0, fine: 0, arrear: 120000 },
      { installmentId: 1, charges: 7000, fine: 3000 },
    ]);
    // Every paise accounted for, and no arrear row when none is due.
    expect(allocate(b.installments, 923000, b.arrear.due).reduce((s, a) => s + a.charges + a.fine + (a.arrear ?? 0), 0)).toBe(923000);
    expect(allocate(calculateBill(base).installments, 1000)).toEqual([{ installmentId: 1, charges: 1000, fine: 0 }]);
    expect(() => allocate(b.installments, 923001, b.arrear.due)).toThrow(RangeError);
  });

  it('arrear payments count toward paid and clear the arrear; later payments see it as settled', () => {
    const pays = [{ installmentId: null, date: d('2026-04-05'), charges: 0, fine: 0, arrear: 120000 }];
    const b = calculateBill({ ...base, arrear: 120000, payments: pays, asOf: d('2026-04-06') });
    expect(b.arrear).toEqual({ amount: 120000, paid: 120000, due: 0, excess: 0 });
    expect(b.totals.paid).toBe(120000);
    expect(b.totals.due).toBe(800000);
    // A future-dated receipt is not counted yet, like installment payments.
    expect(calculateBill({ ...base, arrear: 120000, payments: pays, asOf: d('2026-04-01') }).arrear.paid).toBe(0);
  });

  it('negative arrear (credit) reduces the earliest installments first and never makes charges negative', () => {
    const b = calculateBill({ ...base, arrear: -600000 });
    expect(b.installments.map((i) => i.charges)).toEqual([0, 200000]);
    expect(b.installments[0].lines.at(-1)).toMatchObject({ name: 'Less: previous year credit', amount: -500000 });
    expect(b.totals).toEqual({ charges: 200000, fine: 0, paid: 0, due: 200000 });
    expect(b.arrear).toMatchObject({ amount: 0, excess: 0 });
  });

  it('credit larger than all charges leaves the remainder as excess owed back, due stays 0', () => {
    const b = calculateBill({ ...base, arrear: -1000000 });
    expect(b.totals.due).toBe(0);
    expect(b.totals.charges).toBe(0);
    expect(b.arrear.excess).toBe(200000);
  });

  it('credit lets a fully-credited installment settle, so its fine stops', () => {
    const b = calculateBill({ ...base, arrear: -500000, asOf: d('2026-05-30') });
    expect(b.installments[0]).toMatchObject({ charges: 0, fine: 0, due: 0 });
  });

  it('partial payment after a credit leaves the right remainder (credit applied once, not twice)', () => {
    const pays = [{ installmentId: 1, date: d('2026-04-05'), charges: 100000, fine: 0 }];
    const b = calculateBill({ ...base, arrear: -200000, payments: pays, asOf: d('2026-04-06') });
    expect(b.installments[0]).toMatchObject({ charges: 300000, paid: 100000, due: 200000 });
  });

  it('withdrawn student: dropped installments take no credit, arrear still owed', () => {
    const b = calculateBill({ ...base, arrear: 50000, withdrawnOn: d('2026-04-15') });
    expect(b.installments[1].charges).toBe(0);
    expect(b.arrear.due).toBe(50000);
    const credit = calculateBill({ ...base, arrear: -900000, withdrawnOn: d('2026-04-15') });
    expect(credit.installments[1].charges).toBe(0);
    expect(credit.arrear.excess).toBe(400000);
  });

  it('over-collected arrear (waived after payment is blocked by the API) still never goes negative', () => {
    const pays = [{ installmentId: null, date: d('2026-04-05'), charges: 0, fine: 0, arrear: 150000 }];
    const b = calculateBill({ ...base, arrear: 100000, payments: pays, asOf: d('2026-04-06') });
    expect(b.arrear).toMatchObject({ due: 0, excess: 50000 });
  });
});
