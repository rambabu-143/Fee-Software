import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { dropSchool, listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// (1) ADMIN waive/edit of a bounce charge, (2) transport security deposit (billed once to transport users,
// deposit auto-created, not re-billed on renewal). Own throwaway school/years, future dates, no fines: amounts exact.
//   Year 1: Tuition 1000 + 1000 (inst 1, 2), Transport Security 500 (inst 1), flat bus 200 + 200.
//   Year 2: same grid. Non-transport students owe 2000 / year; transport students 2900 in year 1 (security once).
describe('money more: bounce-charge edit + transport security (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZGA${Date.now()}`.slice(0, 20);
  let H: { Authorization: string };
  let schoolId = 0, y1 = 0, y2 = 0, sectionId = 0, bankId = 0, busId = 0, n = 0;
  const yearIds: number[] = [];

  async function student(opts: { transport?: boolean } = {}) {
    const { body } = await http().post('/api/students').set(H).send({
      schoolId, yearId: y1, admissionNo: `${tag}-${++n}`, name: `GA ${n}`, sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);
    const enr = await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: body.id, yearId: y1 } } });
    if (opts.transport) await prisma.facilityAssignment.create({ data: { enrollmentId: enr.id, facilityId: busId } });
    return { id: body.id as number, enr: enr.id };
  }
  const bill = async (id: number, yearId = y1) => (await http().get(`/api/students/${id}/bill?yearId=${yearId}`).set(H).expect(200)).body;
  const pay = (id: number, amount: number, extra: object = {}) =>
    http().post('/api/payments').set(H).send({ studentId: id, yearId: y1, amount, mode: 'CASH', ...extra });
  const cheque = (id: number, amount: number) => pay(id, amount, { mode: 'CHEQUE', reference: 'CHQ-1234', bankId, chequeNo: `${200000 + ++n}` });
  const bounce = (paymentId: number, bounceCharge?: number) =>
    http().post(`/api/payments/${paymentId}/reconcile`).set(H).send({ status: 'BOUNCED', ...(bounceCharge !== undefined ? { bounceCharge } : {}) });
  const edit = (paymentId: number, bounceCharge: number, reason = 'goodwill waiver', headers = H) =>
    http().patch(`/api/payments/${paymentId}/bounce-charge`).set(headers).send({ bounceCharge, reason });
  const cancel = (paymentId: number) => http().post(`/api/payments/${paymentId}/cancel`).set(H).send({ reason: 'test cancel' });
  const deposits = async (studentId: number) =>
    ((await http().get(`/api/deposits?schoolId=${schoolId}&yearId=${y1}`).set(H).expect(200)).body as Array<Record<string, string | number | null>>)
      .filter((d) => d.studentId === studentId);
  const securityLine = (b: { installments: Array<{ lines: Array<{ name: string }> }> }) =>
    b.installments.flatMap((i) => i.lines).filter((l) => /security/i.test(l.name));

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

    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Money more test school' } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'S1', sortOrder: 1, sections: { create: [{ name: 'A' }] } }, include: { sections: true } });
    sectionId = std.sections[0].id;
    const tuition = await prisma.feeHead.create({ data: { schoolId, name: 'Tuition', type: 'MONTHLY' } });
    const security = await prisma.feeHead.create({ data: { schoolId, name: 'Transport Security', type: 'REFUNDABLE' } });
    const bus = await prisma.facility.create({ data: { schoolId, kind: 'TRANSPORT', name: 'Bus 1' } });
    busId = bus.id;
    bankId = (await prisma.bank.create({ data: { schoolId, name: `${tag} Bank` } })).id;
    for (const [i, label] of [[1, 'Y1'], [2, 'Y2']] as const) {
      const base = 2090 + (i - 1) * 2;
      const y = await prisma.academicYear.create({ data: { label: `${tag}-${label}`.slice(0, 20), startDate: new Date(`${base}-04-01`), endDate: new Date(`${base + 1}-03-31`) } });
      yearIds.push(y.id);
      const i1 = await prisma.installment.create({ data: { schoolId, yearId: y.id, number: 1, label: 'I1', dueDate: new Date(`${base}-06-10`) } });
      const i2 = await prisma.installment.create({ data: { schoolId, yearId: y.id, number: 2, label: 'I2', dueDate: new Date(`${base}-09-10`) } });
      for (const inst of [i1, i2]) {
        await prisma.feeStructure.create({ data: { yearId: y.id, standardId: std.id, feeHeadId: tuition.id, installmentId: inst.id, amount: '1000.00' } });
        await prisma.facilityFeeStructure.create({ data: { yearId: y.id, facilityId: bus.id, installmentId: inst.id, amount: '200.00' } });
      }
      await prisma.feeStructure.create({ data: { yearId: y.id, standardId: std.id, feeHeadId: security.id, installmentId: i1.id, amount: '500.00' } });
    }
    [y1, y2] = yearIds;
  });

  afterAll(async () => {
    await dropSchool(prisma, tag);
    await prisma.arrearCarry.deleteMany({ where: { fromYearId: { in: yearIds } } });
    await prisma.academicYear.deleteMany({ where: { id: { in: yearIds } } });
    await app.close();
  });

  describe('bounce charge edit / waive', () => {
    it('ADMIN can lower, waive and raise it; the bill follows each change', async () => {
      const s = await student();
      const p = (await cheque(s.id, 300)).body;
      await bounce(p.id, 100).expect(201);
      expect((await bill(s.id)).bounce.amount).toBe('100.00');

      const r = await edit(p.id, 40).expect(200);
      expect(r.body.bounceCharge).toBe('40'); // receipt JSON keeps the Decimal as-is, like reconcile
      expect((await bill(s.id)).bounce).toMatchObject({ amount: '40.00', due: '40.00' });

      await edit(p.id, 0, 'waived by principal').expect(200);
      const b0 = await bill(s.id);
      expect(b0.bounce.amount).toBe('0.00');
      expect(b0.bounce.items).toEqual([]);
      expect(b0.totals.due).toBe('2000.00');

      await edit(p.id, 75.5).expect(200);
      expect((await bill(s.id)).bounce.amount).toBe('75.50');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).bounceChargeNote).toBe('goodwill waiver');
    });

    it('validates: reason, negative, decimals, unknown id, and only bounced receipts', async () => {
      const s = await student();
      const cash = (await pay(s.id, 100)).body;
      const chq = (await cheque(s.id, 100)).body;
      await edit(cash.id, 10).expect(400); // cash receipt: never bounced
      await edit(chq.id, 10).expect(400); // pending cheque: not bounced yet
      await bounce(chq.id, 50).expect(201);
      await edit(chq.id, 10, 'x').expect(400); // reason too short
      await edit(chq.id, -1).expect(400);
      await edit(chq.id, 1.234).expect(400);
      await http().patch(`/api/payments/${chq.id}/bounce-charge`).set(H).send({ bounceCharge: 10 }).expect(400); // no reason
      await edit(999999999, 10).expect(404);
      await edit(chq.id, 50).expect(200);
    });

    it('ACCOUNTANT and VIEWER get 403; unauthenticated 401; nothing changes', async () => {
      const s = await student();
      const p = (await cheque(s.id, 100)).body;
      await bounce(p.id, 80).expect(201);
      const mk = async (role: string) => {
        const username = `${tag.toLowerCase()}-${role.slice(0, 3).toLowerCase()}`.slice(0, 32).replace(/[^a-z0-9._-]/g, '-');
        await http().post('/api/users').set(H).send({ username, password: 'pass-word-123', role, schoolId }).expect(201);
        const l = await http().post('/api/auth/login').send({ username, password: 'pass-word-123' }).expect(201);
        return { Authorization: `Bearer ${l.body.token}` };
      };
      await edit(p.id, 0, 'nope nope', await mk('ACCOUNTANT')).expect(403);
      await edit(p.id, 0, 'nope nope', await mk('VIEWER')).expect(403);
      await http().patch(`/api/payments/${p.id}/bounce-charge`).send({ bounceCharge: 0, reason: 'nope' }).expect(401);
      expect((await bill(s.id)).bounce.amount).toBe('80.00');
    });

    it('cannot drop the total below what was already paid against bounce charges (two bounced receipts)', async () => {
      const s = await student();
      const a = (await cheque(s.id, 300)).body;
      const b = (await cheque(s.id, 300)).body;
      await bounce(b.id, 50).expect(201); // latest first: a bounce is refused while a later live receipt exists
      await bounce(a.id, 100).expect(201);
      expect((await bill(s.id)).bounce.amount).toBe('150.00');
      await pay(s.id, 100).expect(201); // goes to the bounce charge first
      expect((await bill(s.id)).bounce).toMatchObject({ amount: '150.00', paid: '100.00', due: '50.00' });

      const low = await edit(a.id, 0).expect(400); // total would be 50 < 100 paid
      expect(low.body.message).toMatch(/already paid/);
      await edit(a.id, 50).expect(200); // total 100 == paid: allowed
      expect((await bill(s.id)).bounce).toMatchObject({ amount: '100.00', paid: '100.00', due: '0.00' });
      await edit(b.id, 0).expect(400); // total would be 50 < 100 paid
      await edit(b.id, 25).expect(400); // total 75 < 100 paid
    }, 30000);

    it('is race-safe: a payment into the bounce charge and a waiver never leave paid > charged', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await student();
        const p = (await cheque(s.id, 100)).body;
        await bounce(p.id, 100).expect(201);
        const [e, c] = await Promise.all([edit(p.id, 0), pay(s.id, 100)]);
        expect([200, 400]).toContain(e.status);
        expect(c.status).toBe(201);
        const b = await bill(s.id);
        expect(Number(b.bounce.paid)).toBeLessThanOrEqual(Number(b.bounce.amount));
        expect(Number(b.bounce.due)).toBeGreaterThanOrEqual(0);
        // either the waiver won (payment went to tuition) or the payment won (waiver refused)
        if (e.status === 200) expect(b.bounce.amount).toBe('0.00'); else expect(b.bounce.paid).toBe('100.00');
      }
    }, 60000);
  });

  describe('transport security deposit', () => {
    it('is billed only to students on transport, with the bus fare', async () => {
      const plain = await student();
      expect(securityLine(await bill(plain.id))).toEqual([]);
      expect((await bill(plain.id)).totals.due).toBe('2000.00');

      const bus = await student({ transport: true });
      const b = await bill(bus.id);
      expect(securityLine(b)).toHaveLength(1);
      expect(b.totals.due).toBe('2900.00'); // 2000 tuition + 400 bus + 500 security
    });

    it('creates the TRANSPORT deposit only once the security head itself is paid; cancel voids it', async () => {
      const s = await student({ transport: true });
      const part = (await pay(s.id, 1000)).body; // refundable heads are paid last: tuition 1000 + bus part first
      expect(await deposits(s.id)).toEqual([]);
      await cancel(part.id).expect(201);

      const full = (await pay(s.id, 1700)).body; // the whole first installment: 1000 + 200 + 500
      const d = await deposits(s.id);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ kind: 'TRANSPORT', status: 'HELD', amount: '500.00', paymentId: full.id });

      await cancel(full.id).expect(201);
      expect(await deposits(s.id)).toEqual([]);
    });

    it('a bounced cheque voids the deposit it created; the security charge returns to the bill', async () => {
      const s = await student({ transport: true });
      const c = (await cheque(s.id, 1700)).body;
      expect(await deposits(s.id)).toHaveLength(1);
      await bounce(c.id).expect(201);
      expect(await deposits(s.id)).toEqual([]);
      const b = await bill(s.id);
      expect(securityLine(b)).toHaveLength(1);
      expect(b.totals.due).toBe('2900.00');
    });

    it('year 2: a student holding a TRANSPORT deposit is not billed security again; others still are', async () => {
      const holder = await student({ transport: true });
      await pay(holder.id, 1700).expect(201);
      expect(await deposits(holder.id)).toHaveLength(1);
      const fresh = await student({ transport: true });

      for (const s of [holder, fresh]) {
        const next = await prisma.enrollment.create({ data: { studentId: s.id, yearId: y2, sectionId } });
        await prisma.facilityAssignment.create({ data: { enrollmentId: next.id, facilityId: busId } });
      }
      const h2 = await bill(holder.id, y2);
      expect(securityLine(h2)).toEqual([]);
      expect(h2.totals.due).toBe('2400.00'); // tuition + bus only
      const f2 = await bill(fresh.id, y2);
      expect(securityLine(f2)).toHaveLength(1);
      expect(f2.totals.due).toBe('2900.00');

      // Transport stops: the renewal row tells staff the deposit is still held (it is never refunded automatically).
      const route = await prisma.facility.create({ data: { schoolId, kind: 'TRANSPORT', name: `${tag}-route` } });
      const slab = await prisma.facility.create({ data: { schoolId, kind: 'SLAB', name: `${tag}-slab` } });
      const stop = await prisma.stop.create({ data: { routeId: route.id, slabId: slab.id, name: 'A', sequence: 1 } });
      await prisma.transportAssignment.create({ data: { enrollmentId: holder.enr, pickupStopId: stop.id } });
      const r = (await http().post('/api/transport-renewals').set(H).send({ enrollmentId: holder.enr, type: 'WITHDRAW' }).expect(201)).body;
      const applied = (await http().post('/api/transport-renewals/apply').set(H).send({ schoolId, fromYearId: y1, toYearId: y2 }).expect(201)).body;
      const row = applied.rows.find((x: { id: number }) => x.id === r.id);
      expect(row.note).toMatch(/Transport security ₹500\.00 is still held: refund it from Deposits/);
    }, 30000);

    it('the deposit is refunded through the normal deposit refund endpoint', async () => {
      const s = await student({ transport: true });
      await pay(s.id, 1700).expect(201);
      const [d] = await deposits(s.id);
      await http().post(`/api/deposits/${d.id}/refund`).set(H)
        .send({ refundAmount: 450, deduction: 50, mode: 'CASH', date: new Date().toISOString().slice(0, 10) }).expect(201);
      expect((await deposits(s.id))[0]).toMatchObject({ status: 'REFUNDED', kind: 'TRANSPORT' });
    });
  });
});
