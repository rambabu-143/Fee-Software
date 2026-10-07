import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { ArrearsModule } from './../src/arrears/arrears.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Arrear carry-forward, credit, and cheque/online reconciliation. Needs the seeded DB; cleans up after itself.
// Runs in its own throwaway school (own fee grid, own receipt counters) so it cannot disturb the other specs'
// "gap-free receipt numbers" and "first student" assumptions on the shared seed data.
// ArrearsModule is imported here as well so the spec works whether or not AppModule already wires it.
describe('billing core: arrears + banking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZA1-${Date.now()}`; // sorts after DEMO1-… so other specs never pick our students as their "first student"
  const day = new Date().toISOString().slice(0, 10);
  const H: Record<string, { Authorization: string }> = {};
  const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  let schoolId = 0, school2Id = 0, yearId = 0, toYearId = 0, oldYearId = 0, sectionId = 0, bankId = 0, otherBankId = 0;
  let n = 0;

  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password })).body.token}` });
  const mkUser = async (username: string, role: string, sid: number) => {
    await http().post('/api/users').set(H.admin).send({ username, password: 'a1-pass-1234', role, schoolId: sid }).expect(201);
    H[username] = await login(username, 'a1-pass-1234');
  };
  // A student in 2026-27 and/or the synthetic target year.
  async function student(opts: { from?: boolean; to?: boolean } = { from: true, to: true }) {
    const first = opts.from ? yearId : toYearId;
    const { body } = await http().post('/api/students').set(H.admin).send({
      schoolId, yearId: first, admissionNo: `${tag}-${++n}`, name: `A1 ${n}`, sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);
    const enrollment = async (y: number) => (await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: body.id, yearId: y } } })).id;
    if (opts.from && opts.to) await prisma.enrollment.create({ data: { studentId: body.id, yearId: toYearId, sectionId } });
    return { id: body.id as number, fromEnr: opts.from ? await enrollment(yearId) : 0, toEnr: opts.to ? await enrollment(toYearId) : 0 };
  }
  const bill = async (id: number, y: number, as = 'admin') => (await http().get(`/api/students/${id}/bill?yearId=${y}`).set(H[as]).expect(200)).body;
  const pay = (id: number, y: number, body: object, as = 'admin') =>
    http().post('/api/payments').set(H[as]).send({ studentId: id, yearId: y, mode: 'CASH', ...body });
  const carry = (body: object = {}, as = 'admin') =>
    http().post('/api/arrears/carry').set(H[as]).send({ schoolId, fromYearId: yearId, toYearId, ...body });
  const arrears = async (y = toYearId) => (await http().get(`/api/arrears?schoolId=${schoolId}&yearId=${y}`).set(H.admin).expect(200)).body as Array<Record<string, string>>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule, ArrearsModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    H.admin = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');

    const s1 = await prisma.school.create({ data: { code: tag.slice(0, 20), name: 'Billing core test school' } });
    const s2 = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } });
    schoolId = s1.id; school2Id = s2.id;
    // FROM year: two future installments of 1000 each (no fines), so balances don't drift with the clock.
    yearId = (await prisma.academicYear.create({ data: { label: `${tag}-F`.slice(0, 20), startDate: new Date('2090-04-01'), endDate: new Date('2091-03-31') } })).id;
    toYearId = (await prisma.academicYear.create({ data: { label: `${tag}-T`.slice(0, 20), startDate: new Date('2091-04-01'), endDate: new Date('2092-03-31') } })).id;
    oldYearId = (await prisma.academicYear.create({ data: { label: `${tag}-O`.slice(0, 20), startDate: new Date('2089-04-01'), endDate: new Date('2090-03-31') } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'S1', sortOrder: 1, sections: { create: [{ name: 'A' }] } }, include: { sections: true } });
    sectionId = std.sections[0].id;
    const head = await prisma.feeHead.create({ data: { schoolId, name: 'Tuition', type: 'MONTHLY' } });
    for (const [number, due] of [[1, '2090-06-10'], [2, '2090-09-10']] as const) {
      const inst = await prisma.installment.create({ data: { schoolId, yearId, number, label: `I${number}`, dueDate: new Date(due) } });
      await prisma.feeStructure.create({ data: { yearId, standardId: std.id, feeHeadId: head.id, installmentId: inst.id, amount: '1000.00' } });
    }
    bankId = (await prisma.bank.create({ data: { schoolId, name: `${tag} Bank` } })).id;
    otherBankId = (await prisma.bank.create({ data: { schoolId: school2Id, name: `${tag} Other` } })).id;
    await mkUser('a1acct', 'ACCOUNTANT', schoolId);
    await mkUser('a1view', 'VIEWER', schoolId);
    await mkUser('a1admin2', 'ADMIN', school2Id);
  });

  afterAll(async () => {
    const ids = (await prisma.student.findMany({ where: { schoolId } })).map((s) => s.id);
    await prisma.paymentAllocation.deleteMany({ where: { payment: { studentId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: ids } } }); // cascades arrear carries + withdrawals
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId } });
    await prisma.feeStructure.deleteMany({ where: { yearId } });
    await prisma.installment.deleteMany({ where: { schoolId } });
    await prisma.feeHead.deleteMany({ where: { schoolId } });
    await prisma.section.deleteMany({ where: { standard: { schoolId } } });
    await prisma.standard.deleteMany({ where: { schoolId } });
    await prisma.bank.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.user.deleteMany({ where: { username: { in: ['a1acct', 'a1view', 'a1admin2'] } } });
    await prisma.academicYear.deleteMany({ where: { id: { in: [yearId, toYearId, oldYearId] } } });
    await prisma.school.deleteMany({ where: { id: schoolId } });
    await app.close();
  });

  describe('arrear carry-forward', () => {
    let owing: Awaited<ReturnType<typeof student>>, settled: typeof owing, left: typeof owing;
    let owingDue = 0;

    it('carry: only ADMIN, own school only, years must differ and be ordered', async () => {
      await carry({}, 'a1acct').expect(403);
      await carry({}, 'a1view').expect(403);
      await carry({}, 'a1admin2').expect(403); // other school's admin
      await http().post('/api/arrears/carry').send({ schoolId, fromYearId: yearId, toYearId }).expect(401);
      await carry({ toYearId: yearId }).expect(400);
      await carry({ fromYearId: toYearId, toYearId: yearId }).expect(400); // backwards
      await carry({ fromYearId: 'x' }).expect(400);
      await carry({ extra: 1 }).expect(400); // whitelist
    });

    it('carries the closing balance of the previous year; skips settled, withdrawn and not-enrolled; is idempotent', async () => {
      owing = await student();
      settled = await student();
      left = await student();
      await student({ to: true }); // enrolled only in the target year: nothing to carry from
      // settled pays everything; left is withdrawn in the old year.
      const full = Number((await bill(settled.id, yearId)).totals.due);
      await pay(settled.id, yearId, { amount: full }).expect(201);
      await prisma.withdrawal.create({ data: { enrollmentId: left.fromEnr, date: new Date('2090-07-01'), reason: 'test', balanceDue: 0, excessPaid: 0, createdBy: 'a1' } });
      owingDue = Number((await bill(owing.id, yearId)).totals.due);
      expect(owingDue).toBeGreaterThan(0);

      const r = (await carry().expect(201)).body;
      expect(r).toMatchObject({ carried: 1, credits: 0, zero: 1, skippedWithdrawn: 1, skippedNotEnrolled: 1, skippedExisting: 0 });

      const rows = await arrears();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ admissionNo: expect.stringContaining(tag), source: 'COMPUTED', fromYear: expect.stringContaining('-F'), waivedAmount: '0.00' });
      expect(Number(rows[0].amount)).toBeCloseTo(owingDue, 2);
      expect(Number(rows[0].due)).toBeCloseTo(owingDue, 2);

      // Second run: nothing new. The settled student (zero) is simply re-evaluated to zero again.
      expect((await carry().expect(201)).body).toMatchObject({ carried: 0, credits: 0, zero: 1, skippedExisting: 0 });
      expect(await arrears()).toHaveLength(1);
      expect(await prisma.arrearCarry.count({ where: { enrollmentId: owing.toEnr } })).toBe(1);
    });

    it('the carried arrear shows in the next year\'s bill, with no fine, and is paid first', async () => {
      const b = await bill(owing.id, toYearId);
      expect(Number(b.arrear.amount)).toBeCloseTo(owingDue, 2);
      expect(b.totals).toMatchObject({ fine: '0.00', paid: '0.00' });
      expect(Number(b.totals.due)).toBeCloseTo(owingDue, 2);
      expect(b.installments).toEqual([]);

      await pay(owing.id, toYearId, { amount: 0.01 }).expect(201);
      const part = await pay(owing.id, toYearId, { amount: 100 }).expect(201);
      expect(part.body.allocations).toEqual([{ installment: 'Previous arrear', charges: '100.00', fine: '0.00' }]);
      await http().get(`/api/payments/${part.body.id}/pdf`).set(H.admin).expect(200).expect('Content-Type', 'application/pdf');
      await http().get(`/api/students/${owing.id}/bill.pdf?yearId=${toYearId}`).set(H.admin).expect(200).expect('Content-Type', 'application/pdf');
      const b2 = await bill(owing.id, toYearId);
      expect(Number(b2.arrear.paid)).toBeCloseTo(100.01, 2);
      expect(Number(b2.totals.due)).toBeCloseTo(owingDue - 100.01, 2);

      // The collection report counts it like any receipt.
      const coll = (await http().get(`/api/reports/collection?schoolId=${schoolId}&yearId=${toYearId}&from=${day}&to=${day}`).set(H.admin).expect(200)).body;
      expect(coll).toContainEqual({ date: day, mode: 'CASH', receipts: 2, amount: '100.01' });

      // Overpay is rejected with the arrear-inclusive balance.
      await pay(owing.id, toYearId, { amount: owingDue }).expect(400);
      await pay(owing.id, toYearId, { amount: Number((owingDue - 100.01).toFixed(2)) }).expect(201);
      expect(Number((await bill(owing.id, toYearId)).totals.due)).toBe(0);
    });

    it('PATCH: roles, validation, waive, set, and never below what is already paid', async () => {
      const e = owing.toEnr;
      const patch = (id: number, body: object, as = 'admin') => http().patch(`/api/arrears/${id}`).set(H[as]).send(body);
      await patch(e, { amount: 1, reason: 'abc' }, 'a1acct').expect(403);
      await patch(e, { amount: 1, reason: 'abc' }, 'a1admin2').expect(403);
      await patch(e, { reason: 'abc' }).expect(400); // nothing to change
      await patch(e, { amount: 1, reason: 'x' }).expect(400); // reason too short
      await patch(e, { amount: 1.234, reason: 'abc' }).expect(400); // 3 decimals
      await patch(e, { waivedAmount: -1, reason: 'abc' }).expect(400);
      await patch(999999999, { amount: 1, reason: 'abc' }).expect(404);
      await patch(e, { amount: owingDue, waivedAmount: owingDue + 1, reason: 'abc' }).expect(400); // waive more than owed
      // Fully paid already: shrinking below paid is refused (waive or lower amount).
      await patch(e, { waivedAmount: 50, reason: 'forgive' }).expect(400);
      await patch(e, { amount: 10, reason: 'oops' }).expect(400);

      // A fresh student: manual set, waive, then credit.
      const s = await student({ to: true });
      const row = (await patch(s.toEnr, { amount: 500, fromYearId: yearId, reason: 'opening balance' }).expect(200)).body;
      expect(row).toMatchObject({ amount: '500.00', source: 'MANUAL', net: '500.00' });
      expect((await bill(s.id, toYearId)).totals.due).toBe('500.00');
      await patch(s.toEnr, { waivedAmount: 200, reason: 'staff ward waiver' }).expect(200);
      expect((await bill(s.id, toYearId)).totals).toMatchObject({ charges: '300.00', due: '300.00' });
      await pay(s.id, toYearId, { amount: 300 }).expect(201);
      await patch(s.toEnr, { waivedAmount: 250, reason: 'more waiver' }).expect(400); // would drop net to 250 < 300 paid
      await patch(s.toEnr, { amount: -50, reason: 'now a credit' }).expect(400); // credit below paid
      // Waiver on a credit is nonsense.
      const c = await student({ to: true });
      await patch(c.toEnr, { amount: -100, waivedAmount: 10, fromYearId: yearId, reason: 'abc' }).expect(400);
      await patch(c.toEnr, { amount: -100, fromYearId: toYearId, reason: 'abc' }).expect(400); // from year not before the target
      await patch(c.toEnr, { amount: -100, reason: 'abc' }).expect(200); // from year defaults to the previous year
      const cb = await bill(c.id, toYearId);
      expect(cb.arrear).toMatchObject({ amount: '0.00', excess: '100.00' });
      expect(cb.totals.due).toBe('0.00');
      expect((await pay(c.id, toYearId, { amount: 1 })).status).toBe(400); // nothing due
    });

    it('credit reduces the earliest installment charges and lowers what must be paid', async () => {
      const s = await student({ from: true, to: false });
      const before = await bill(s.id, yearId);
      await http().patch(`/api/arrears/${s.fromEnr}`).set(H.admin).send({ amount: -1500, fromYearId: oldYearId, reason: 'refund credit' }).expect(200);
      const after = await bill(s.id, yearId);
      expect(before.totals.due).toBe('2000.00');
      expect(after.totals.due).toBe('500.00');
      // The credit eats the earliest installment first (1000), then half of the next.
      expect(after.installments.map((i: { due: string }) => i.due)).toEqual(['0.00', '500.00']);
      expect(after.installments[0].lines.at(-1)).toMatchObject({ name: 'Less: previous year credit', amount: '-1000.00' });
      expect(after.installments[1].lines.at(-1)).toMatchObject({ name: 'Less: previous year credit', amount: '-500.00' });
      // The student can pay exactly the reduced balance and no more.
      await pay(s.id, yearId, { amount: Number(after.totals.due) + 0.01 }).expect(400);
      await pay(s.id, yearId, { amount: Number(after.totals.due) }).expect(201);
      expect(Number((await bill(s.id, yearId)).totals.due)).toBe(0);
    });

    it('credit can be carried forward: a prepaid student gets a negative carry', async () => {
      // Withdrawn-free prepay: pay everything, then waive an installment charge by fine override is not available,
      // so use a manual credit on the old year to make the old bill closing negative.
      const s = await student();
      await http().patch(`/api/arrears/${s.fromEnr}`).set(H.admin).send({ amount: -999999, fromYearId: oldYearId, reason: 'huge credit' }).expect(200);
      const r = (await carry().expect(201)).body;
      expect(r.credits).toBeGreaterThanOrEqual(1);
      const mine = (await arrears()).find((a) => a.admissionNo.endsWith(`-${n}`));
      expect(Number(mine!.amount)).toBeLessThan(0);
      expect(mine!.source).toBe('COMPUTED');
    });

    it('concurrent carries create exactly one row per student; concurrent payments cannot overpay the arrear', async () => {
      const s = await student();
      const rs = await Promise.all([carry(), carry(), carry()]);
      rs.forEach((r) => expect(r.status).toBe(201));
      expect(await prisma.arrearCarry.count({ where: { enrollmentId: s.toEnr } })).toBe(1);

      const t = await student({ to: true });
      await http().patch(`/api/arrears/${t.toEnr}`).set(H.admin).send({ amount: 1000, fromYearId: yearId, reason: 'race test' }).expect(200);
      const out = await Promise.all([1, 2, 3, 4, 5].map(() => pay(t.id, toYearId, { amount: 300 })));
      expect(out.filter((r) => r.status === 201)).toHaveLength(3); // 900 fits, then only 100 is left
      expect(out.filter((r) => r.status === 400)).toHaveLength(2);
      const b = await bill(t.id, toYearId);
      expect(b.arrear).toMatchObject({ paid: '900.00', due: '100.00' });
      const nos = out.filter((r) => r.status === 201).map((r) => r.body.receiptNo);
      expect(new Set(nos).size).toBe(3);
    });

    it('cancelling an arrear receipt gives the due back; allocations stay consistent', async () => {
      const t = await student({ to: true });
      await http().patch(`/api/arrears/${t.toEnr}`).set(H.admin).send({ amount: 400, fromYearId: yearId, reason: 'cancel test' }).expect(200);
      const r = (await pay(t.id, toYearId, { amount: 400 }).expect(201)).body;
      expect((await bill(t.id, toYearId)).totals.due).toBe('0.00');
      await http().post(`/api/payments/${r.id}/cancel`).set(H.admin).send({ reason: 'entered twice' }).expect(201);
      expect((await bill(t.id, toYearId)).totals).toMatchObject({ due: '400.00', paid: '0.00' });
      // Refused if it would drop net below paid: the cancelled receipt no longer counts, so lowering is fine again.
      await http().patch(`/api/arrears/${t.toEnr}`).set(H.admin).send({ waivedAmount: 400, reason: 'full waiver' }).expect(200);
      expect((await bill(t.id, toYearId)).totals.due).toBe('0.00');
    });
  });

  describe('banking: cheque/online receipts and reconciliation', () => {
    let stu: Awaited<ReturnType<typeof student>>;
    beforeAll(async () => { stu = await student({ from: true, to: false }); });
    const rec = (id: number, body: object, as = 'admin') => http().post(`/api/payments/${id}/reconcile`).set(H[as]).send(body);
    const upiRow = async () =>
      ((await http().get(`/api/reports/collection?schoolId=${schoolId}&yearId=${yearId}&from=${day}&to=${day}`).set(H.admin).expect(200)).body as Array<{ mode: string; amount: string }>)
        .find((r) => r.mode === 'UPI')?.amount ?? '0.00';

    it('collect validation: cheque needs bank + cheque no; cash takes neither; bank must be this school\'s and active', async () => {
      const base = { amount: 10, reference: 'CHQ-1' };
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE' }).expect(400); // no bank, no cheque no
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', bankId }).expect(400); // no cheque no
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', chequeNo: '123456' }).expect(400); // no bank
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', bankId: otherBankId, chequeNo: '123456' }).expect(400); // other school
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', bankId: 999999999, chequeNo: '123456' }).expect(400);
      await pay(stu.id, yearId, { amount: 10, mode: 'CASH', bankId }).expect(400);
      await pay(stu.id, yearId, { amount: 10, mode: 'CASH', chequeNo: '1' }).expect(400);
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', bankId, chequeNo: '123456', chequeDate: 'not-a-date' }).expect(400);
      await prisma.bank.update({ where: { id: bankId }, data: { active: false } });
      await pay(stu.id, yearId, { ...base, mode: 'CHEQUE', bankId, chequeNo: '123456' }).expect(400); // inactive
      await prisma.bank.update({ where: { id: bankId }, data: { active: true } });
      expect(await prisma.payment.count({ where: { studentId: stu.id } })).toBe(0); // nothing leaked through
    });

    it('default statuses: cash CLEARED, everything else PENDING', async () => {
      const cash = (await pay(stu.id, yearId, { amount: 10 }).expect(201)).body;
      const upi = (await pay(stu.id, yearId, { amount: 10, mode: 'UPI', reference: 'UTR-1001' }).expect(201)).body;
      const chq = (await pay(stu.id, yearId, { amount: 10, mode: 'CHEQUE', reference: 'CHQ-77', bankId, chequeNo: '000077', chequeDate: day }).expect(201)).body;
      expect([cash.clearStatus, upi.clearStatus, chq.clearStatus]).toEqual(['CLEARED', 'PENDING', 'PENDING']);
      expect(chq).toMatchObject({ bankId, chequeNo: '000077' });
      expect(Number((await bill(stu.id, yearId)).totals.paid)).toBe(30); // pending receipts already count
    });

    it('reconcile: roles, validation and state machine', async () => {
      const p = (await pay(stu.id, yearId, { amount: 20, mode: 'UPI', reference: 'UTR-2002' }).expect(201)).body;
      await rec(p.id, { status: 'CLEARED', bankDate: day }, 'a1view').expect(403);
      await rec(p.id, { status: 'CLEARED', bankDate: day }, 'a1admin2').expect(403);
      await http().post(`/api/payments/${p.id}/reconcile`).send({ status: 'CLEARED' }).expect(401);
      await rec(p.id, { status: 'MAYBE' }).expect(400);
      await rec(p.id, { status: 'CLEARED' }).expect(400); // needs bankDate
      await rec(p.id, { status: 'CLEARED', bankDate: 'nope' }).expect(400);
      await rec(p.id, { status: 'CLEARED', bankDate: '2999-01-01' }).expect(400); // future
      await rec(p.id, { status: 'CLEARED', bankDate: '2000-01-01' }).expect(400); // before the receipt
      await rec(p.id, { status: 'CLEARED', bankDate: day, bounceCharge: 5 }).expect(400);
      await rec(p.id, { status: 'BOUNCED', bounceCharge: -1 }).expect(400);
      await rec(999999999, { status: 'CLEARED', bankDate: day }).expect(404);
      const ok = (await rec(p.id, { status: 'CLEARED', bankDate: day }, 'a1acct').expect(201)).body;
      expect(ok).toMatchObject({ clearStatus: 'CLEARED' });
      expect(ok.bankDate).toContain(day);
      await rec(p.id, { status: 'CLEARED', bankDate: day }).expect(400); // already cleared
    });

    it('cash receipts and cancelled receipts cannot be reconciled', async () => {
      const cash = (await pay(stu.id, yearId, { amount: 5 }).expect(201)).body;
      await rec(cash.id, { status: 'BOUNCED' }).expect(400);
      const u = (await pay(stu.id, yearId, { amount: 5, mode: 'UPI', reference: 'UTR-3003' }).expect(201)).body;
      await http().post(`/api/payments/${u.id}/cancel`).set(H.admin).send({ reason: 'wrong student' }).expect(201);
      await rec(u.id, { status: 'CLEARED', bankDate: day }).expect(400);
      await rec(cash.id, { status: 'BOUNCED' }).expect(400);
    });

    it('a bounced receipt stops counting everywhere, keeps its number, and cannot be bounced/cancelled again', async () => {
      const dueBefore = Number((await bill(stu.id, yearId)).totals.due);
      const upiBefore = Number(await upiRow());
      const p = (await pay(stu.id, yearId, { amount: 100, mode: 'UPI', reference: 'UTR-4004' }).expect(201)).body;
      expect(Number((await bill(stu.id, yearId)).totals.due)).toBeCloseTo(dueBefore - 100, 2);
      expect(Number(await upiRow())).toBeCloseTo(upiBefore + 100, 2);

      const b = (await rec(p.id, { status: 'BOUNCED', bounceCharge: 250 }).expect(201)).body;
      expect(b).toMatchObject({ clearStatus: 'BOUNCED', bounceCharge: '250' , receiptNo: p.receiptNo });
      expect(b.bouncedAt).toBeTruthy();
      expect(Number((await bill(stu.id, yearId)).totals.due)).toBeCloseTo(dueBefore, 2); // due restored
      expect(Number(await upiRow())).toBeCloseTo(upiBefore, 2); // report excludes it
      expect((await http().get(`/api/payments/${p.id}`).set(H.admin).expect(200)).body.receiptNo).toBe(p.receiptNo); // still listed
      await rec(p.id, { status: 'BOUNCED' }).expect(400);
      await rec(p.id, { status: 'CLEARED', bankDate: day }).expect(400);
      await http().post(`/api/payments/${p.id}/cancel`).set(H.admin).send({ reason: 'already bounced' }).expect(400);

      // The money can be collected again (a fresh receipt), and the bounced one is not double-counted.
      const again = (await pay(stu.id, yearId, { amount: 100, mode: 'UPI', reference: 'UTR-4005' }).expect(201)).body;
      expect(again.receiptNo).toBeGreaterThan(p.receiptNo);
      expect(Number((await bill(stu.id, yearId)).totals.due)).toBeCloseTo(dueBefore - 100, 2);
    });

    it('bouncing an earlier receipt is refused while a later live one exists; bouncing the later one first works', async () => {
      const s = await student({ from: true, to: false });
      const first = (await pay(s.id, yearId, { amount: 40, mode: 'UPI', reference: 'UTR-5001' }).expect(201)).body;
      const second = (await pay(s.id, yearId, { amount: 40, mode: 'UPI', reference: 'UTR-5002' }).expect(201)).body;
      const r = await rec(first.id, { status: 'BOUNCED' }).expect(400);
      expect(r.body.message).toContain(`#${second.receiptNo}`);
      await rec(second.id, { status: 'BOUNCED' }).expect(201);
      await rec(first.id, { status: 'BOUNCED' }).expect(201); // second no longer counts as "later"
      expect((await bill(s.id, yearId)).totals.paid).toBe('0.00');
    });

    it('a bounced receipt does not block backdated collection, and cancelling an earlier receipt ignores bounced later ones', async () => {
      const s = await student({ from: true, to: false });
      const a = (await pay(s.id, yearId, { amount: 30, mode: 'UPI', reference: 'UTR-6001', date: ago(6) }).expect(201)).body;
      const b = (await pay(s.id, yearId, { amount: 30, mode: 'UPI', reference: 'UTR-6002', date: ago(2) }).expect(201)).body;
      await pay(s.id, yearId, { amount: 5, date: ago(4) }).expect(400); // later receipt exists
      await rec(b.id, { status: 'BOUNCED' }).expect(201);
      await pay(s.id, yearId, { amount: 5, date: ago(4) }).expect(201); // ... until it bounces
      await http().post(`/api/payments/${a.id}/cancel`).set(H.admin).send({ reason: 'cancel earlier' }).expect(400); // the 04-22 cash receipt is later by number
    });

    it('concurrent bounces of one receipt: exactly one wins; concurrent collect + bounce keeps the bill consistent', async () => {
      const s = await student({ from: true, to: false });
      const p = (await pay(s.id, yearId, { amount: 60, mode: 'UPI', reference: 'UTR-7001' }).expect(201)).body;
      const rs = await Promise.all([rec(p.id, { status: 'BOUNCED' }), rec(p.id, { status: 'BOUNCED' }), rec(p.id, { status: 'BOUNCED' })]);
      expect(rs.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 400, 400]);
      const due0 = Number((await bill(s.id, yearId)).totals.due);
      const q = (await pay(s.id, yearId, { amount: 10, mode: 'UPI', reference: 'UTR-7002' }).expect(201)).body;
      const [x, y] = await Promise.all([rec(q.id, { status: 'BOUNCED' }), pay(s.id, yearId, { amount: 10 })]);
      expect(x.status).toBe(201);
      expect(y.status).toBe(201);
      expect(Number((await bill(s.id, yearId)).totals.due)).toBeCloseTo(due0 - 10, 2); // only the cash receipt counts
    });
  });
});
