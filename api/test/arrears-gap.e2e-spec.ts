import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen, makeSchool, dropSchool } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Arrears carry-forward must never silently drop a balance: students enrolled last year but not promoted
// are reported (with what they owe), previewable, and picked up once they are enrolled. Own throwaway school.
describe('arrears carry-forward: left-behind students (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const code = `ZZFA${Date.now() % 1e8}`;
  const toLabel = '2095-96'; // unique to this spec
  const H: Record<string, { Authorization: string }> = {};
  let schoolId = 0, fromYearId = 0, toYearId = 0, sectionId = 0, n = 0;
  type S = { id: number; admissionNo: string; fromEnr: number };
  let owing: S, leftBehind: S, settled: S, withdrawn: S, newInTarget: S, late: S;

  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password })).body.token}` });
  const bill = async (id: number, y: number) => (await http().get(`/api/students/${id}/bill?yearId=${y}`).set(H.admin).expect(200)).body;
  const due = async (s: S) => Number((await bill(s.id, fromYearId)).totals.due);
  const carry = (body: object = {}, query = '', as = 'admin') =>
    http().post(`/api/arrears/carry${query}`).set(H[as]).send({ schoolId, fromYearId, toYearId, ...body });
  const unpromoted = (q = `schoolId=${schoolId}&fromYearId=${fromYearId}&toYearId=${toYearId}`, as = 'admin') =>
    http().get(`/api/arrears/unpromoted?${q}`).set(H[as]);
  type Row = { admissionNo: string; outcome: string; amount: string | null; className: string; name: string };
  const outcome = (rows: Row[], s: S) => rows.find((r) => r.admissionNo === s.admissionNo);

  async function student(inFrom: boolean, inTo: boolean): Promise<S> {
    const admissionNo = `${code}-${++n}`;
    const { body } = await http().post('/api/students').set(H.admin).send({
      schoolId, yearId: inFrom ? fromYearId : toYearId, admissionNo, name: `FA ${n}`, sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);
    if (inFrom && inTo) await prisma.enrollment.create({ data: { studentId: body.id, yearId: toYearId, sectionId } });
    const fromEnr = inFrom ? (await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: body.id, yearId: fromYearId } } })).id : 0;
    return { id: body.id, admissionNo, fromEnr };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    H.admin = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');

    schoolId = (await makeSchool(prisma, code)).id;
    fromYearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    toYearId = (await prisma.academicYear.upsert({
      where: { label: toLabel }, update: {}, create: { label: toLabel, startDate: new Date('2095-04-01'), endDate: new Date('2096-03-31') },
    })).id;
    sectionId = (await prisma.section.findFirstOrThrow({ where: { standard: { schoolId } }, orderBy: { id: 'asc' } })).id;

    const mk = async (username: string, role: string, sid: number | null) => {
      await http().post('/api/users').set(H.admin).send({ username, password: 'fa-pass-1234', role, schoolId: sid }).expect(201);
      H[username] = await login(username, 'fa-pass-1234');
    };
    await mk(`${code.toLowerCase()}-acc`, 'ACCOUNTANT', schoolId);
    const other = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } });
    await mk(`${code.toLowerCase()}-oth`, 'ADMIN', other.id);

    owing = await student(true, true);
    leftBehind = await student(true, false);
    settled = await student(true, false);
    withdrawn = await student(true, false);
    newInTarget = await student(false, false);
    late = await student(true, false);

    await http().post('/api/payments').set(H.admin).send({
      studentId: settled.id, yearId: fromYearId, mode: 'CASH', amount: Number((await bill(settled.id, fromYearId)).totals.due),
    }).expect(201);
    await prisma.withdrawal.create({ data: { enrollmentId: withdrawn.fromEnr, date: new Date('2026-07-01'), reason: 'test', balanceDue: 0, excessPaid: 0, createdBy: 'fa' } });
  }, 60_000); // makeSchool seeds a whole school: slow on a cold run

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: code.toLowerCase() } } });
    await prisma.arrearCarry.deleteMany({ where: { enrollment: { student: { schoolId } } } });
    await dropSchool(prisma, code);
    await prisma.academicYear.deleteMany({ where: { id: toYearId, enrollments: { none: {} }, payments: { none: {} } } });
    await app.close();
  }, 60_000);

  it('preview (dryRun) reports one outcome per student and writes nothing', async () => {
    const mine = [owing, leftBehind, settled, withdrawn, late].map((s) => s.id);
    const r = (await carry({ studentIds: mine, dryRun: true }).expect(201)).body;
    expect(r.dryRun).toBe(true);
    expect(r.rows).toHaveLength(5); // newInTarget is not on last year's roster
    expect(outcome(r.rows, owing)).toMatchObject({ outcome: 'CARRIED' });
    expect(Number(outcome(r.rows, owing)!.amount)).toBeCloseTo(await due(owing), 2);
    expect(outcome(r.rows, leftBehind)).toMatchObject({ outcome: 'SKIPPED_NOT_ENROLLED_NEXT_YEAR' });
    expect(Number(outcome(r.rows, leftBehind)!.amount)).toBeCloseTo(await due(leftBehind), 2);
    expect(outcome(r.rows, settled)).toMatchObject({ outcome: 'SKIPPED_ZERO' });
    expect(outcome(r.rows, withdrawn)).toMatchObject({ outcome: 'SKIPPED_WITHDRAWN' });
    expect(r).toMatchObject({ carried: 1, credits: 0, zero: 1, skippedWithdrawn: 1, skippedNotEnrolled: 2, skippedExisting: 0 });
    expect(Number(r.leftBehindDue)).toBeCloseTo((await due(leftBehind)) + (await due(late)), 2);
    expect(await prisma.arrearCarry.count({ where: { enrollment: { student: { schoolId } } } })).toBe(0);
    // ?dryRun=true works too.
    expect((await carry({ studentIds: [owing.id] }, '?dryRun=true').expect(201)).body.dryRun).toBe(true);
    expect(await prisma.arrearCarry.count({ where: { enrollment: { student: { schoolId } } } })).toBe(0);
  });

  it('lists left-behind students with their closing balance (settled/withdrawn/enrolled are not listed)', async () => {
    const rows = (await unpromoted().expect(200)).body as { admissionNo: string; name: string; className: string; due: string }[];
    const lb = rows.find((r) => r.admissionNo === leftBehind.admissionNo)!;
    expect(lb).toMatchObject({ name: expect.stringContaining('FA'), className: expect.stringMatching(/\S+ \S+/) });
    expect(Number(lb.due)).toBeCloseTo(await due(leftBehind), 2);
    const listed = new Set(rows.map((r) => r.admissionNo));
    for (const s of [owing, settled, withdrawn, newInTarget]) expect(listed.has(s.admissionNo)).toBe(false);
    expect(listed.has(late.admissionNo)).toBe(true);
  });

  it('real carry: carries enrolled students, reports (does not drop) left-behind money', async () => {
    const owingDue = await due(owing), leftDue = await due(leftBehind), lateDue = await due(late);
    const r = (await carry({ studentIds: [owing.id, leftBehind.id, late.id] }).expect(201)).body;
    expect(r).toMatchObject({ dryRun: false, carried: 1, skippedNotEnrolled: 2 });
    // Conservation: everything owed is either carried or reported as left behind.
    expect(Number(outcome(r.rows, owing)!.amount) + Number(r.leftBehindDue)).toBeCloseTo(owingDue + leftDue + lateDue, 2);
    const carried = await prisma.arrearCarry.findMany({ where: { enrollment: { student: { schoolId } } }, include: { enrollment: true } });
    expect(carried).toHaveLength(1);
    expect(carried[0].enrollment.studentId).toBe(owing.id);
    expect(Number(carried[0].amount)).toBeCloseTo(owingDue, 2);
    // It shows on the to-year bill.
    expect(Number((await bill(owing.id, toYearId)).arrear.amount)).toBeCloseTo(owingDue, 2);
  });

  it('re-run is idempotent: existing carries are reported as SKIPPED_EXISTING', async () => {
    const r = (await carry({ studentIds: [owing.id, leftBehind.id] }).expect(201)).body;
    expect(outcome(r.rows, owing)).toMatchObject({ outcome: 'SKIPPED_EXISTING' });
    expect(r).toMatchObject({ carried: 0, skippedExisting: 1, skippedNotEnrolled: 1 });
    expect(await prisma.arrearCarry.count({ where: { enrollment: { student: { schoolId } } } })).toBe(1);
  });

  it('a left-behind student enrolled later is picked up by the next run', async () => {
    await prisma.enrollment.create({ data: { studentId: leftBehind.id, yearId: toYearId, sectionId } });
    const rows = (await unpromoted().expect(200)).body as { admissionNo: string }[];
    expect(rows.some((x) => x.admissionNo === leftBehind.admissionNo)).toBe(false);
    const r = (await carry({ studentIds: [leftBehind.id] }).expect(201)).body;
    expect(outcome(r.rows, leftBehind)).toMatchObject({ outcome: 'CARRIED' });
    const row = await prisma.arrearCarry.findFirstOrThrow({ where: { enrollment: { studentId: leftBehind.id, yearId: toYearId } } });
    expect(Number(row.amount)).toBeCloseTo(await due(leftBehind), 2);
    expect(row.source).toBe('COMPUTED');
  });

  it('authz and validation', async () => {
    await http().post('/api/arrears/carry').send({ schoolId, fromYearId, toYearId }).expect(401);
    await unpromoted(undefined, `${code.toLowerCase()}-acc`).expect(200); // read: any role of the school
    await carry({}, '', `${code.toLowerCase()}-acc`).expect(403); // write: ADMIN only
    await carry({}, '', `${code.toLowerCase()}-oth`).expect(403); // other school's admin
    await unpromoted(undefined, `${code.toLowerCase()}-oth`).expect(403);
    await carry({ dryRun: 'yes' }).expect(400);
    await carry({ studentIds: ['a'] }).expect(400);
    await carry({ extra: 1 }).expect(400);
    await carry({ toYearId: fromYearId }).expect(400);
    await unpromoted(`schoolId=${schoolId}&fromYearId=${toYearId}&toYearId=${fromYearId}`).expect(400); // backwards
    await unpromoted(`schoolId=x&fromYearId=${fromYearId}&toYearId=${toYearId}`).expect(400);
  });
});
