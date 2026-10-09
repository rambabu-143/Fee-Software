import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { dropSchool, listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Bounce charge as real money owed + deposits (auto-created from refundable heads, status kept in step with vouchers).
// Own throwaway school with future-dated installments and no fines, so every amount below is exact.
//   Installment 1: Tuition 1000, Caution Money 500, Advance Fee 2000, Library Deposit 100 (new admissions: 3600)
//   Installment 2: Tuition 1000.   Continuing students owe tuition only: 2000.
describe('money fixes: bounce charge + deposits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZFB${Date.now()}`.slice(0, 20);
  let H: { Authorization: string };
  let schoolId = 0, yearId = 0, sectionId = 0, bankId = 0, advanceHeadId = 0, n = 0;

  async function student(newAdmission: boolean) {
    const { body } = await http().post('/api/students').set(H).send({
      schoolId, yearId, admissionNo: `${tag}-${++n}`, name: `FB ${n}`, sectionId, isNewAdmission: newAdmission, optionalHeadIds: [],
    }).expect(201);
    const enr = await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: body.id, yearId } } });
    return { id: body.id as number, enr: enr.id };
  }
  const bill = async (id: number) => (await http().get(`/api/students/${id}/bill?yearId=${yearId}`).set(H).expect(200)).body;
  const pay = (id: number, amount: number, extra: object = {}) =>
    http().post('/api/payments').set(H).send({ studentId: id, yearId, amount, mode: 'CASH', ...extra });
  const cheque = (id: number, amount: number) => pay(id, amount, { mode: 'CHEQUE', reference: 'CHQ-1234', bankId, chequeNo: `${100000 + ++n}` });
  const bounce = (paymentId: number, bounceCharge?: number) =>
    http().post(`/api/payments/${paymentId}/reconcile`).set(H).send({ status: 'BOUNCED', ...(bounceCharge !== undefined ? { bounceCharge } : {}) });
  const cancel = (paymentId: number) => http().post(`/api/payments/${paymentId}/cancel`).set(H).send({ reason: 'test cancel' });
  const deposits = async (studentId?: number) => {
    const rows = (await http().get(`/api/deposits?schoolId=${schoolId}&yearId=${yearId}`).set(H).expect(200)).body as Array<Record<string, string | number | null>>;
    return studentId ? rows.filter((d) => d.studentId === studentId) : rows;
  };
  const voucher = (enrollmentId: number, kind: string, amount: number) =>
    http().post('/api/vouchers').set(H).send({ schoolId, yearId, enrollmentId, kind, amount, date: new Date().toISOString().slice(0, 10), mode: 'CASH' });
  // Invariant: live receipts add up to their own allocations, per receipt.
  async function conserved(studentId: number) {
    const live = await prisma.payment.findMany({ where: { studentId, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } }, include: { allocations: true } });
    for (const p of live) {
      const parts = p.allocations.reduce((s, a) => s + Number(a.charges) + Number(a.fine) + Number(a.arrear) + Number(a.bounce), 0);
      expect(parts.toFixed(2)).toBe(Number(p.amount).toFixed(2));
    }
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const login = await http().post('/api/auth/login').send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    H = { Authorization: `Bearer ${login.body.token}` };

    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Money fixes test school' } })).id;
    yearId = (await prisma.academicYear.create({ data: { label: `${tag}-Y`.slice(0, 20), startDate: new Date('2090-04-01'), endDate: new Date('2091-03-31') } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'S1', sortOrder: 1, sections: { create: [{ name: 'A' }] } }, include: { sections: true } });
    sectionId = std.sections[0].id;
    const head = (name: string, type: 'MONTHLY' | 'REFUNDABLE') => prisma.feeHead.create({ data: { schoolId, name, type } });
    const tuition = await head('Tuition', 'MONTHLY');
    const caution = await head('Caution Money', 'REFUNDABLE');
    const advance = await head('Advance Fee', 'REFUNDABLE');
    const library = await head('Library Deposit', 'REFUNDABLE'); // refundable but neither advance nor caution: no deposit
    advanceHeadId = advance.id;
    const i1 = await prisma.installment.create({ data: { schoolId, yearId, number: 1, label: 'I1', dueDate: new Date('2090-06-10') } });
    const i2 = await prisma.installment.create({ data: { schoolId, yearId, number: 2, label: 'I2', dueDate: new Date('2090-09-10') } });
    const fee = (feeHeadId: number, installmentId: number, amount: string) =>
      prisma.feeStructure.create({ data: { yearId, standardId: std.id, feeHeadId, installmentId, amount } });
    await fee(tuition.id, i1.id, '1000.00'); await fee(tuition.id, i2.id, '1000.00');
    await fee(caution.id, i1.id, '500.00'); await fee(advance.id, i1.id, '2000.00'); await fee(library.id, i1.id, '100.00');
    bankId = (await prisma.bank.create({ data: { schoolId, name: `${tag} Bank` } })).id;
  });

  afterAll(async () => {
    await dropSchool(prisma, tag);
    await prisma.arrearCarry.deleteMany({ where: { fromYearId: yearId } }); // a carry pointing at our year would block its delete
    await prisma.academicYear.deleteMany({ where: { id: yearId } });
    await app.close();
  });

  describe('bounce charge', () => {
    it('is owed on the bill as its own line, no fine, folded into the totals, dues and overdue', async () => {
      const s = await student(false);
      expect((await bill(s.id)).totals.due).toBe('2000.00');
      const chq = (await cheque(s.id, 1000).expect(201)).body;
      expect((await bill(s.id)).totals.paid).toBe('1000.00'); // a pending cheque counts as paid
      await http().post(`/api/payments/${chq.id}/reconcile`).set(H).send({ status: 'CLEARED', bankDate: new Date().toISOString().slice(0, 10), bounceCharge: 5 }).expect(400);
      await bounce(chq.id, 150).expect(201);

      const b = await bill(s.id);
      expect(b.bounce).toEqual({ amount: '150.00', paid: '0.00', due: '150.00', items: [{ receiptNo: chq.receiptNo, amount: '150.00' }] });
      expect(b.totals).toEqual({ charges: '2150.00', fine: '0.00', paid: '0.00', due: '2150.00' });

      const dues = (await http().get(`/api/reports/dues?schoolId=${schoolId}&yearId=${yearId}`).set(H).expect(200)).body as Array<Record<string, string | number>>;
      const row = dues.find((d) => d.studentId === s.id)!;
      expect(row.due).toBe('2150.00');
      expect(row.overdue).toBe('150.00'); // installments are in 2090; only the bounce charge is already overdue
    });

    it('is paid first (after arrear), shows on the receipt, and balances every invariant', async () => {
      const s = await student(false);
      const chq = (await cheque(s.id, 1000).expect(201)).body;
      await bounce(chq.id, 150).expect(201);
      await pay(s.id, 2151).expect(400); // more than 2150 owed
      const p = (await pay(s.id, 400).expect(201)).body;
      expect(p.allocations).toEqual([
        { installment: 'Bounce charge', charges: '150.00', fine: '0.00' },
        { installment: 'I1', charges: '250.00', fine: '0.00' },
      ]);
      let b = await bill(s.id);
      expect(b.bounce).toMatchObject({ paid: '150.00', due: '0.00' });
      expect(b.totals).toEqual({ charges: '2150.00', fine: '0.00', paid: '400.00', due: '1750.00' });
      await pay(s.id, 1750).expect(201);
      b = await bill(s.id);
      expect(b.totals.due).toBe('0.00');
      await conserved(s.id);

      const pdf = await http().get(`/api/payments/${p.id}/pdf`).set(H).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const billPdf = await http().get(`/api/students/${s.id}/bill.pdf?yearId=${yearId}`).set(H).expect(200);
      expect(billPdf.headers['content-type']).toContain('application/pdf');

      // by-head report has its own bucket, and the fee certificate still adds up
      const heads = (await http().get(`/api/reports/payments-summary?schoolId=${schoolId}&yearId=${yearId}&groupBy=head`).set(H).expect(200)).body as Array<{ head: string; amount: string }>;
      expect(Number(heads.find((h) => h.head === 'Bounce charge')!.amount)).toBeGreaterThanOrEqual(150);
      const cert = (await http().get(`/api/students/${s.id}/fee-certificate?yearId=${yearId}&json=1`).set(H).expect(200)).body;
      for (const l of cert.lines) expect((Number(l.charges) + Number(l.fine)).toFixed(2)).toBe(Number(l.amount).toFixed(2));
    });

    it('cancelling the receipt that paid it puts the charge back; a bounce charge of 0 or none adds nothing', async () => {
      const s = await student(false);
      const chq = (await cheque(s.id, 500).expect(201)).body;
      await bounce(chq.id, 0).expect(201);
      expect((await bill(s.id)).bounce.amount).toBe('0.00');
      const chq2 = (await cheque(s.id, 500).expect(201)).body;
      await bounce(chq2.id, 75.5).expect(201);
      expect((await bill(s.id)).bounce.due).toBe('75.50');
      const p = (await pay(s.id, 75.5).expect(201)).body;
      expect((await bill(s.id)).bounce.due).toBe('0.00');
      await cancel(p.id).expect(201);
      expect((await bill(s.id)).bounce).toMatchObject({ paid: '0.00', due: '75.50' });
      await conserved(s.id);
    });

    it('parallel collections never overpay arrears-style dues (exactly 5 of 6 succeed)', async () => {
      const s = await student(false);
      const chq = (await cheque(s.id, 1000).expect(201)).body;
      await bounce(chq.id, 150).expect(201); // owes 2150
      const res = await Promise.all(Array.from({ length: 6 }, () => pay(s.id, 400)));
      expect(res.filter((r) => r.status === 201)).toHaveLength(5);
      expect(res.filter((r) => r.status === 400)).toHaveLength(1);
      const b = await bill(s.id);
      expect(b.bounce).toMatchObject({ paid: '150.00', due: '0.00' });
      expect(b.totals.due).toBe('150.00');
      await conserved(s.id);
    });
  });

  describe('deposits', () => {
    it('are created once the installment holding the refundable head is fully paid, at the net amount', async () => {
      const s = await student(true);
      expect((await bill(s.id)).totals.due).toBe('4600.00');
      await pay(s.id, 1000).expect(201);
      expect(await deposits(s.id)).toHaveLength(0);
      const full = (await pay(s.id, 2600).expect(201)).body;
      const d = await deposits(s.id);
      expect(d.map((x) => [x.kind, x.amount, x.status, x.paymentId]).sort()).toEqual([
        ['ADVANCE', '2000.00', 'HELD', full.id], ['CAUTION', '500.00', 'HELD', full.id], // Library Deposit makes none
      ]);
      await pay(s.id, 1000).expect(201); // later receipts don't duplicate them
      expect(await deposits(s.id)).toHaveLength(2);
    });

    it('use the amount after a concession, skip continuing students, and keep a manual deposit', async () => {
      const a = await student(true);
      await prisma.concession.create({ data: { enrollmentId: a.enr, feeHeadId: advanceHeadId, percent: '50.00', reason: 'test' } });
      await pay(a.id, 2600).expect(201); // I1 = 1000 + 500 + (2000 - 50%) + 100
      expect((await deposits(a.id)).find((x) => x.kind === 'ADVANCE')!.amount).toBe('1000.00');

      const cont = await student(false);
      await pay(cont.id, 2000).expect(201);
      expect(await deposits(cont.id)).toHaveLength(0);

      const m = await student(true);
      await http().post('/api/deposits').set(H).send({ studentId: m.id, kind: 'CAUTION', amount: 450, receivedYearId: yearId }).expect(201);
      await pay(m.id, 3600).expect(201);
      const rows = await deposits(m.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((x) => x.kind === 'CAUTION')).toMatchObject({ amount: '450.00', paymentId: null }); // untouched
    });

    it('go with the receipt: cancel or bounce voids them, unless they were already refunded', async () => {
      const s = await student(true);
      const p = (await pay(s.id, 3600).expect(201)).body;
      expect(await deposits(s.id)).toHaveLength(2);
      await cancel(p.id).expect(201);
      expect(await deposits(s.id)).toHaveLength(0);
      const again = (await pay(s.id, 3600).expect(201)).body;
      expect(await deposits(s.id)).toHaveLength(2);

      // a voucher payout blocks cancelling the receipt
      await voucher(s.enr, 'CAUTION_REFUND', 100).expect(201);
      await cancel(again.id).expect(400);
      expect(await deposits(s.id)).toHaveLength(2);

      // a bounced cheque takes its deposits back too
      const b = await student(true);
      const chq = (await cheque(b.id, 3600).expect(201)).body;
      expect(await deposits(b.id)).toHaveLength(2);
      await bounce(chq.id).expect(201);
      expect(await deposits(b.id)).toHaveLength(0);
      expect((await bill(b.id)).totals.paid).toBe('0.00');

      // refunded deposit: the bounce is refused until the refund is undone
      const c = await student(true);
      const chq2 = (await cheque(c.id, 3600).expect(201)).body;
      const adv = (await deposits(c.id)).find((x) => x.kind === 'ADVANCE')!;
      await http().post(`/api/deposits/${adv.id}/refund`).set(H).send({ refundAmount: 2000, mode: 'CASH', date: new Date().toISOString().slice(0, 10) }).expect(201);
      await bounce(chq2.id).expect(400);
    });

    it('become REFUNDED when vouchers pay them out in full, and revert when one is cancelled; list and compare agree', async () => {
      const s = await student(true);
      await pay(s.id, 3600).expect(201);
      const status = async () => (await deposits(s.id)).find((x) => x.kind === 'CAUTION')!;

      const v1 = (await voucher(s.enr, 'CAUTION_REFUND', 200).expect(201)).body;
      expect(await status()).toMatchObject({ status: 'HELD', refundAmount: null });
      await voucher(s.enr, 'CAUTION_REFUND', 301).expect(400); // more than the 300 left
      // the refund decision can't be lower than what vouchers already paid
      const d = await status();
      await http().post(`/api/deposits/${d.id}/refund`).set(H).send({ refundAmount: 100, deduction: 400, mode: 'CASH', date: new Date().toISOString().slice(0, 10) }).expect(400);

      const v2 = (await voucher(s.enr, 'CAUTION_REFUND', 300).expect(201)).body;
      expect(await status()).toMatchObject({ status: 'REFUNDED', refundAmount: '500.00', deduction: '0.00' });
      await voucher(s.enr, 'CAUTION_REFUND', 1).expect(400);
      await http().post(`/api/deposits/${d.id}/refund`).set(H).send({ refundAmount: 500, mode: 'CASH', date: new Date().toISOString().slice(0, 10) }).expect(400); // already refunded

      // /deposits and the compare report tell the same story
      const all = await deposits();
      const compare = (await http().get(`/api/deposits/report/compare?schoolId=${schoolId}&yearIds=${yearId}`).set(H).expect(200)).body as Array<{ kind: string; status: string; count: number; amount: string }>;
      for (const c of compare) {
        const rows = all.filter((x) => x.kind === c.kind && x.status === c.status);
        expect(c.count).toBe(rows.length);
        expect(c.amount).toBe(rows.reduce((t, x) => t + Number(x.amount), 0).toFixed(2));
      }

      await http().post(`/api/vouchers/${v2.id}/cancel`).set(H).send({ reason: 'wrong amount' }).expect(201);
      expect(await status()).toMatchObject({ status: 'HELD', refundAmount: null, refundedAt: null });
      await http().post(`/api/vouchers/${v2.id}/cancel`).set(H).send({ reason: 'again' }).expect(400);
      await voucher(s.enr, 'CAUTION_REFUND', 300).expect(201); // can be paid out again
      expect((await status()).status).toBe('REFUNDED');
      expect(v1.amount).toBe('200.00');
    });

    it('a refund decided up front still caps vouchers at the refunded amount (no status flip)', async () => {
      const s = await student(true);
      await pay(s.id, 3600).expect(201);
      const adv = (await deposits(s.id)).find((x) => x.kind === 'ADVANCE')!;
      await http().post(`/api/deposits/${adv.id}/refund`).set(H).send({ refundAmount: 1500, deduction: 500, mode: 'CASH', date: new Date().toISOString().slice(0, 10) }).expect(201);
      await voucher(s.enr, 'ADVANCE_REFUND', 1501).expect(400);
      const v = (await voucher(s.enr, 'ADVANCE_REFUND', 1500).expect(201)).body;
      expect((await deposits(s.id)).find((x) => x.kind === 'ADVANCE')).toMatchObject({ status: 'REFUNDED', refundAmount: '1500.00', deduction: '500.00' });
      await http().post(`/api/vouchers/${v.id}/cancel`).set(H).send({ reason: 'redo it' }).expect(201);
      expect((await deposits(s.id)).find((x) => x.kind === 'ADVANCE')!.status).toBe('REFUNDED'); // the decision stands
    });
  });

  it('receipt numbers stay gap-free in this school and nothing is double counted', async () => {
    const nums = (await prisma.payment.findMany({ where: { schoolId, yearId }, select: { receiptNo: true }, orderBy: { receiptNo: 'asc' } })).map((p) => p.receiptNo);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    const live = await prisma.payment.aggregate({ _sum: { amount: true }, where: { schoolId, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } } });
    const alloc = await prisma.paymentAllocation.aggregate({
      _sum: { charges: true, fine: true, arrear: true, bounce: true }, where: { payment: { schoolId, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } } },
    });
    const total = Object.values(alloc._sum).reduce((t, v) => t + Number(v ?? 0), 0);
    expect(total.toFixed(2)).toBe(Number(live._sum.amount).toFixed(2));
  });
});
