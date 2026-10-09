// Pure bill calculation. All money is integer paise so totals never drift.

export type HeadType = 'ADMISSION' | 'ANNUAL' | 'MONTHLY' | 'REFUNDABLE' | 'OPTIONAL';

// installmentId null = the receipt's previous-year arrear portion.
export type BillPayment = { installmentId: number | null; date: Date; charges: number; fine: number; arrear?: number; bounce?: number };

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
  // Student left on this date: installments due after it carry no charges.
  withdrawnOn: Date | null;
  fineOverrides: { installmentId: number; amount: number }[];
  facilityLines: { facilityId: number; name: string; installmentId: number; amount: number }[];
  // Previous-year closing balance in paise, net of any waiver. Positive = owed (allocated first, no fine);
  // negative = credit, spread over the earliest installments' charges.
  arrear?: number;
  // Bounce charges (paise) levied on bounced cheques of this enrollment's year; owed like an arrear, never fined.
  bounceCharges?: number;
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
  // Paid beyond what is owed for this installment (e.g. prepaid, then withdrew): owed back to the family.
  excess: number;
  chargesDue: number;
  fineDue: number;
  paid: number;
  due: number;
};
export type Allocation = { installmentId: number | null; charges: number; fine: number; arrear?: number; bounce?: number };

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

  // Previous-year credit eats the earliest installments' charges first; any left over is owed back.
  let creditLeft = Math.max(0, -(input.arrear ?? 0));
  const staged = [...input.installments]
    .sort((a, b) => a.number - b.number)
    .map((inst) => {
      const dropped = input.withdrawnOn !== null && utcDay(inst.dueDate) > utcDay(input.withdrawnOn);
      const lines = (dropped ? [] : input.structure)
        .filter((s) => s.installmentId === inst.id && applies(s.type, s.feeHeadId, input))
        .flatMap(({ feeHeadId, name, amount }) => {
          const c = input.concessions.find((x) => x.feeHeadId === feeHeadId);
          const off = !c ? 0 : c.percent !== null ? Math.round((amount * c.percent) / 100) : Math.min(amount, c.amount ?? 0);
          const line = { feeHeadId, name, amount };
          return off ? [line, { feeHeadId, name: `Less: ${name} concession (${c!.reason})`, amount: -off }] : [line];
        })
        .concat(
          (dropped ? [] : input.facilityLines)
            .filter((f) => f.installmentId === inst.id)
            .map((f) => ({ feeHeadId: -f.facilityId, name: f.name, amount: f.amount })),
        );
      const gross = lines.reduce((sum, l) => sum + l.amount, 0);
      const take = Math.min(creditLeft, Math.max(0, gross));
      creditLeft -= take;
      if (take) lines.push({ feeHeadId: 0, name: 'Less: previous year credit', amount: -take });
      return { inst, lines };
    });

  const installments: InstallmentBill[] = staged
    .map(({ inst, lines }) => {
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
      const excess = Math.max(0, chargesPaid + Math.max(0, finePaid - fine) - charges);

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
        excess,
        chargesDue,
        fineDue,
        paid: chargesPaid + finePaid,
        due: chargesDue + fineDue,
      };
    });

  const owed = Math.max(0, input.arrear ?? 0);
  const arrearPaid = input.payments.filter((p) => utcDay(p.date) <= today).reduce((s, p) => s + (p.arrear ?? 0), 0);
  const arrear = {
    amount: owed,
    paid: arrearPaid,
    due: Math.max(0, owed - arrearPaid),
    excess: creditLeft + Math.max(0, arrearPaid - owed),
  };
  const bounceOwed = Math.max(0, input.bounceCharges ?? 0);
  const bouncePaid = input.payments.filter((p) => utcDay(p.date) <= today).reduce((s, p) => s + (p.bounce ?? 0), 0);
  const bounce = { amount: bounceOwed, paid: bouncePaid, due: Math.max(0, bounceOwed - bouncePaid) };
  const total = (k: 'charges' | 'fine' | 'paid' | 'due') => installments.reduce((s, i) => s + i[k], 0);
  return {
    installments,
    arrear,
    bounce,
    // Arrear and bounce charges fold into the totals so charges + fine - paid = due still holds.
    totals: {
      charges: total('charges') + arrear.amount + bounce.amount, fine: total('fine'),
      paid: total('paid') + arrear.paid + bounce.paid, due: total('due') + arrear.due + bounce.due,
    },
  };
}

// Arrear first, then bounce charges, then oldest installment first; within one, fine before charges.
export function allocate(installments: InstallmentBill[], amount: number, arrearDue = 0, bounceDue = 0): Allocation[] {
  let left = amount;
  const out: Allocation[] = [];
  const arrear = Math.min(left, arrearDue);
  left -= arrear;
  const bounce = Math.min(left, bounceDue);
  left -= bounce;
  // One installment-less row carries both, so a receipt has at most one.
  if (arrear > 0 || bounce > 0) {
    out.push({ installmentId: null, charges: 0, fine: 0, ...(arrear > 0 ? { arrear } : {}), ...(bounce > 0 ? { bounce } : {}) });
  }
  for (const i of [...installments].sort((a, b) => a.number - b.number)) {
    const fine = Math.min(left, i.fineDue);
    const charges = Math.min(left - fine, i.chargesDue);
    left -= fine + charges;
    if (fine + charges > 0) out.push({ installmentId: i.installmentId, charges, fine });
  }
  if (left > 0) throw new RangeError('Amount is more than the balance due');
  return out;
}

export type HeadShare = { feeHeadId: number; name: string; refundable: boolean; amount: number };

// Exact split of one receipt's `charges` (paise) for ONE installment across that installment's fee heads.
//
// Rule (deterministic, a pure function of what was paid before): the installment's heads, net of concessions
// (and of any previous-year credit, taken off the non-refundable heads first), are laid end to end: fee heads in
// creation (id) order, then facility/transport lines, then REFUNDABLE heads LAST; money paid so far fills that
// line from the left. The order never depends on how the database happens to return the fee structure. This receipt's share of
// a head is how far the fill moved across it, so a partial payment never reaches a deposit before the fees,
// and a head is "fully paid" exactly when the fill passes its end. Anything beyond the net total (fee structure
// edited after payment, withdrawal) goes to the last head so the shares always add up to `charges`.
export function splitHeads(lines: BillLine[], refundableIds: Set<number>, before: number, charges: number): HeadShare[] {
  const nets = new Map<number, HeadShare>();
  let credit = 0;
  for (const l of lines) {
    if (l.feeHeadId === 0) { credit += -l.amount; continue; }
    const h = nets.get(l.feeHeadId);
    if (h) h.amount += l.amount;
    else nets.set(l.feeHeadId, { feeHeadId: l.feeHeadId, name: l.name, refundable: refundableIds.has(l.feeHeadId), amount: l.amount });
  }
  const rank = (h: HeadShare) => (h.refundable ? 2 : h.feeHeadId < 0 ? 1 : 0);
  const ordered = [...nets.values()].sort((a, b) => rank(a) - rank(b) || Math.abs(a.feeHeadId) - Math.abs(b.feeHeadId));
  for (const h of ordered) {
    const take = Math.min(credit, Math.max(0, h.amount));
    h.amount -= take;
    credit -= take;
  }
  let start = 0;
  const out = ordered.map((h) => {
    const net = Math.max(0, h.amount);
    const share = Math.max(0, Math.min(before + charges - start, net)) - Math.max(0, Math.min(before - start, net));
    start += net;
    return { ...h, amount: share };
  });
  const rest = charges - out.reduce((s, h) => s + h.amount, 0);
  if (rest > 0) {
    if (out.length) out[out.length - 1].amount += rest;
    else out.push({ feeHeadId: 0, name: 'Unallocated', refundable: false, amount: rest });
  }
  return out.filter((h) => h.amount > 0);
}
