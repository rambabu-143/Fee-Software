import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { DepositsModule } from './../src/deposits/deposits.module.js';
import { VouchersModule } from './../src/vouchers/vouchers.module.js';
import { BanksModule } from './../src/banks/banks.module.js';
import { RenewalsModule } from './../src/renewals/renewals.module.js';

// Deposits, vouchers, bank master + banking/fine reports and transport renewals. Needs the seeded demo DB.

describe('money extras: deposits, vouchers, banks, renewals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const RUN = Date.now().toString(36);
  const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
  const TODAY = ymd();
  const P = `MA${RUN}`;
  const hdr: Record<string, Record<string, string>> = { none: {} };
  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });
  type M = 'get' | 'post' | 'patch' | 'delete';
  const call = (who: string, m: M, path: string, body?: object) => {
    const t = http()[m](`/api${path}`).set(hdr[who]);
    return body ? t.send(body) : t;
  };
  const paise = (v: string) => Math.round(Number(v) * 100);

  let s1: number, s2: number, yearId: number, sectionId: number, nextYearId: number;
  let n = 0;
  const mkStudent = async (schoolId = s1, sec = sectionId, year = yearId) => {
    n += 1;
    const st = await prisma.student.create({
      data: { schoolId, admissionNo: `${P}-${n}`, name: `MA Student ${n}`, enrollments: { create: { yearId: year, sectionId: sec } } },
      include: { enrollments: true },
    });
    return { id: st.id, admissionNo: st.admissionNo, enrollmentId: st.enrollments[0].id };
  };

  async function cleanup() {
    const stu = { student: { admissionNo: { startsWith: 'MA' } } };
    await prisma.voucher.deleteMany({ where: { enrollment: stu } });
    await prisma.deposit.deleteMany({ where: stu });
    await prisma.paymentAllocation.deleteMany({ where: { payment: stu } });
    await prisma.payment.deleteMany({ where: stu });
    await prisma.enrollment.deleteMany({ where: stu });
    const mine = { year: { label: { startsWith: 'MA-' } } };
    await prisma.feeStructure.deleteMany({ where: mine });
    await prisma.installment.deleteMany({ where: mine });
    await prisma.receiptCounter.deleteMany({ where: { yearId: { in: (await prisma.academicYear.findMany({ where: { label: { startsWith: 'MA-' } } })).map((y) => y.id) } } });
    await prisma.voucherCounter.deleteMany({ where: { yearId: { in: (await prisma.academicYear.findMany({ where: { label: { startsWith: 'MA-' } } })).map((y) => y.id) } } });
    await prisma.student.deleteMany({ where: { admissionNo: { startsWith: 'MA' }, name: { startsWith: 'MA Student' } } });
    await prisma.stop.deleteMany({ where: { name: { startsWith: 'MA-' } } });
    await prisma.facility.deleteMany({ where: { name: { startsWith: 'MA-' } } });
    await prisma.bank.deleteMany({ where: { name: { startsWith: 'MA Bank' } } });
    await prisma.academicYear.deleteMany({ where: { label: { startsWith: 'MA-' } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'zma-' } } });
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule, DepositsModule, VouchersModule, BanksModule, RenewalsModule],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    await cleanup();

    hdr.root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    [s1, s2] = (await Promise.all(['DEMO1', 'DEMO2'].map((code) => prisma.school.findUniqueOrThrow({ where: { code } })))).map((s) => s.id);
    const seeded = await prisma.enrollment.findFirstOrThrow({
      where: { year: { isCurrent: true }, student: { schoolId: s1 } }, include: { section: true },
    });
    sectionId = seeded.sectionId;
    // Own year with two overdue installments (fine accrues) and a Tuition grid for the seeded student's class.
    yearId = (await prisma.academicYear.create({ data: { label: `MA-${RUN}-a`, startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31') } })).id;
    nextYearId = (await prisma.academicYear.create({ data: { label: `MA-${RUN}-b`, startDate: new Date('2027-04-01'), endDate: new Date('2028-03-31') } })).id;
    const head = await prisma.feeHead.findFirstOrThrow({ where: { schoolId: s1, name: 'Tuition Fee' } });
    for (const [number, due] of [[1, '2026-04-10'], [2, '2026-07-10']] as const) {
      const inst = await prisma.installment.create({
        data: { schoolId: s1, yearId, number, label: `MA ${number}`, dueDate: new Date(due), fineStartDate: new Date(due), finePerDay: '10.00' },
      });
      await prisma.feeStructure.create({ data: { yearId, standardId: seeded.section.standardId, feeHeadId: head.id, installmentId: inst.id, amount: '5000.00' } });
    }

    for (const [key, role, schoolId] of [['admin1', 'ADMIN', s1], ['acc1', 'ACCOUNTANT', s1], ['view1', 'VIEWER', s1], ['admin2', 'ADMIN', s2]] as const) {
      await call('root', 'post', '/users', { username: `zma-${key}`, password: 'password1', role, schoolId }).expect(201);
      hdr[key] = await login(`zma-${key}`, 'password1');
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ------------------------------------------------------------------ authz matrix
  // Guards run before body validation, so: forbidden role -> 403, allowed role with an empty body -> 400.
  it('authn/authz matrix', async () => {
    const st = await mkStudent();
    const dep = await prisma.deposit.create({ data: { studentId: st.id, kind: 'CAUTION', amount: '500.00', receivedYearId: yearId, createdBy: 'test' } });
    const q = `schoolId=${s1}&yearId=${yearId}`;
    const empty = {};
    // [method, path, body, {who: expected}]
    const cases: [M, string, object | undefined, Record<string, number>][] = [
      ['get', `/deposits?${q}`, undefined, { none: 401, view1: 200, acc1: 200, admin1: 200, admin2: 403 }],
      ['get', `/deposits/report/compare?schoolId=${s1}`, undefined, { none: 401, view1: 200, admin2: 403 }],
      ['post', '/deposits', empty, { none: 401, view1: 403, acc1: 400, admin1: 400 }],
      ['post', '/deposits', { studentId: st.id, kind: 'ADVANCE', amount: 5, receivedYearId: yearId }, { admin2: 403 }],
      ['post', '/deposits/import', empty, { none: 401, view1: 403, acc1: 403, admin1: 400 }],
      ['post', '/deposits/import', { schoolId: s1, rows: [] }, { admin2: 403 }],
      ['post', `/deposits/${dep.id}/refund`, empty, { none: 401, view1: 403, acc1: 403, admin1: 400 }],
      ['post', `/deposits/${dep.id}/refund`, { refundAmount: 500, mode: 'CASH', date: TODAY }, { admin2: 403 }],
      ['get', `/vouchers?${q}`, undefined, { none: 401, view1: 200, acc1: 200, admin1: 200 }],
      ['get', `/vouchers?schoolId=${s1}&yearId=${yearId}`, undefined, { admin2: 403 }],
      ['post', '/vouchers', empty, { none: 401, view1: 403, acc1: 400, admin1: 400 }],
      ['post', '/vouchers/999999/cancel', { reason: 'abc' }, { none: 401, view1: 403, acc1: 403, admin1: 404 }],
      ['get', '/vouchers/999999/pdf', undefined, { none: 401, admin1: 404 }],
      ['get', `/banks?schoolId=${s1}`, undefined, { none: 401, view1: 403, acc1: 200, admin1: 200, admin2: 403 }],
      ['post', '/banks', empty, { none: 401, view1: 403, acc1: 403, admin1: 400 }],
      ['patch', '/banks/999999', empty, { none: 401, view1: 403, acc1: 403, admin1: 404 }],
      ['get', `/reports/banking?${q}`, undefined, { none: 401, view1: 200, acc1: 200, admin1: 200, admin2: 403 }],
      ['get', `/reports/fines?${q}`, undefined, { none: 401, view1: 200, acc1: 200, admin1: 200, admin2: 403 }],
      ['get', `/transport-renewals?${q}`, undefined, { none: 401, view1: 403, acc1: 200, admin1: 200, admin2: 403 }],
      ['post', '/transport-renewals', empty, { none: 401, view1: 403, acc1: 400, admin1: 400 }],
      ['delete', '/transport-renewals/999999', undefined, { none: 401, view1: 403, acc1: 403, admin1: 404 }],
      ['post', '/transport-renewals/apply', empty, { none: 401, view1: 403, acc1: 403, admin1: 400 }],
      ['post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: nextYearId }, { admin2: 403 }],
    ];
    const bad: string[] = [];
    for (const [m, path, body, expect] of cases) {
      for (const [who, code] of Object.entries(expect)) {
        const got = (await call(who, m, path, body)).status;
        if (got !== code) bad.push(`${who} ${m.toUpperCase()} ${path} -> ${got}, wanted ${code}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // ------------------------------------------------------------------ deposits
  describe('deposits', () => {
    it('creates, validates and rejects duplicates', async () => {
      const a = await mkStudent();
      const b = await mkStudent();
      const body = { studentId: a.id, kind: 'CAUTION', amount: 500, receivedYearId: yearId };
      const r = await call('acc1', 'post', '/deposits', body).expect(201);
      expect(r.body).toMatchObject({ amount: '500.00', status: 'HELD', admissionNo: a.admissionNo, kind: 'CAUTION' });
      await call('acc1', 'post', '/deposits', body).expect(409); // one per (student, kind)
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, amount: 0 }).expect(400);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, amount: -3 }).expect(400);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, amount: 10.125 }).expect(400);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, kind: 'JEWELS' }).expect(400);
      await call('acc1', 'post', '/deposits', { ...body, studentId: 999999 }).expect(404);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, receivedYearId: 999999 }).expect(404);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, extra: 1 }).expect(400); // unknown field
      // a receipt of another student can't be attached
      const pay = await call('root', 'post', '/payments', { studentId: a.id, yearId, amount: 100, mode: 'CASH' }).expect(201);
      await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, paymentId: pay.body.id }).expect(400);
      const ok = await call('acc1', 'post', '/deposits', { ...body, studentId: b.id, kind: 'ADVANCE', paymentId: undefined }).expect(201);
      expect(ok.body.kind).toBe('ADVANCE');
      // list filters
      const l = await call('view1', 'get', `/deposits?schoolId=${s1}&yearId=${yearId}&kind=CAUTION&status=HELD`).expect(200);
      expect(l.body.some((d: { admissionNo: string }) => d.admissionNo === a.admissionNo)).toBe(true);
      expect(l.body.every((d: { kind: string; status: string }) => d.kind === 'CAUTION' && d.status === 'HELD')).toBe(true);
      await call('view1', 'get', `/deposits?schoolId=${s1}&kind=NOPE`).expect(400);
      await call('view1', 'get', `/deposits?schoolId=${s1}&status=NOPE`).expect(400);
      await call('view1', 'get', `/deposits?schoolId=${s1}&yearId=${yearId}&standardId=${(await prisma.section.findUniqueOrThrow({ where: { id: sectionId } })).standardId}`).expect(200);
    });

    it('refund: sums must match, non-cash needs a reference, one refund only', async () => {
      const a = await mkStudent();
      const dep = (await call('acc1', 'post', '/deposits', { studentId: a.id, kind: 'CAUTION', amount: 500, receivedYearId: yearId }).expect(201)).body;
      const ok = { refundAmount: 400, deduction: 100, mode: 'CASH', date: TODAY };
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, refundAmount: 450 }).expect(400); // 450 + 100 != 500
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, deduction: undefined }).expect(400); // 400 != 500
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, mode: 'UPI' }).expect(400); // no reference
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, date: '2999-01-01' }).expect(400);
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, refundAmount: -1 }).expect(400);
      const done = await call('admin1', 'post', `/deposits/${dep.id}/refund`, { ...ok, mode: 'UPI', reference: 'UTR9999' }).expect(201);
      expect(done.body).toMatchObject({ status: 'REFUNDED', refundAmount: '400.00', deduction: '100.00', refundMode: 'UPI', refundRef: 'UTR9999' });
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, ok).expect(400); // already refunded
      // full deduction = forfeited
      const b = await mkStudent();
      const dep2 = (await call('acc1', 'post', '/deposits', { studentId: b.id, kind: 'CAUTION', amount: 500, receivedYearId: yearId }).expect(201)).body;
      const f = await call('admin1', 'post', `/deposits/${dep2.id}/refund`, { refundAmount: 0, deduction: 500, mode: 'CASH', date: TODAY }).expect(201);
      expect(f.body.status).toBe('FORFEITED');
      await call('admin1', 'post', '/deposits/999999/refund', ok).expect(404);
    });

    it('five parallel refunds of one deposit: exactly one wins', async () => {
      const a = await mkStudent();
      const dep = (await call('acc1', 'post', '/deposits', { studentId: a.id, kind: 'ADVANCE', amount: 2000, receivedYearId: yearId }).expect(201)).body;
      const res = await Promise.all(Array.from({ length: 5 }, () =>
        call('admin1', 'post', `/deposits/${dep.id}/refund`, { refundAmount: 2000, mode: 'CASH', date: TODAY })));
      expect(res.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 400, 400, 400, 400]);
      expect((await prisma.deposit.findUniqueOrThrow({ where: { id: dep.id } })).status).toBe('REFUNDED');
    });

    it('import: all-or-nothing, no overwrites, REFUNDED rows carry the amount', async () => {
      const a = await mkStudent(), b = await mkStudent(), c = await mkStudent();
      const label = (await prisma.academicYear.findUniqueOrThrow({ where: { id: yearId } })).label;
      const row = (s: { admissionNo: string }, extra: object = {}) => ({ admissionNo: s.admissionNo, kind: 'TRANSPORT', amount: 3000, year: label, ...extra });
      const bad = await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a), row({ admissionNo: 'NOPE-1' }), row(b, { year: '1999-00' })] }).expect(400);
      expect(bad.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3]);
      expect(await prisma.deposit.count({ where: { studentId: a.id } })).toBe(0); // nothing saved
      await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a), row(a)] }).expect(400); // duplicate inside the file
      const ok = await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a), row(b, { status: 'REFUNDED' }), row(c, { kind: 'CAUTION', amount: 500 })] }).expect(201);
      expect(ok.body).toEqual({ imported: 3 });
      expect(await prisma.deposit.findUniqueOrThrow({ where: { studentId_kind: { studentId: b.id, kind: 'TRANSPORT' } } })).toMatchObject({ status: 'REFUNDED' });
      await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a)] }).expect(400); // already exists: not overwritten
      await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a, { amount: -1 })] }).expect(400);
      await call('admin1', 'post', '/deposits/import', { schoolId: s1, rows: [row(a, { status: 'BOGUS' })] }).expect(400);
      // admin of school 1 can't import a school-2 file
      await call('admin1', 'post', '/deposits/import', { schoolId: s2, rows: [] }).expect(403);
    });

    it('compare report totals match the rows', async () => {
      const r = await call('view1', 'get', `/deposits/report/compare?schoolId=${s1}&yearIds=${yearId}`).expect(200);
      const all = (await call('view1', 'get', `/deposits?schoolId=${s1}&yearId=${yearId}`).expect(200)).body as { kind: string; status: string; amount: string }[];
      for (const g of r.body as { kind: string; status: string; count: number; amount: string }[]) {
        const rows = all.filter((d) => d.kind === g.kind && d.status === g.status);
        expect(g.count).toBe(rows.length);
        expect(paise(g.amount)).toBe(rows.reduce((s, d) => s + paise(d.amount), 0));
      }
      await call('view1', 'get', `/deposits/report/compare?schoolId=${s1}&yearIds=1,x`).expect(400);
    });
  });

  // ------------------------------------------------------------------ vouchers
  describe('vouchers', () => {
    const base = (enrollmentId: number, o: object = {}) => ({
      schoolId: s1, yearId, enrollmentId, kind: 'CAUTION_REFUND', amount: 100, date: TODAY, mode: 'CASH', ...o,
    });

    it('caution refunds are capped by the deposit; cancelling frees the balance', async () => {
      const a = await mkStudent();
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId)).expect(400); // no deposit
      await prisma.deposit.create({ data: { studentId: a.id, kind: 'CAUTION', amount: '500.00', receivedYearId: yearId, createdBy: 'test' } });
      const v1 = await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 300 })).expect(201);
      expect(v1.body).toMatchObject({ amount: '300.00', kind: 'CAUTION_REFUND', student: { admissionNo: a.admissionNo } });
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 300 })).expect(400); // only 200 left
      const v2 = await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 200 })).expect(201);
      expect(v2.body.voucherNo).toBe(v1.body.voucherNo + 1);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 0.01 })).expect(400); // fully paid out
      await call('acc1', 'post', `/vouchers/${v1.body.id}/cancel`, { reason: 'wrong' }).expect(403); // admin only
      await call('admin1', 'post', `/vouchers/${v1.body.id}/cancel`, { reason: 'x' }).expect(400); // reason too short
      const c = await call('admin1', 'post', `/vouchers/${v1.body.id}/cancel`, { reason: 'wrong amount' }).expect(201);
      expect(c.body.cancelledAt).toBeTruthy();
      expect(c.body.voucherNo).toBe(v1.body.voucherNo); // number kept
      await call('admin1', 'post', `/vouchers/${v1.body.id}/cancel`, { reason: 'wrong amount' }).expect(400);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 300 })).expect(201); // freed again
    });

    it('validation and other kinds', async () => {
      const a = await mkStudent();
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER' })).expect(400); // remarks needed
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'sports kit' })).expect(201);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x', mode: 'UPI' })).expect(400); // no reference
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x', date: '2999-01-01' })).expect(400);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x', amount: 1.005 })).expect(400);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'WHAT', remarks: 'x' })).expect(400);
      await call('acc1', 'post', '/vouchers', base(999999, { kind: 'OTHER', remarks: 'x' })).expect(404);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x', yearId: nextYearId })).expect(400); // wrong year
      await call('admin2', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x' })).expect(403); // other school's admin
      await call('admin2', 'post', '/vouchers', base(a.enrollmentId, { kind: 'OTHER', remarks: 'x', schoolId: s2 })).expect(400); // lies about the school

      // excess refund needs a withdrawal and is capped at excessPaid
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'EXCESS_REFUND' })).expect(400);
      await prisma.withdrawal.create({ data: { enrollmentId: a.enrollmentId, date: new Date(), reason: 'test', balanceDue: '0.00', excessPaid: '1000.00', createdBy: 'test' } });
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'EXCESS_REFUND', amount: 1000.01 })).expect(400);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'EXCESS_REFUND', amount: 600 })).expect(201);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'EXCESS_REFUND', amount: 500 })).expect(400);
      await call('acc1', 'post', '/vouchers', base(a.enrollmentId, { kind: 'EXCESS_REFUND', amount: 400 })).expect(201);

      // a deposit refunded with a deduction can only be paid out for the refunded part
      const b = await mkStudent();
      const dep = await prisma.deposit.create({ data: { studentId: b.id, kind: 'ADVANCE', amount: '2000.00', receivedYearId: yearId, createdBy: 'test' } });
      await call('admin1', 'post', `/deposits/${dep.id}/refund`, { refundAmount: 1500, deduction: 500, mode: 'CASH', date: TODAY }).expect(201);
      await call('acc1', 'post', '/vouchers', base(b.enrollmentId, { kind: 'ADVANCE_REFUND', amount: 1500.01 })).expect(400);
      await call('acc1', 'post', '/vouchers', base(b.enrollmentId, { kind: 'ADVANCE_REFUND', amount: 1500 })).expect(201);
      // forfeited deposits pay nothing
      const c = await mkStudent();
      const dep2 = await prisma.deposit.create({ data: { studentId: c.id, kind: 'CAUTION', amount: '500.00', receivedYearId: yearId, createdBy: 'test' } });
      await call('admin1', 'post', `/deposits/${dep2.id}/refund`, { refundAmount: 0, deduction: 500, mode: 'CASH', date: TODAY }).expect(201);
      await call('acc1', 'post', '/vouchers', base(c.enrollmentId, { amount: 1 })).expect(400);
    });

    it('five parallel payouts against 500: two succeed, numbers unique, never over the cap', async () => {
      const a = await mkStudent();
      await prisma.deposit.create({ data: { studentId: a.id, kind: 'CAUTION', amount: '500.00', receivedYearId: yearId, createdBy: 'test' } });
      const res = await Promise.all(Array.from({ length: 5 }, () => call('acc1', 'post', '/vouchers', base(a.enrollmentId, { amount: 200 }))));
      const ok = res.filter((r) => r.status === 201);
      expect(ok).toHaveLength(2);
      expect(res.filter((r) => r.status === 400)).toHaveLength(3);
      expect(new Set(ok.map((r) => r.body.voucherNo)).size).toBe(2);
    });

    it('lists, filters and prints PDFs', async () => {
      const q = `schoolId=${s1}&yearId=${yearId}`;
      const all = (await call('view1', 'get', `/vouchers?${q}`).expect(200)).body as { id: number; kind: string; amount: string; date: string }[];
      expect(all.length).toBeGreaterThan(0);
      const other = (await call('view1', 'get', `/vouchers?${q}&kind=OTHER`).expect(200)).body as { kind: string }[];
      expect(other.length).toBeGreaterThan(0);
      expect(other.every((v) => v.kind === 'OTHER')).toBe(true);
      expect((await call('view1', 'get', `/vouchers?${q}&from=2999-01-01`).expect(200)).body).toEqual([]);
      await call('view1', 'get', `/vouchers?${q}&kind=NOPE`).expect(400);
      await call('view1', 'get', `/vouchers?${q}&from=garbage`).expect(400);
      const pdf = await call('view1', 'get', `/vouchers/${all[0].id}/pdf`).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const reg = await call('view1', 'get', `/vouchers?${q}&pdf=1`).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(reg.headers['content-type']).toContain('application/pdf');
      expect((reg.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  // ------------------------------------------------------------------ banks and reports
  describe('banks and reconciliation', () => {
    let bankId: number, otherBankId: number;

    it('bank master', async () => {
      const b = await call('admin1', 'post', '/banks', { schoolId: s1, name: `MA Bank ${RUN}`, ifsc: 'TEST0001' }).expect(201);
      bankId = b.body.id;
      await call('admin1', 'post', '/banks', { schoolId: s1, name: `MA Bank ${RUN}` }).expect(409);
      await call('admin1', 'post', '/banks', { schoolId: s1, name: 'x' }).expect(400);
      await call('admin1', 'post', '/banks', { schoolId: s2, name: `MA Bank x${RUN}` }).expect(403);
      otherBankId = (await call('admin2', 'post', '/banks', { schoolId: s2, name: `MA Bank other ${RUN}` }).expect(201)).body.id;
      const l = await call('acc1', 'get', `/banks?schoolId=${s1}`).expect(200);
      expect(l.body.map((x: { id: number }) => x.id)).toContain(bankId);
      expect(l.body.map((x: { id: number }) => x.id)).not.toContain(otherBankId);
      await call('admin1', 'patch', `/banks/${bankId}`, { accountNo: '123456' }).expect(200);
      await call('admin1', 'patch', `/banks/${otherBankId}`, { active: false }).expect(403);
      await call('admin1', 'patch', `/banks/${bankId}`, { bogus: 1 }).expect(400);
    });

    it('banking report: bank-date window, flags, totals, csv and pdf', async () => {
      const a = await mkStudent();
      const pay = (body: object) => call('root', 'post', '/payments', { studentId: a.id, yearId, ...body }).then((r) => { expect(r.status).toBe(201); return r.body; });
      // p1 is backdated so its bank date can sit well before today. Bank state is set directly: reconcile lives in the payments controller.
      const p1 = await pay({ amount: 1000, mode: 'CHEQUE', reference: 'CHQ-1', bankId, chequeNo: 'C-1', chequeDate: '2026-05-01', date: '2026-05-02' });
      const p2 = await pay({ amount: 700, mode: 'UPI', reference: 'UTR-7' });
      const p3 = await pay({ amount: 300, mode: 'CARD', reference: 'CARD-3' });
      const p5 = await pay({ amount: 100, mode: 'CHEQUE', reference: 'CHQ-5', bankId, chequeNo: 'C-5', chequeDate: '2999-01-01' });
      await prisma.payment.update({ where: { id: p1.id }, data: { clearStatus: 'CLEARED', bankDate: new Date('2026-05-05') } });
      await prisma.payment.update({ where: { id: p3.id }, data: { clearStatus: 'BOUNCED', bouncedAt: new Date() } });
      const q = `schoolId=${s1}&yearId=${yearId}`;
      const mine = (rows: { admissionNo: string; receiptNo: number }[]) => rows.filter((r) => r.admissionNo === a.admissionNo);

      const all = (await call('view1', 'get', `/reports/banking?${q}`).expect(200)).body;
      expect(mine(all.rows).map((r: { receiptNo: number }) => r.receiptNo)).toEqual([p1.receiptNo, p2.receiptNo, p3.receiptNo, p5.receiptNo]);
      const row = (rows: { receiptNo: number }[], no: number) => rows.find((r) => r.receiptNo === no) as Record<string, unknown>;
      expect(row(all.rows, p1.receiptNo)).toMatchObject({ bank: `MA Bank ${RUN}`, chequeNo: 'C-1', receiptDate: '2026-05-02', bankDate: '2026-05-05', amount: '1000.00', status: 'CLEARED', flag: null });
      expect(row(all.rows, p2.receiptNo)).toMatchObject({ bankDate: null, status: 'PENDING', flag: null });
      expect(row(all.rows, p5.receiptNo)).toMatchObject({ flag: 'FUTURE_CHEQUE' });
      expect(row(all.rows, p3.receiptNo)).toMatchObject({ status: 'BOUNCED', flag: 'BOUNCED' });
      // totals add the valid rows only, in exact paise
      const valid = all.rows.filter((r: { status: string }) => r.status !== 'BOUNCED');
      expect(all.totals.count).toBe(valid.length);
      expect(paise(all.totals.amount)).toBe(valid.reduce((s: number, r: { amount: string }) => s + paise(r.amount), 0));
      expect(paise(all.totals.fine)).toBe(valid.reduce((s: number, r: { fine: string }) => s + paise(r.fine), 0));

      // window uses bankDate, falling back to the receipt date when not credited yet
      const win = (from: string, to: string) => call('view1', 'get', `/reports/banking?${q}&from=${from}&to=${to}`).expect(200).then((r) => mine(r.body.rows).map((x: { receiptNo: number }) => x.receiptNo));
      expect(await win('2026-05-05', '2026-05-05')).toEqual([p1.receiptNo]);
      expect(await win('2026-05-02', '2026-05-04')).toEqual([]); // receipt date is not used once the bank date is known
      expect(await win(TODAY, TODAY)).toEqual([p2.receiptNo, p3.receiptNo, p5.receiptNo]);
      expect(await win('2000-01-01', '2000-01-02')).toEqual([]);
      // filters
      const byMode = (await call('view1', 'get', `/reports/banking?${q}&mode=UPI`).expect(200)).body.rows;
      expect(byMode.every((r: { mode: string }) => r.mode === 'UPI')).toBe(true);
      const byBank = (await call('view1', 'get', `/reports/banking?${q}&bankId=${bankId}`).expect(200)).body.rows;
      expect(byBank.every((r: { bank: string }) => r.bank === `MA Bank ${RUN}`)).toBe(true);
      expect(byBank.length).toBeGreaterThan(0);
      const byStatus = (await call('view1', 'get', `/reports/banking?${q}&status=BOUNCED`).expect(200)).body.rows;
      expect(byStatus.every((r: { status: string }) => r.status === 'BOUNCED')).toBe(true);
      await call('view1', 'get', `/reports/banking?${q}&mode=BITCOIN`).expect(400);
      await call('view1', 'get', `/reports/banking?${q}&status=NOPE`).expect(400);
      await call('view1', 'get', `/reports/banking?${q}&from=nope`).expect(400);
      // manual cancel is excluded, bounced (also cancelled) is not
      const p4 = await pay({ amount: 50, mode: 'UPI', reference: 'UTR-X' });
      await call('admin1', 'post', `/payments/${p4.id}/cancel`, { reason: 'duplicate' }).expect(201);
      expect(row(mine((await call('view1', 'get', `/reports/banking?${q}`).expect(200)).body.rows), p4.receiptNo)).toBeUndefined();

      const csv = await call('view1', 'get', `/reports/banking?${q}&format=csv`).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.replace(/^\uFEFF/, '').split('\n')[0]).toBe('Receipt No,Admission No,Student,Mode,Bank,Cheque No,Receipt Date,Bank Date,Amount,Fine,Status,Flag');
      expect(csv.text).toContain(a.admissionNo);
      const pdf = await call('view1', 'get', `/reports/banking?${q}&pdf=1`).buffer().parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('fines report lists only valid receipts that carried fine', async () => {
      const a = await mkStudent();
      const p = (await call('root', 'post', '/payments', { studentId: a.id, yearId, amount: 1000, mode: 'CASH' }).expect(201)).body;
      const fineOf = (b: { allocations: { fine: string }[] }) => b.allocations.reduce((s, x) => s + paise(x.fine), 0);
      expect(fineOf(p)).toBeGreaterThan(0); // seeded installments are overdue, so fine is taken first
      const q = `schoolId=${s1}&yearId=${yearId}`;
      const r = (await call('view1', 'get', `/reports/fines?${q}&from=${TODAY}&to=${TODAY}`).expect(200)).body;
      const mine = r.rows.find((x: { admissionNo: string }) => x.admissionNo === a.admissionNo);
      expect(paise(mine.fine)).toBe(fineOf(p));
      expect(r.rows.every((x: { fine: string }) => paise(x.fine) > 0)).toBe(true);
      expect(paise(r.totals.fine)).toBe(r.rows.reduce((s: number, x: { fine: string }) => s + paise(x.fine), 0));
      await call('admin1', 'post', `/payments/${p.id}/cancel`, { reason: 'test cancel' }).expect(201);
      const after = (await call('view1', 'get', `/reports/fines?${q}&from=${TODAY}&to=${TODAY}`).expect(200)).body;
      expect(after.rows.find((x: { admissionNo: string }) => x.admissionNo === a.admissionNo)).toBeUndefined();
      expect((await call('view1', 'get', `/reports/fines?${q}&format=csv`).expect(200)).headers['content-type']).toContain('text/csv');
      await call('view1', 'get', `/reports/fines?${q}&from=bad`).expect(400);
    });
  });

  // ------------------------------------------------------------------ transport renewals
  describe('transport renewals', () => {
    let routeId: number, slabId: number, stop1: number, stop2: number;
    const give = (enrollmentId: number, pickupStopId = stop1, dropStopId = stop2) =>
      prisma.transportAssignment.create({ data: { enrollmentId, pickupStopId, dropStopId } });
    const next = (studentId: number) => prisma.enrollment.create({ data: { studentId, yearId: nextYearId, sectionId }, include: { transport: true } });

    beforeAll(async () => {
      routeId = (await prisma.facility.create({ data: { schoolId: s1, kind: 'TRANSPORT', name: `MA-route-${RUN}` } })).id;
      slabId = (await prisma.facility.create({ data: { schoolId: s1, kind: 'SLAB', name: `MA-slab-${RUN}` } })).id;
      stop1 = (await prisma.stop.create({ data: { routeId, slabId, name: 'MA-A', sequence: 1 } })).id;
      stop2 = (await prisma.stop.create({ data: { routeId, slabId, name: 'MA-B', sequence: 2 } })).id;
    });

    it('records decisions, then applies them once', async () => {
      const A = await mkStudent(), B = await mkStudent(), C = await mkStudent(), D = await mkStudent(), E = await mkStudent(), F = await mkStudent();
      for (const s of [A, B, C, D, E]) await give(s.enrollmentId);
      await next(A.id); // A renews into a clean next year
      // B was never promoted
      await next(C.id).then((e) => prisma.transportAssignment.create({ data: { enrollmentId: e.id, pickupStopId: stop2 } })); // C already has transport next year
      await next(D.id).then((e) => prisma.transportAssignment.create({ data: { enrollmentId: e.id, pickupStopId: stop1 } })); // D withdraws: transport removed next year
      // E withdraws and has no next-year enrollment

      const mk = (s: { enrollmentId: number }, type: string, who = 'acc1') => call(who, 'post', '/transport-renewals', { enrollmentId: s.enrollmentId, type });
      await mk(F, 'RENEW').expect(400); // F has no transport
      await mk(A, 'MAYBE').expect(400);
      await call('acc1', 'post', '/transport-renewals', { enrollmentId: 999999, type: 'RENEW' }).expect(404);
      await mk(A, 'RENEW', 'admin2').expect(403);
      const rA = (await mk(A, 'RENEW').expect(201)).body;
      expect(rA).toMatchObject({ status: 'PENDING', type: 'RENEW', filledBy: 'zma-acc1', student: { admissionNo: A.admissionNo } });
      await mk(A, 'WITHDRAW').expect(409); // one decision per enrollment
      const rB = (await mk(B, 'RENEW').expect(201)).body;
      await mk(C, 'RENEW').expect(201);
      await mk(D, 'WITHDRAW').expect(201);
      await mk(E, 'WITHDRAW').expect(201);
      const rGone = (await mk(F, 'RENEW').then(() => null).catch(() => null));
      expect(rGone).toBeNull();

      const q = `schoolId=${s1}&yearId=${yearId}`;
      const pending = (await call('acc1', 'get', `/transport-renewals?${q}&status=PENDING`).expect(200)).body as { student: { admissionNo: string } }[];
      expect(pending.filter((r) => r.student.admissionNo.startsWith(P))).toHaveLength(5);
      await call('acc1', 'get', `/transport-renewals?${q}&status=WHAT`).expect(400);

      await call('admin1', 'post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: yearId }).expect(400);
      await call('admin1', 'post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: 999999 }).expect(404);
      const res = (await call('admin1', 'post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: nextYearId }).expect(201)).body;
      const by = (id: number) => (res.rows as { id: number; status: string; note: string | null }[]).find((r) => r.id === id)!;
      expect(by(rA.id)).toMatchObject({ status: 'APPLIED', note: null });
      expect(by(rB.id)).toMatchObject({ status: 'SKIPPED', note: 'Student not promoted to the next year' });
      const state = async (s: { id: number }) => (await prisma.enrollment.findUnique({ where: { studentId_yearId: { studentId: s.id, yearId: nextYearId } }, include: { transport: true } }))?.transport;
      expect(await state(A)).toMatchObject({ pickupStopId: stop1, dropStopId: stop2 }); // copied
      expect(await state(C)).toMatchObject({ pickupStopId: stop2, dropStopId: null }); // untouched
      expect(await state(D)).toBeNull(); // stopped
      expect(res.applied).toBeGreaterThanOrEqual(3);
      const rows = (await call('acc1', 'get', `/transport-renewals?${q}`).expect(200)).body as { student: { admissionNo: string }; status: string; note: string | null }[];
      const status = (s: { admissionNo: string }) => rows.find((r) => r.student.admissionNo === s.admissionNo)!;
      expect(status(C)).toMatchObject({ status: 'SKIPPED', note: 'Already has transport next year' });
      expect(status(D).status).toBe('APPLIED');
      expect(status(E)).toMatchObject({ status: 'APPLIED', note: 'No next-year enrollment; nothing to stop' });

      // second run: nothing pending, nothing changes
      const again = (await call('admin1', 'post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: nextYearId }).expect(201)).body;
      expect(again).toMatchObject({ applied: 0, skipped: 0, rows: [] });
      expect(await state(A)).toMatchObject({ pickupStopId: stop1 });

      // applied rows are history; a pending one can be withdrawn by an admin only
      await call('admin1', 'delete', `/transport-renewals/${rA.id}`).expect(400);
      await call('admin2', 'post', '/transport-renewals/apply', { schoolId: s1, fromYearId: yearId, toYearId: nextYearId }).expect(403);
      const G = await mkStudent();
      await give(G.enrollmentId);
      const rG = (await mk(G, 'RENEW').expect(201)).body;
      await call('acc1', 'delete', `/transport-renewals/${rG.id}`).expect(403);
      await call('admin2', 'delete', `/transport-renewals/${rG.id}`).expect(403);
      await call('admin1', 'delete', `/transport-renewals/${rG.id}`).expect(200);
      expect(await prisma.transportRenewal.count({ where: { id: rG.id } })).toBe(0);
    });
  });
});
