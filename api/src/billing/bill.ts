// Pure bill calculation. All money is integer paise so totals never drift.

export type HeadType = 'ADMISSION' | 'ANNUAL' | 'MONTHLY' | 'REFUNDABLE' | 'OPTIONAL';

export type BillPayment = { installmentId: number; date: Date; charges: number; fine: number };

export type BillInput = {
  installments: { id: number; number: number; label: string; dueDate: Date; fineStartDate: Date | null; finePerDay: number }[];
  structure: { feeHeadId: number; name: string; type: HeadType; installmentId: number; amount: number }[];
  isNewAdmission: boolean;
  optionalHeadIds: number[];
  payments: BillPayment[]; // non-cancelled allocations only
  // amount is paise off each installment of that head
  concessions: { feeHeadId: number; percent: number | null; amount: number | null; reason: string }[];
  // Transport/hostel: a flat amount per installment for whichever routes/rooms the student is on.
  // No concessions apply to these (feeHeadId is negative so the concession lookup never matches).
  // Fixed fine (paise) replacing the computed one for that installment; 0 waives it.
  fineOverrides: { installmentId: number; amount: number }[];
  facilityLines: { facilityId: number; name: string; installmentId: number; amount: number }[];
  asOf: Date;
};

export type BillLine = { feeHeadId: number; name: string; amount: number };
export type InstallmentBill = {
  installmentId: number;
  number: number;
  label: string;
  dueDate: Date;
  lines: BillLine[];
  charges: number;
  fine: number;
  fineDays: number;
  fineOverridden: boolean;
  chargesDue: number;
  fineDue: number;
  paid: number;
  due: number;
};
export type Allocation = { installmentId: number; charges: number; fine: number };

const DAY = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// "1234.5" / Decimal#toFixed(2) -> 123450, without float maths.
export function toPaise(v: string | number): number {
  const [whole, frac = ''] = String(v).split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 100 + Number((frac + '00').slice(0, 2)));
}

export const fromPaise = (p: number) => (p / 100).toFixed(2);

function applies(type: HeadType, feeHeadId: number, input: BillInput) {
  if (type === 'ADMISSION' || type === 'REFUNDABLE') return input.isNewAdmission;
  if (type === 'OPTIONAL') return input.optionalHeadIds.includes(feeHeadId);
  return true;
}

export function calculateBill(input: BillInput) {
  const today = utcDay(input.asOf);

  const installments: InstallmentBill[] = [...input.installments]
    .sort((a, b) => a.number - b.number)
    .map((inst) => {
      const lines = input.structure
        .filter((s) => s.installmentId === inst.id && applies(s.type, s.feeHeadId, input))
        .flatMap(({ feeHeadId, name, amount }) => {
          const c = input.concessions.find((x) => x.feeHeadId === feeHeadId);
          const off = !c ? 0 : c.percent !== null ? Math.round((amount * c.percent) / 100) : Math.min(amount, c.amount ?? 0);
          const line = { feeHeadId, name, amount };
          return off ? [line, { feeHeadId, name: `Less: ${name} concession (${c!.reason})`, amount: -off }] : [line];
        })
        .concat(
          input.facilityLines
            .filter((f) => f.installmentId === inst.id)
            .map((f) => ({ feeHeadId: -f.facilityId, name: f.name, amount: f.amount })),
        );
      const charges = lines.reduce((sum, l) => sum + l.amount, 0);

      const pays = input.payments
        .filter((p) => p.installmentId === inst.id && utcDay(p.date) <= today)
        .sort((a, b) => utcDay(a.date) - utcDay(b.date));
      const chargesPaid = pays.reduce((s, p) => s + p.charges, 0);
      const finePaid = pays.reduce((s, p) => s + p.fine, 0);

      // Fine runs from fineStartDate (inclusive) until the day charges are fully paid.
      // ponytail: flat per-day rate, no cap. Add a max-fine column if schools need one.
      let settledOn: number | null = charges === 0 ? -Infinity : null;
      let cumulative = 0;
      for (const p of pays) {
        cumulative += p.charges;
        if (settledOn === null && cumulative >= charges) settledOn = utcDay(p.date);
      }
      let fineDays = 0;
      if (inst.fineStartDate) {
        const end = settledOn ?? today;
        const start = utcDay(inst.fineStartDate);
        if (end >= start) fineDays = (end - start) / DAY + 1;
      }
      const override = input.fineOverrides.find((o) => o.installmentId === inst.id);
      const fine = override ? override.amount : fineDays * inst.finePerDay;
      // A fine override can drop below what was already paid as fine; that surplus counts toward the charges.
      const chargesDue = Math.max(0, charges - chargesPaid - Math.max(0, finePaid - fine));
      const fineDue = Math.max(0, fine - finePaid);

      return {
        installmentId: inst.id,
        number: inst.number,
        label: inst.label,
        dueDate: inst.dueDate,
        lines,
        charges,
        fine,
        fineDays,
        fineOverridden: !!override,
        chargesDue,
        fineDue,
        paid: chargesPaid + finePaid,
        due: chargesDue + fineDue,
      };
    });

  const total = (k: 'charges' | 'fine' | 'paid' | 'due') => installments.reduce((s, i) => s + i[k], 0);
  return {
    installments,
    totals: { charges: total('charges'), fine: total('fine'), paid: total('paid'), due: total('due') },
  };
}

// Oldest installment first; within one, fine before charges.
export function allocate(installments: InstallmentBill[], amount: number): Allocation[] {
  let left = amount;
  const out: Allocation[] = [];
  for (const i of [...installments].sort((a, b) => a.number - b.number)) {
    const fine = Math.min(left, i.fineDue);
    const charges = Math.min(left - fine, i.chargesDue);
    left -= fine + charges;
    if (fine + charges > 0) out.push({ installmentId: i.installmentId, charges, fine });
  }
  if (left > 0) throw new RangeError('Amount is more than the balance due');
  return out;
}
