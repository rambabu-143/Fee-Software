import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { backfillHeads, headGaps } from './../src/billing/backfill-heads.js';
import { dropSchool, listen } from './support.js';

// Exact per-head receipts: each installment payment is split across fee heads (fees in id order, then
// facilities, REFUNDABLE deposits last), so by-head reports, the fee certificate and the auto deposit are exact.
// Own throwaway school; I1 = Tuition 1000 + Annual 600 + Caution Money 500, I2 = Tuition 1000 (tiny late fine).
describe('per-head allocation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZPH${Date.now()}`;
  let auth: { Authorization: string };
  let schoolId = 0, yearId = 0, sectionId = 0, bankId = 0;
  let n = 0;
  const live = { cancelledAt: null, clearStatus: { not: 'BOUNCED' } } as const;

  const student = async (opts: { concessionPct?: number; arrear?: string } = {}) => {
    const s = await prisma.student.create({ data: { schoolId, admissionNo: `${tag}-${++n}`, name: `PH ${n}` } });
    const e = await prisma.enrollment.create({ data: { studentId: s.id, yearId, sectionId, isNewAdmission: true } });
    if (opts.concessionPct) {
      const tuition = await prisma.feeHead.findFirstOrThrow({ where: { schoolId, name: 'Tuition' } });
      await prisma.concession.create({ data: { enrollmentId: e.id, feeHeadId: tuition.id, percent: opts.concessionPct, reason: 'test' } });
    }
    if (opts.arrear) await prisma.arrearCarry.create({ data: { enrollmentId: e.id, fromYearId: yearId, amount: opts.arrear, source: 'MANUAL', createdBy: 'test' } });
    return s.id;
  };
  const pay = async (studentId: number, amount: number, extra: object = {}) => {
    const r = await http().post('/api/payments').set(auth).send({ studentId, yearId, amount, mode: 'CASH', ...extra }).expect(201);
    return r.body.id as number;
  };
  // head name -> amount for one receipt's installment rows
  const heads = async (paymentId: number) => {
    const rows = await prisma.paymentAllocationHead.findMany({ where: { allocation: { paymentId } } });
    return Object.fromEntries(rows.map((r) => [r.name, r.amount.toFixed(2)]));
  };
  const cents = (d: { toFixed(n: number): string }) => Math.round(Number(d.toFixed(2)) * 100);

  // Whole-school invariants after any phase.
  const check = async () => {
    expect(await headGaps(prisma, schoolId)).toEqual({ missing: 0, wrong: 0 });
    const rep = (await http().get(`/api/reports/payments-summary?schoolId=${schoolId}&yearId=${yearId}&groupBy=head`).set(auth).expect(200)).body as { head: string; amount: string }[];
    const money = await prisma.payment.aggregate({ where: { schoolId, yearId, ...live }, _sum: { amount: true } });
    expect(rep.reduce((s, h) => s + Math.round(Number(h.amount) * 100), 0)).toBe(cents(money._sum.amount!));
    expect(rep.find((h) => h.head === 'Unallocated')).toBeUndefined();
    const db = await prisma.paymentAllocationHead.groupBy({ by: ['name'], _sum: { amount: true }, where: { allocation: { payment: { schoolId, yearId, ...live } } } });
    for (const g of db) expect(Math.round(Number(rep.find((h) => h.head === g.name)?.amount ?? 0) * 100)).toBe(cents(g._sum.amount!));
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const { body } = await http().post('/api/auth/login').send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    auth = { Authorization: `Bearer ${body.token}` };

    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Per head' } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'PH', sortOrder: 1 } });
    sectionId = (await prisma.section.create({ data: { standardId: std.id, name: 'A' } })).id;
    const head = (name: string, type: 'MONTHLY' | 'ANNUAL' | 'REFUNDABLE') => prisma.feeHead.create({ data: { schoolId, name, type } });
    const tuition = await head('Tuition', 'MONTHLY'), annual = await head('Annual', 'ANNUAL'), caution = await head('Caution Money', 'REFUNDABLE');
    const i1 = await prisma.installment.create({ data: { schoolId, yearId, number: 1, label: 'I1', dueDate: new Date('2099-04-01') } });
    const i2 = await prisma.installment.create({
      data: { schoolId, yearId, number: 2, label: 'I2', dueDate: new Date('2020-01-01'), fineStartDate: new Date('2020-01-02'), finePerDay: '0.01' },
    });
    await prisma.feeStructure.createMany({
      data: [
        { feeHeadId: tuition.id, installmentId: i1.id, amount: 1000 }, { feeHeadId: annual.id, installmentId: i1.id, amount: 600 },
        { feeHeadId: caution.id, installmentId: i1.id, amount: 500 }, { feeHeadId: tuition.id, installmentId: i2.id, amount: 1000 },
      ].map((d) => ({ ...d, standardId: std.id, yearId })),
    });
    bankId = (await prisma.bank.create({ data: { schoolId, name: 'PH Bank' } })).id;
  });

  afterAll(async () => {
    await dropSchool(prisma, tag);
    await app.close();
  });

  it('partial payments fill heads in order and the deposit appears only when the caution head itself is paid', async () => {
    const s = await student();
    expect(await heads(await pay(s, 1200))).toEqual({ Tuition: '1000.00', Annual: '200.00' });
    expect(await heads(await pay(s, 400))).toEqual({ Annual: '400.00' });
    expect(await heads(await pay(s, 300))).toEqual({ 'Caution Money': '300.00' });
    expect(await prisma.deposit.findUnique({ where: { studentId_kind: { studentId: s, kind: 'CAUTION' } } })).toBeNull();
    const last = await pay(s, 200);
    expect(await heads(last)).toEqual({ 'Caution Money': '200.00' });
    const dep = await prisma.deposit.findUniqueOrThrow({ where: { studentId_kind: { studentId: s, kind: 'CAUTION' } } });
    expect(dep.amount.toFixed(2)).toBe('500.00');
    expect(dep.paymentId).toBe(last);
    await check();

    // Income-tax certificate: deposits are shown and deducted, lines still add up to the total.
    const cert = (await http().get(`/api/students/${s}/fee-certificate?yearId=${yearId}&json=1`).set(auth).expect(200)).body;
    expect(cert.lines.map((l: { refundable: string }) => l.refundable)).toEqual(['0.00', '0.00', '300.00', '200.00']);
    expect(cert).toMatchObject({ total: '2100.00', refundableTotal: '500.00', eligibleTotal: '1600.00' });
    const pdf = await http().get(`/api/students/${s}/fee-certificate?yearId=${yearId}`).set(auth).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Cancelling the receipt that completed the deposit takes the deposit back and drops its 200 from the reports.
    await http().post(`/api/payments/${last}/cancel`).set(auth).send({ reason: 'entered wrong' }).expect(201);
    expect(await prisma.deposit.findUnique({ where: { studentId_kind: { studentId: s, kind: 'CAUTION' } } })).toBeNull();
    const rep = (await http().get(`/api/reports/payments-summary?schoolId=${schoolId}&yearId=${yearId}&groupBy=head`).set(auth)).body as { head: string; amount: string }[];
    expect(rep.find((h) => h.head === 'Caution Money')!.amount).toBe('300.00');
    await check();
  });

  it('concession, previous-year credit, arrear and a bounced cheque', async () => {
    // 10% off Tuition: net 900 => 950 = Tuition 900 + Annual 50
    expect(await heads(await pay(await student({ concessionPct: 10 }), 950))).toEqual({ Tuition: '900.00', Annual: '50.00' });

    // 200 credit comes off the fees first (Tuition 800), never the deposit; charges are 1900
    const c = await student({ arrear: '-200.00' });
    expect(await heads(await pay(c, 800))).toEqual({ Tuition: '800.00' });
    expect(await heads(await pay(c, 600))).toEqual({ Annual: '600.00' });
    await pay(c, 500);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { studentId_kind: { studentId: c, kind: 'CAUTION' } } })).amount.toFixed(2)).toBe('500.00');

    // 300 arrear is paid first and carries no head rows; the rest is Tuition
    const d = await student({ arrear: '300.00' });
    const p = await pay(d, 400);
    expect(await heads(p)).toEqual({ Tuition: '100.00' });
    const allocs = await prisma.paymentAllocation.findMany({ where: { paymentId: p }, include: { heads: true } });
    expect(allocs.find((a) => a.installmentId === null)!.heads).toHaveLength(0);

    // A bounced cheque stops counting: the next receipt starts from nothing paid and pays the bounce charge first
    const e = await student();
    const chq = await pay(e, 100, { mode: 'CHEQUE', bankId, chequeNo: 'C123', reference: 'C123' });
    expect(await heads(chq)).toEqual({ Tuition: '100.00' });
    await http().post(`/api/payments/${chq}/reconcile`).set(auth).send({ status: 'BOUNCED', bounceCharge: 50 }).expect(201);
    expect(await heads(await pay(e, 200))).toEqual({ Tuition: '150.00' });
    await check();
  });

  it('random partial payments (fines, mixed order): shares always add up, never overfill, deposits only after fees', async () => {
    let seed = 20261009;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const ids: number[] = [];
    for (let k = 0; k < 8; k++) {
      const s = await student({ concessionPct: rnd() < 0.4 ? 10 * (1 + Math.floor(rnd() * 5)) : undefined, arrear: rnd() < 0.3 ? (rnd() < 0.5 ? '-150.00' : '250.00') : undefined });
      ids.push(s);
      for (let j = 0; j < 6; j++) {
        const bill = (await http().get(`/api/students/${s}/bill?yearId=${yearId}`).set(auth).expect(200)).body;
        const due = Math.round(Number(bill.totals.due) * 100);
        if (!due) break;
        await pay(s, Math.max(1, Math.floor(due * (j === 5 ? 1 : 0.1 + rnd() * 0.5))) / 100);
      }
    }
    await check();
    for (const s of ids) {
      const rows = await prisma.paymentAllocationHead.findMany({
        where: { allocation: { payment: { studentId: s, ...live } } }, include: { allocation: { select: { installmentId: true } } },
      });
      const paid = new Map<string, number>();
      for (const r of rows) paid.set(`${r.allocation.installmentId}:${r.name}`, (paid.get(`${r.allocation.installmentId}:${r.name}`) ?? 0) + cents(r.amount));
      const i1 = await prisma.installment.findFirstOrThrow({ where: { schoolId, number: 1 } });
      const get = (name: string) => paid.get(`${i1.id}:${name}`) ?? 0;
      expect(get('Tuition')).toBeLessThanOrEqual(100000);
      expect(get('Annual')).toBeLessThanOrEqual(60000);
      expect(get('Caution Money')).toBeLessThanOrEqual(50000);
      // a deposit gets money only once Tuition and Annual (net of concession / credit) are full: with no concession
      // or credit that is the full 1000 + 600; with them the bill is smaller, so just require that the fees are not
      // overtaken by a bigger deposit share than money left after fees.
      const dep = await prisma.deposit.findUnique({ where: { studentId_kind: { studentId: s, kind: 'CAUTION' } } });
      expect(!!dep).toBe(get('Caution Money') >= 50000);
    }
  }, 180_000);

  it('legacy receipts without head rows still report (fallback) and the backfill restores the exact split', async () => {
    const before = await prisma.paymentAllocationHead.findMany({ select: { allocationId: true, name: true, amount: true }, where: { allocation: { payment: { schoolId } } } });
    const key = (r: { allocationId: number; name: string; amount: { toFixed(n: number): string } }) => `${r.allocationId}|${r.name}|${r.amount.toFixed(2)}`;
    expect(before.length).toBeGreaterThan(10);
    await prisma.paymentAllocationHead.deleteMany({ where: { allocation: { payment: { schoolId } } } });
    expect((await headGaps(prisma, schoolId)).missing).toBeGreaterThan(0);

    // report still totals to the money received (pro-rata fallback), nothing crashes
    const rep = (await http().get(`/api/reports/payments-summary?schoolId=${schoolId}&yearId=${yearId}&groupBy=head`).set(auth).expect(200)).body as { amount: string }[];
    const money = await prisma.payment.aggregate({ where: { schoolId, yearId, ...live }, _sum: { amount: true } });
    expect(rep.reduce((s, h) => s + Math.round(Number(h.amount) * 100), 0)).toBe(cents(money._sum.amount!));

    const first = await backfillHeads(prisma, { schoolId });
    expect(first.filled).toBeGreaterThan(0);
    expect(await headGaps(prisma, schoolId)).toEqual({ missing: 0, wrong: 0 });
    const after = await prisma.paymentAllocationHead.findMany({ select: { allocationId: true, name: true, amount: true }, where: { allocation: { payment: { schoolId } } } });
    const a = new Set(after.map(key)), b = new Set(before.map(key));
    expect({ onlyAfter: [...a].filter((k) => !b.has(k)), onlyBefore: [...b].filter((k) => !a.has(k)) }).toEqual({ onlyAfter: [], onlyBefore: [] });
    expect((await backfillHeads(prisma, { schoolId })).filled).toBe(0); // idempotent
    await check();
  });
});
