import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Needs the seeded demo DB. Creates its own next-year and cleans everything up.
describe('bulk promotion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  let base = '';
  const http = () => request(base);
  const yearLabel = `2099-${String(Date.now() % 100).padStart(2, '0')}`;
  const admissionPrefix = `E2E-PROMO-${Date.now()}`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    auth = { Authorization: `Bearer ${login.body.token}` };
  });

  afterAll(async () => {
    const s = await prisma.student.findMany({ where: { admissionNo: { startsWith: admissionPrefix } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: s.map((x) => x.id) } } });
    await prisma.student.deleteMany({ where: { id: { in: s.map((x) => x.id) } } });
    const standard = await prisma.standard.findUnique({ where: { schoolId_name: { schoolId: 1, name: standardName } } });
    if (standard) {
      await prisma.section.deleteMany({ where: { standardId: standard.id } });
      await prisma.standard.delete({ where: { id: standard.id } });
    }
    const year = await prisma.academicYear.findUnique({ where: { label: yearLabel } });
    if (year) await prisma.academicYear.delete({ where: { id: year.id } });
    await app.close();
  });

  const standardName = `E2E Promo ${Date.now()}`;

  it('promotes an unheld-back student and skips a held-back one, and is idempotent', async () => {
    const school = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO1' } });
    const fromYear = await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } });
    // Own class+sections, not shared with any other suite, so a concurrently-running
    // suite can never add a student that this test's "all students in the section" query picks up.
    const standard = (await http().post('/api/standards').set(auth)
      .send({ schoolId: school.id, name: standardName, sortOrder: 999 }).expect(201)).body;
    const fromSectionId = (await http().post('/api/sections').set(auth)
      .send({ standardId: standard.id, name: 'From' }).expect(201)).body.id;
    const toSectionId = (await http().post('/api/sections').set(auth)
      .send({ standardId: standard.id, name: 'To' }).expect(201)).body.id;

    const toYear = (await http().post('/api/years').set(auth)
      .send({ label: yearLabel, startDate: '2099-04-01', endDate: '2100-03-31' }).expect(201)).body;

    const promoteMe = (await http().post('/api/students').set(auth).send({
      schoolId: school.id, yearId: fromYear.id, admissionNo: `${admissionPrefix}-A`, name: 'Promote Me',
      sectionId: fromSectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201)).body;
    const holdBack = (await http().post('/api/students').set(auth).send({
      schoolId: school.id, yearId: fromYear.id, admissionNo: `${admissionPrefix}-B`, name: 'Hold Back',
      sectionId: fromSectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201)).body;

    const candidates = await http()
      .get(`/api/promotions/candidates?schoolId=${school.id}&fromYearId=${fromYear.id}&fromSectionId=${fromSectionId}`)
      .set(auth).expect(200);
    expect(candidates.body.map((c: { admissionNo: string }) => c.admissionNo)).toEqual(
      expect.arrayContaining([`${admissionPrefix}-A`, `${admissionPrefix}-B`]),
    );

    const result = await http().post('/api/promotions').set(auth).send({
      fromYearId: fromYear.id, toYearId: toYear.id, fromSectionId, toSectionId,
      excludeStudentIds: [holdBack.id],
    }).expect(201);
    expect(result.body.promoted).toBe(1);

    const promoted = await http().get(`/api/students?schoolId=${school.id}&yearId=${toYear.id}`).set(auth).expect(200);
    const names = promoted.body.map((s: { admissionNo: string }) => s.admissionNo);
    expect(names).toContain(`${admissionPrefix}-A`);
    expect(names).not.toContain(`${admissionPrefix}-B`);

    // Idempotent: re-running reports the already-promoted student instead of erroring.
    const again = await http().post('/api/promotions').set(auth).send({
      fromYearId: fromYear.id, toYearId: toYear.id, fromSectionId, toSectionId,
      excludeStudentIds: [holdBack.id],
    }).expect(201);
    expect(again.body.promoted).toBe(0);
    expect(again.body.alreadyEnrolled).toContain(`${admissionPrefix}-A`);
  });
});
