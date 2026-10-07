import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { DefaultersModule } from './../src/defaulters/defaulters.module.js';

// Runs entirely inside its own throwaway school (code A5DEF) so it can't disturb, or be disturbed by, the other specs
// sharing the DB: 2 classes, 5 students, one installment past due, no fine. Everything is removed afterwards.
describe('defaulters (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });
  type H = Record<string, string>;
  let root: H, admin: H, acct: H, viewer: H, other: H;
  let fx: number, s2: number, yearId: number;
  const std: Record<string, number> = {}, sec: Record<string, number> = {}, kid: Record<string, number> = {}, enr: Record<string, number> = {};
  type Row = { studentId: number; enrollmentId: number; admissionNo: string; overdue: string; totalDue: string; contacts?: { fatherName: string | null } };

  const dropFixture = async () => {
    const school = await prisma.school.findUnique({ where: { code: 'A5DEF' } });
    if (!school) return;
    const where = { schoolId: school.id };
    await prisma.defaulterNotice.deleteMany({ where });
    await prisma.defaulterLetterTemplate.deleteMany({ where });
    await prisma.paymentAllocation.deleteMany({ where: { payment: where } });
    await prisma.payment.deleteMany({ where });
    await prisma.receiptCounter.deleteMany({ where });
    await prisma.transportAssignment.deleteMany({ where: { enrollment: { student: where } } });
    await prisma.facilityAssignment.deleteMany({ where: { enrollment: { student: where } } });
    await prisma.enrollment.deleteMany({ where: { student: where } });
    await prisma.student.deleteMany({ where });
    await prisma.feeStructure.deleteMany({ where: { standard: where } });
    await prisma.installment.deleteMany({ where });
    await prisma.feeHead.deleteMany({ where });
    await prisma.section.deleteMany({ where: { standard: where } });
    await prisma.standard.deleteMany({ where });
    await prisma.stop.deleteMany({ where: { route: where } });
    await prisma.facility.deleteMany({ where: { schoolId: school.id, kind: { not: 'SLAB' } } });
    await prisma.facility.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.school.delete({ where: { id: school.id } });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule, DefaultersModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    s2 = (await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } })).id;
    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    await dropFixture();
    await prisma.user.deleteMany({ where: { username: { startsWith: 'a5def-' } } });

    fx = (await prisma.school.create({ data: { code: 'A5DEF', name: 'A5 Defaulter School' } })).id;
    for (const [name, sortOrder, sections] of [['A5 One', 0, ['A', 'B']], ['A5 Two', 1, ['A']]] as const) {
      std[name] = (await prisma.standard.create({ data: { schoolId: fx, name, sortOrder } })).id;
      for (const s of sections) sec[`${name}/${s}`] = (await prisma.section.create({ data: { standardId: std[name], name: s } })).id;
    }
    const head = await prisma.feeHead.create({ data: { schoolId: fx, name: 'A5 Tuition', type: 'MONTHLY' } });
    const inst = await prisma.installment.create({ data: { schoolId: fx, yearId, number: 1, label: 'First', dueDate: new Date('2026-04-10') } });
    for (const [name, amount] of [['A5 One', 1000], ['A5 Two', 2000]] as const) {
      await prisma.feeStructure.create({ data: { yearId, standardId: std[name], feeHeadId: head.id, installmentId: inst.id, amount } });
    }
    for (const [k, section] of [['k1', 'A5 One/A'], ['k2', 'A5 One/A'], ['k3', 'A5 One/B'], ['k4', 'A5 Two/A'], ['k5', 'A5 Two/A']] as const) {
      const st = await prisma.student.create({ data: { schoolId: fx, admissionNo: `A5DEF-${k}`, name: `Kid ${k}`, active: k !== 'k5' } }); // k5 has left
      kid[k] = st.id;
      enr[k] = (await prisma.enrollment.create({ data: { studentId: st.id, yearId, sectionId: sec[section] } })).id;
    }
    // facilities carry no fee grid, so they change who is in a scope but not any bill
    const route = await prisma.facility.create({ data: { schoolId: fx, kind: 'TRANSPORT', name: 'A5 Route' } });
    const slab = await prisma.facility.create({ data: { schoolId: fx, kind: 'SLAB', name: 'A5 Slab' } });
    const hostel = await prisma.facility.create({ data: { schoolId: fx, kind: 'HOSTEL', name: 'A5 Hostel' } });
    const stop = await prisma.stop.create({ data: { name: 'A5 Stop', sequence: 1, routeId: route.id, slabId: slab.id } });
    await prisma.facilityAssignment.create({ data: { enrollmentId: enr.k1, facilityId: route.id } });
    await prisma.facilityAssignment.create({ data: { enrollmentId: enr.k4, facilityId: hostel.id } });
    await prisma.transportAssignment.create({ data: { enrollmentId: enr.k3, pickupStopId: stop.id } });

    root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    for (const [u, role, schoolId] of [['admin', 'ADMIN', fx], ['acct', 'ACCOUNTANT', fx], ['viewer', 'VIEWER', fx], ['other', 'ADMIN', s2]] as const) {
      await http().post('/api/users').set(root).send({ username: `a5def-${u}`, password: 'password1', role, schoolId }).expect(201);
    }
    [admin, acct, viewer, other] = await Promise.all(['admin', 'acct', 'viewer', 'other'].map((u) => login(`a5def-${u}`, 'password1')));
  });

  afterAll(async () => {
    await dropFixture();
    await prisma.user.deleteMany({ where: { username: { startsWith: 'a5def-' } } });
    await app.close();
  });

  const list = (qs = '', who: H = viewer) => http().get(`/api/defaulters?schoolId=${fx}&yearId=${yearId}${qs}`).set(who);
  const rowsOf = async (qs = '') => (await list(qs).expect(200)).body as Row[];
  const idsOf = async (qs = '') => (await rowsOf(qs)).map((r) => r.studentId).sort((a, b) => a - b);
  const sorted = (...ks: string[]) => ks.map((k) => kid[k]).sort((a, b) => a - b);

  it('list: only active students with overdue > 0; filters, contacts, scope, authz', async () => {
    await http().get(`/api/defaulters?schoolId=${fx}&yearId=${yearId}`).expect(401);
    await list('', other).expect(403);
    await list('', viewer).expect(200); // read-only roles may look

    // k5 left (inactive) so is excluded even though they owe 2000
    const rows = await rowsOf();
    expect(rows.map((r) => [r.admissionNo, r.overdue, r.totalDue])).toEqual([
      ['A5DEF-k1', '1000.00', '1000.00'], ['A5DEF-k2', '1000.00', '1000.00'], ['A5DEF-k3', '1000.00', '1000.00'], ['A5DEF-k4', '2000.00', '2000.00'],
    ]);
    expect(rows[0]).not.toHaveProperty('contacts');

    // nothing is due before the due date; minDue trims by amount
    expect(await rowsOf('&asOf=2026-04-09')).toEqual([]);
    expect((await rowsOf('&asOf=2026-04-10')).length).toBe(4); // due date itself counts
    expect(await idsOf('&minDue=1500')).toEqual(sorted('k4'));
    expect(await idsOf('&minDue=1000')).toEqual(sorted('k1', 'k2', 'k3', 'k4'));
    expect(await idsOf('&minDue=2000.01')).toEqual([]);
    await list('&minDue=abc').expect(400);
    await list('&minDue=-5').expect(400);
    await list('&scope=SPACE').expect(400);
    await http().get(`/api/defaulters?schoolId=${fx}`).set(viewer).expect(400);

    // class / section filters
    expect(await idsOf(`&standardId=${std['A5 One']}`)).toEqual(sorted('k1', 'k2', 'k3'));
    expect(await idsOf(`&sectionId=${sec['A5 One/B']}`)).toEqual(sorted('k3'));
    expect(await idsOf(`&sectionId=${sec['A5 One/A']}`)).toEqual(sorted('k1', 'k2'));

    // contacts
    await prisma.student.update({ where: { id: kid.k1 }, data: { fatherName: 'Mr Kid', phone: '9876543210' } });
    const withC = await rowsOf('&contacts=true');
    expect(withC.find((r) => r.studentId === kid.k1)?.contacts).toMatchObject({ fatherName: 'Mr Kid', phone: '9876543210' });

    // scope = who uses the facility: k1 (route facility) + k3 (stop assignment) for transport, k4 for hostel
    expect(await idsOf('&scope=TRANSPORT')).toEqual(sorted('k1', 'k3'));
    expect(await idsOf('&scope=HOSTEL')).toEqual(sorted('k4'));
    expect(await idsOf('&scope=FEE')).toHaveLength(4);
    expect(await idsOf('&scope=TRANSPORT&minDue=2000')).toEqual([]); // filters combine
  });

  it('templates: ADMIN writes, ADMIN/ACCOUNTANT read, school-scoped, validated', async () => {
    const body = 'Dear {parent}, {student} ({admissionNo}) of {class} owes Rs {due} since {since}. Date {date}.';
    await http().post('/api/defaulter-templates').set(acct).send({ schoolId: fx, name: 'T a', body }).expect(403);
    await http().post('/api/defaulter-templates').set(other).send({ schoolId: fx, name: 'T a', body }).expect(403);
    await http().post('/api/defaulter-templates').set(admin).send({ schoolId: fx, name: 'T a', body: 'short' }).expect(400);
    await http().post('/api/defaulter-templates').set(admin).send({ schoolId: fx, name: '', body }).expect(400);
    await http().post('/api/defaulter-templates').set(admin).send({ schoolId: fx, name: 'T a', body, extra: 1 }).expect(400); // unknown field
    const { body: t } = await http().post('/api/defaulter-templates').set(admin).send({ schoolId: fx, name: 'T a', body }).expect(201);
    await http().post('/api/defaulter-templates').set(admin).send({ schoolId: fx, name: 'T a', body }).expect(409); // unique per school
    expect((await http().get(`/api/defaulter-templates?schoolId=${fx}`).set(acct).expect(200)).body.map((x: { id: number }) => x.id)).toContain(t.id);
    await http().get(`/api/defaulter-templates?schoolId=${fx}`).set(viewer).expect(403);
    await http().get(`/api/defaulter-templates?schoolId=${fx}`).set(other).expect(403);
    await http().put(`/api/defaulter-templates/${t.id}`).set(other).send({ name: 'hacked' }).expect(403);
    await http().put(`/api/defaulter-templates/${t.id}`).set(acct).send({ name: 'x' }).expect(403);
    expect((await http().put(`/api/defaulter-templates/${t.id}`).set(admin).send({ name: 'T b' }).expect(200)).body.name).toBe('T b');
    await http().delete(`/api/defaulter-templates/${t.id}`).set(other).expect(403);
    await http().delete(`/api/defaulter-templates/${t.id}`).set(admin).expect(200);
    await http().put(`/api/defaulter-templates/${t.id}`).set(admin).send({ name: 'T c' }).expect(404);
    await http().delete(`/api/defaulter-templates/${t.id}`).set(admin).expect(404);
  });

  it('letters: one page per owing student, recomputed at print time, logged, capped', async () => {
    const tpl = (await http().post('/api/defaulter-templates').set(admin).send({
      schoolId: fx, name: 'Letter', body: 'Dear {parent}, {student} ({admissionNo}) of {class} owes Rs {due} since {since}. Date {date}.',
    }).expect(201)).body;
    const letters = (ids: number[], extra: object = {}, who: H = acct) =>
      http().post('/api/defaulters/letters').set(who).send({ schoolId: fx, yearId, templateId: tpl.id, studentIds: ids, ...extra });
    const pdf = (r: request.Response) => (r.body as Buffer).toString('latin1');
    const pages = (r: request.Response) => (pdf(r).match(/\/Type \/Page\b/g) ?? []).length;
    const notices = async (k: string, who: H = viewer) =>
      (await http().get(`/api/defaulters/notices?schoolId=${fx}&enrollmentId=${enr[k]}`).set(who).expect(200)).body as { kind: string; dueAmount: string; scope: string; createdBy: string }[];
    const { k1, k2, k4 } = kid;

    // k2 pays everything after the list was built => skipped when printing
    const pay = await http().post('/api/payments').set(acct).send({ studentId: k2, yearId, amount: 1000, mode: 'CASH' }).expect(201);
    expect(pay.body.receiptNo).toBe(1); // own school => own counter
    expect(await idsOf()).toEqual(sorted('k1', 'k3', 'k4'));

    const r = await letters([k1, k2, k4, k1], { since: 'April 2026' }).expect(201);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['x-letters']).toBe('2');
    expect(r.headers['x-skipped']).toBe('1'); // k2; the duplicate k1 is collapsed first
    expect(pdf(r).startsWith('%PDF')).toBe(true);
    expect(pages(r)).toBe(2);

    expect(await notices('k1')).toEqual([expect.objectContaining({ kind: 'LETTER', dueAmount: '1000.00', scope: 'FEE', createdBy: 'a5def-acct' })]);
    expect(await notices('k4')).toEqual([expect.objectContaining({ dueAmount: '2000.00' })]);
    expect(await notices('k2')).toEqual([]);
    expect((await http().get(`/api/defaulters/notices?schoolId=${fx}`).set(viewer).expect(200)).body).toHaveLength(2);
    await http().get(`/api/defaulters/notices?schoolId=${fx}`).set(other).expect(403);
    await http().get('/api/defaulters/notices').set(viewer).expect(400);

    // a second print adds a second notice (history, not de-duplicated); scope is recorded
    await letters([k1], { scope: 'TRANSPORT' }).expect(201);
    expect((await notices('k1')).map((n) => n.scope)).toEqual(['TRANSPORT', 'FEE']);
    await letters([k4], { scope: 'TRANSPORT' }).expect(400); // k4 isn't in the transport scope => nobody to write to

    // nobody owes => 400 and nothing logged
    const n = await prisma.defaulterNotice.count({ where: { schoolId: fx } });
    await letters([k2]).expect(400);
    await letters([999999]).expect(400); // not a student of this school/year
    await letters([kid.k5]).expect(400); // left the school
    expect(await prisma.defaulterNotice.count({ where: { schoolId: fx } })).toBe(n);

    // validation, authz, scoping, cap
    await letters([]).expect(400);
    await letters(Array.from({ length: 501 }, (_, i) => i + 1)).expect(400);
    await letters([k1], {}, viewer).expect(403);
    await letters([k1], {}, other).expect(403);
    const foreignTpl = await prisma.defaulterLetterTemplate.create({ data: { schoolId: s2, name: 'A5 foreign', body: 'x'.repeat(20) } });
    try { await letters([k1], { templateId: foreignTpl.id }).expect(400); } finally { await prisma.defaulterLetterTemplate.delete({ where: { id: foreignTpl.id } }); }
    await letters([k1], { templateId: 999999 }).expect(400);
    await letters([k1], { scope: 'SPACE' }).expect(400);
    await letters([k1], { asOf: 'not-a-date' }).expect(400);
    await letters([k1], { asOf: '2026-04-09T00:00:00.000Z' }).expect(400); // before anything is due
    await letters([k1], { bogus: true }).expect(400);
    const foreign = await prisma.student.findFirstOrThrow({ where: { schoolId: s2 } });
    await letters([foreign.id]).expect(400); // another school's student can't be reached
  });
});
