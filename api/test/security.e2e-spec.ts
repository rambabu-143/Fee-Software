import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Security regressions found by the T3 sweep: auth/JWT, role + cross-school (IDOR) checks, bad-input 5xx,
// exactly-once cancel, login throttle, audit redaction. Own throwaway schools/users (zsec-*); cleans up.
describe('security (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZSEC${Date.now()}`.slice(0, 20);
  const H: Record<string, { Authorization: string }> = {};
  const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString('base64url');
  const jwt = (payload: object, secret: string | null) => {
    const head = b64({ alg: secret === null ? 'none' : 'HS256', typ: 'JWT' }), body = b64(payload);
    return `${head}.${body}.${secret === null ? '' : createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
  };
  let s1 = 0, s2 = 0, yearId = 0, sectionId = 0, section2Id = 0, std1 = 0, studentId = 0, student2Id = 0, enrollmentId = 0, paymentId = 0, bank1 = 0;
  let adminId = 0;

  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password })).body.token}` });
  const mkUser = async (username: string, role: string, schoolId: number) => {
    const { body } = await http().post('/api/users').set(H.root).send({ username, password: 'zsec-pass-123', role, schoolId }).expect(201);
    H[username] = await login(username, 'zsec-pass-123');
    return body.id as number;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    H.root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');

    yearId = (await prisma.academicYear.create({ data: { label: `${tag}-Y`.slice(0, 20), startDate: new Date('2093-04-01'), endDate: new Date('2094-03-31') } })).id;
    const mk = async (code: string) => {
      const school = await prisma.school.create({ data: { code, name: `${code} school` } });
      const std = await prisma.standard.create({ data: { schoolId: school.id, name: 'S1', sortOrder: 1, sections: { create: [{ name: 'A' }] } }, include: { sections: true } });
      const head = await prisma.feeHead.create({ data: { schoolId: school.id, name: 'Tuition', type: 'MONTHLY' } });
      const inst = await prisma.installment.create({ data: { schoolId: school.id, yearId, number: 1, label: 'I1', dueDate: new Date('2093-06-10') } });
      await prisma.feeStructure.create({ data: { yearId, standardId: std.id, feeHeadId: head.id, installmentId: inst.id, amount: '1000.00' } });
      return { school, std, sectionId: std.sections[0].id };
    };
    const a = await mk(`${tag}1`.slice(0, 20)), b = await mk(`${tag}2`.slice(0, 20));
    s1 = a.school.id; s2 = b.school.id; std1 = a.std.id; sectionId = a.sectionId; section2Id = b.sectionId;
    bank1 = (await prisma.bank.create({ data: { schoolId: s1, name: `${tag} bank` } })).id;
    adminId = await mkUser('zsec-admin1', 'ADMIN', s1);
    await mkUser('zsec-acct1', 'ACCOUNTANT', s1);
    await mkUser('zsec-view1', 'VIEWER', s1);
    await mkUser('zsec-admin2', 'ADMIN', s2);

    const mkStudent = async (n: string) => (await http().post('/api/students').set(H['zsec-admin1']).send({
      schoolId: s1, yearId, admissionNo: `${tag}-${n}`, name: `Sec ${n}`, sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201)).body.id as number;
    studentId = await mkStudent('1'); student2Id = await mkStudent('2');
    enrollmentId = (await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId, yearId } } })).id;
    paymentId = (await http().post('/api/payments').set(H['zsec-admin1']).send({ studentId, yearId, amount: 100, mode: 'CASH' }).expect(201)).body.id;
  });

  afterAll(async () => {
    const ids = (await prisma.student.findMany({ where: { schoolId: { in: [s1, s2] } } })).map((s) => s.id);
    await prisma.paymentAllocation.deleteMany({ where: { payment: { studentId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId: { in: [s1, s2] } } });
    await prisma.feeStructure.deleteMany({ where: { yearId } });
    await prisma.installment.deleteMany({ where: { schoolId: { in: [s1, s2] } } });
    await prisma.feeHead.deleteMany({ where: { schoolId: { in: [s1, s2] } } });
    await prisma.section.deleteMany({ where: { standard: { schoolId: { in: [s1, s2] } } } });
    await prisma.standard.deleteMany({ where: { schoolId: { in: [s1, s2] } } });
    await prisma.bank.deleteMany({ where: { schoolId: { in: [s1, s2] } } });
    await prisma.auditLog.deleteMany({ where: { username: { startsWith: 'zsec-' } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'zsec-' } } });
    await prisma.academicYear.deleteMany({ where: { id: yearId } });
    await prisma.school.deleteMany({ where: { id: { in: [s1, s2] } } });
    await app.close();
  });

  describe('authentication', () => {
    const payload = { sub: 1, username: 'admin', role: 'SUPERADMIN', schoolId: null };
    it('rejects missing, garbage, wrong-secret, alg=none and expired tokens', async () => {
      const bad = ['', 'abc.def.ghi', jwt({ ...payload, exp: 9999999999 }, 'wrong-secret'), jwt(payload, null), jwt({ ...payload, exp: 1 }, process.env.JWT_SECRET!)];
      for (const t of bad) {
        const r = http().get('/api/schools');
        await (t ? r.set('Authorization', `Bearer ${t}`) : r).expect(401);
      }
    });

    it('a deactivated user\'s old token stops working immediately', async () => {
      const id = await mkUser('zsec-gone', 'VIEWER', s1);
      await http().get('/api/auth/me').set(H['zsec-gone']).expect(200);
      await http().patch(`/api/users/${id}`).set(H['zsec-admin1']).send({ active: false }).expect(200);
      await http().get('/api/auth/me').set(H['zsec-gone']).expect(401);
      await http().post('/api/auth/login').send({ username: 'zsec-gone', password: 'zsec-pass-123' }).expect(401);
    });

    it('throttles repeated failed logins per username, and a good login is unaffected', async () => {
      const u = `zsec-nobody-${Date.now()}`;
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await http().post('/api/auth/login').send({ username: u, password: 'bad' })).status);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      await http().post('/api/auth/login').send({ username: 'zsec-view1', password: 'zsec-pass-123' }).expect(201);
    });

    it('school admins cannot escalate or reach across schools via /users', async () => {
      const a = H['zsec-admin1'];
      await http().post('/api/users').set(a).send({ username: 'zsec-esc', password: 'zsec-pass-123', role: 'SUPERADMIN' }).expect(403);
      await http().post('/api/users').set(a).send({ username: 'zsec-esc', password: 'zsec-pass-123', role: 'VIEWER', schoolId: s2 }).expect(403);
      await http().patch('/api/users/1').set(a).send({ password: 'hackedpass1' }).expect(403); // the superadmin
      await http().patch(`/api/users/${adminId}`).set(a).send({ role: 'SUPERADMIN' }).expect(400); // self role change
    });
  });

  describe('every operation: 401 without a token, 403 for a VIEWER on any write', () => {
    it('covers the whole OpenAPI surface', async () => {
      const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const ops = Object.entries(doc.paths).flatMap(([p, o]) => Object.keys(o as object).map((m) => ({ m, p: p.replace(/\{[^}]+\}/g, '1') })))
        .filter((o) => o.p !== '/api/auth/login' && o.p !== '/api/health'); // the only @Public() routes
      expect(ops.length).toBeGreaterThan(140);
      const bad: string[] = [];
      for (const { m, p } of ops) {
        const r = (t?: Record<string, string>) => { const q = (http() as never as Record<string, (u: string) => request.Test>)[m](p); return t ? q.set(t) : q; };
        if ((await r()).status !== 401) bad.push(`${m} ${p} unauthenticated`);
        if (m !== 'get' && (await r(H['zsec-view1'])).status !== 403) bad.push(`${m} ${p} viewer write`);
      }
      expect(bad).toEqual([]);
    });
  });

  describe('cross-school isolation (admin of school 2 vs school 1 data)', () => {
    const o = () => H['zsec-admin2'];
    it('refuses reads and writes on school 1 resources', async () => {
      const q = `schoolId=${s1}&yearId=${yearId}`;
      for (const p of [`/students?${q}`, `/payments?${q}`, `/students/${studentId}/bill?yearId=${yearId}`, `/payments/${paymentId}`, `/payments/${paymentId}/pdf`,
        `/reports/dues?${q}`, `/reports/collection?${q}`, `/deposits?${q}`, `/banks?schoolId=${s1}`, `/audit?schoolId=${s1}`, `/settings?schoolId=${s1}`, `/defaulters?${q}`]) {
        expect([403, 404]).toContain((await http().get(`/api${p}`).set(o())).status);
      }
      const w = (m: 'post' | 'put' | 'patch', p: string, b: object) => http()[m](`/api${p}`).set(o()).send(b);
      expect((await w('post', `/payments/${paymentId}/cancel`, { reason: 'zsec' })).status).toBe(403);
      expect((await w('patch', `/students/${studentId}`, { yearId, name: 'hacked' })).status).toBe(403);
      expect((await w('post', '/payments', { studentId, yearId, amount: 10, mode: 'CASH' })).status).toBe(403);
      expect((await w('put', '/fee-structure', { yearId, standardId: std1, items: [] })).status).toBe(403);
      expect((await w('post', '/vouchers', { schoolId: s1, yearId, enrollmentId, kind: 'CAUTION_REFUND', amount: 1, date: '2093-05-01', mode: 'CASH' })).status).toBe(403);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).cancelledAt).toBeNull();
      expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).name).toBe('Sec 1');
    });

    it('refuses school 1 ids smuggled into a school 2 request body', async () => {
      const s2Student = (await http().post('/api/students').set(o()).send({
        schoolId: s2, yearId, admissionNo: `${tag}-X`, name: 'Sec X', sectionId: section2Id, isNewAdmission: false, optionalHeadIds: [],
      }).expect(201)).body.id as number;
      // foreign section on create, foreign bank on a cheque, foreign enrollment on a voucher
      expect((await http().post('/api/students').set(o()).send({ schoolId: s2, yearId, admissionNo: `${tag}-Y`, name: 'n', sectionId, isNewAdmission: false, optionalHeadIds: [] })).status).toBe(400);
      const cheque = await http().post('/api/payments').set(o()).send({ studentId: s2Student, yearId, amount: 10, mode: 'CHEQUE', reference: 'CHQ-1', bankId: bank1, chequeNo: '123456', chequeDate: '2093-05-01' });
      expect(cheque.status).toBeGreaterThanOrEqual(400);
      expect((await http().post('/api/vouchers').set(o()).send({ schoolId: s2, yearId, enrollmentId, kind: 'CAUTION_REFUND', amount: 1, date: '2093-05-01', mode: 'CASH' })).status).toBeGreaterThanOrEqual(400);
      expect(await prisma.payment.count({ where: { studentId: s2Student } })).toBe(0);
      expect(await prisma.voucher.count({ where: { enrollmentId } })).toBe(0);
    });
  });

  describe('bad input is a 400, never a 500', () => {
    it('ids beyond int32, 1e20, NUL bytes and schoolId=0', async () => {
      const r = H['zsec-admin1'];
      expect((await http().post('/api/payments/99999999999/cancel').set(r).send({ reason: 'zsec' })).status).toBe(400);
      expect((await http().patch('/api/schools/100000000000000000000').set(H.root).send({ address: 'x' })).status).toBe(400);
      expect((await http().get(`/api/students?schoolId=99999999999&yearId=${yearId}`).set(H.root)).status).toBe(400);
      expect((await http().post('/api/banks').set(H.root).send({ schoolId: s1, name: 'a\u0000b' })).status).toBe(400);
      expect((await http().get(`/api/reports/classwise?schoolId=0&yearId=${yearId}`).set(H.root)).status).toBe(400);
      expect((await http().get(`/api/reports/classwise?schoolId=-1&yearId=${yearId}`).set(H.root)).status).toBe(400);
    });
  });

  describe('money endpoints are exactly-once under double-submit', () => {
    it('cancelling one receipt 6x at once succeeds once and keeps the first reason', async () => {
      const p = (await http().post('/api/payments').set(H['zsec-admin1']).send({ studentId: student2Id, yearId, amount: 50, mode: 'CASH' }).expect(201)).body.id as number;
      const res = await Promise.all(Array.from({ length: 6 }, (_, i) => http().post(`/api/payments/${p}/cancel`).set(H['zsec-admin1']).send({ reason: `reason ${i}` })));
      expect(res.filter((x) => x.status === 201)).toHaveLength(1);
      expect(res.filter((x) => x.status === 400)).toHaveLength(5);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: p } });
      expect(row.cancelReason).toBe(res.find((x) => x.status === 201)!.body.cancelReason);
    });
  });

  describe('audit log', () => {
    it('redacts secrets, never logs login, and has no write routes', async () => {
      await mkUser('zsec-audit', 'VIEWER', s1);
      await http().patch(`/api/users/${adminId}`).set(H['zsec-admin1']).send({ password: 'zsec-new-pass-9' }).expect(200);
      const rows = await prisma.auditLog.findMany({ where: { username: 'zsec-admin1' } });
      expect(JSON.stringify(rows)).not.toMatch(/zsec-new-pass-9|zsec-pass-123/);
      expect(await prisma.auditLog.count({ where: { entity: { contains: 'auth', mode: 'insensitive' } } })).toBe(0);
      for (const m of ['post', 'put', 'patch', 'delete'] as const) await http()[m]('/api/audit').set(H.root).send({}).expect(404);
    });
  });
});
