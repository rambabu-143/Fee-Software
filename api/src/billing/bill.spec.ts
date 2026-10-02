import { allocate, calculateBill, toPaise, type BillInput } from './bill.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

const base: BillInput = {
  installments: [
    { id: 2, number: 2, label: 'Second', dueDate: d('2026-07-10'), fineStartDate: d('2026-07-20'), finePerDay: 1000 },
    { id: 1, number: 1, label: 'First', dueDate: d('2026-04-10'), fineStartDate: d('2026-04-20'), finePerDay: 1000 },
  ],
  structure: [
    { feeHeadId: 10, name: 'Admission', type: 'ADMISSION', installmentId: 1, amount: 2000000 },
    { feeHeadId: 11, name: 'Caution', type: 'REFUNDABLE', installmentId: 1, amount: 500000 },
    { feeHeadId: 12, name: 'Tuition', type: 'MONTHLY', installmentId: 1, amount: 500000 },
    { feeHeadId: 12, name: 'Tuition', type: 'MONTHLY', installmentId: 2, amount: 500000 },
    { feeHeadId: 13, name: 'Computer', type: 'OPTIONAL', installmentId: 2, amount: 100000 },
  ],
  isNewAdmission: false,
  optionalHeadIds: [],
  payments: [],
  concessions: [],
  fineOverrides: [],
  facilityLines: [],
  asOf: d('2026-04-01'),
};
const pay = (installmentId: number, date: string, charges: number, fine = 0) => ({ installmentId, date: d(date), charges, fine });

describe('calculateBill', () => {
  it('concessions: percent or capped fixed amount, shown as a negative line', () => {
    const pct = calculateBill({ ...base, concessions: [{ feeHeadId: 12, percent: 12.5, amount: null, reason: 'Sibling' }] });
    expect(pct.installments.map((i) => i.charges)).toEqual([437500, 437500]);
    expect(pct.installments[0].lines[1]).toEqual({ feeHeadId: 12, name: 'Less: Tuition concession (Sibling)', amount: -62500 });
    const fixed = calculateBill({ ...base, concessions: [{ feeHeadId: 12, percent: null, amount: 9999999, reason: 'Full' }] });
    expect(fixed.totals.charges).toBe(0);
  });

  it('facility lines add a flat amount per installment, untouched by concessions', () => {
    const bill = calculateBill({
      ...base,
      concessions: [{ feeHeadId: 12, percent: 100, amount: null, reason: 'Full' }],
      facilityLines: [{ facilityId: 1, name: 'Route A', installmentId: 1, amount: 150000 }],
    });
    expect(bill.installments[0].charges).toBe(150000); // tuition fully waived, route fee still due
    expect(bill.installments[0].lines).toContainEqual({ feeHeadId: -1, name: 'Route A', amount: 150000 });
  });

  it('continuing student: no admission/refundable/unopted optional heads, sorted by number', () => {
    const bill = calculateBill(base);
    expect(bill.installments.map((i) => i.number)).toEqual([1, 2]);
    expect(bill.installments.map((i) => i.charges)).toEqual([500000, 500000]);
    expect(bill.totals).toEqual({ charges: 1000000, fine: 0, paid: 0, due: 1000000 });
  });

  it('new admission with an opted optional head pays everything', () => {
    const bill = calculateBill({ ...base, isNewAdmission: true, optionalHeadIds: [13] });
    expect(bill.installments.map((i) => i.charges)).toEqual([3000000, 600000]);
  });

  it('fine counts days from fineStartDate inclusive', () => {
    const late = calculateBill({ ...base, asOf: d('2026-04-22') });
    expect(late.installments[0]).toMatchObject({ fineDays: 3, fine: 3000, due: 503000 });
    expect(late.installments[1]).toMatchObject({ fineDays: 0, fine: 0 });
    expect(calculateBill({ ...base, asOf: d('2026-04-20') }).installments[0].fineDays).toBe(1);
  });

  it('a fine override replaces the calculated fine; zero waives it', () => {
    const asOf = d('2026-04-22'); // 3 fine days = 30.00 calculated
    const fixed = calculateBill({ ...base, asOf, fineOverrides: [{ installmentId: 1, amount: 5000 }] });
    expect(fixed.installments[0]).toMatchObject({ fine: 5000, fineOverridden: true, due: 505000 });
    const waived = calculateBill({ ...base, asOf, fineOverrides: [{ installmentId: 1, amount: 0 }] });
    expect(waived.installments[0]).toMatchObject({ fine: 0, fineDue: 0, due: 500000 });
    expect(waived.installments[1].fineOverridden).toBe(false); // other installments untouched
    expect(calculateBill({ ...base, asOf }).installments[0]).toMatchObject({ fine: 3000, fineOverridden: false });
    // fine already paid beyond the override is credited to the charges, not lost
    const paid = calculateBill({ ...base, asOf, payments: [pay(1, '2026-04-22', 499000, 3000)], fineOverrides: [{ installmentId: 1, amount: 1000 }] });
    expect(paid.installments[0]).toMatchObject({ fineDue: 0, chargesDue: 0, due: 0 });
    const waivedAfterFinePaid = calculateBill({ ...base, asOf, payments: [pay(1, '2026-04-22', 0, 3000)], fineOverrides: [{ installmentId: 1, amount: 0 }] });
    expect(waivedAfterFinePaid.installments[0]).toMatchObject({ fineDue: 0, chargesDue: 497000, due: 497000 });
    const t = waivedAfterFinePaid.totals;
    expect(t.charges + t.fine - t.paid).toBe(t.due); // books still balance
  });

  it('paying before the fine date means no fine; fine freezes on the day charges are cleared', () => {
    const early = calculateBill({ ...base, asOf: d('2026-06-01'), payments: [pay(1, '2026-04-15', 500000)] });
    expect(early.installments[0]).toMatchObject({ fine: 0, due: 0, paid: 500000 });

    // Paid charges on 04-22 (3 fine days) but not the fine: fine stays 3000 months later.
    const frozen = calculateBill({ ...base, asOf: d('2026-06-01'), payments: [pay(1, '2026-04-22', 500000)] });
    expect(frozen.installments[0]).toMatchObject({ fineDays: 3, fine: 3000, fineDue: 3000, chargesDue: 0, due: 3000 });
  });

  it('partial payment keeps the fine running and ignores payments after asOf', () => {
    const partial = calculateBill({ ...base, asOf: d('2026-04-25'), payments: [pay(1, '2026-04-21', 200000), pay(1, '2026-05-01', 300000)] });
    expect(partial.installments[0]).toMatchObject({ fineDays: 6, chargesDue: 300000, paid: 200000 });
  });
});

describe('allocate', () => {
  it('fills the oldest installment first, fine before charges', () => {
    const bill = calculateBill({ ...base, asOf: d('2026-04-22') }); // inst1: 5000.00 + 30.00 fine
    expect(allocate(bill.installments, 503000 + 100000)).toEqual([
      { installmentId: 1, charges: 500000, fine: 3000 },
      { installmentId: 2, charges: 100000, fine: 0 },
    ]);
    expect(allocate(bill.installments, 2000)).toEqual([{ installmentId: 1, charges: 0, fine: 2000 }]);
  });

  it('rejects more than the balance due', () => {
    const bill = calculateBill(base);
    expect(() => allocate(bill.installments, 1000001)).toThrow(RangeError);
  });
});

describe('toPaise', () => {
  it('parses decimal strings exactly', () => {
    expect(toPaise('1234.5')).toBe(123450);
    expect(toPaise('0.07')).toBe(7);
    expect(toPaise('8000.00')).toBe(800000);
    expect(toPaise(15)).toBe(1500);
    expect(toPaise('-2.50')).toBe(-250);
  });
});
