import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Needs the seeded demo DB. Cleans up the facility and student it creates.
describe('transport & hostel facilities (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());
  const admissionNo = `E2E-FAC-${Date.now()}`;
  const routeName = `E2E Route ${Date.now()}`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    prisma = app.get(PrismaService);
    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    auth = { Authorization: `Bearer ${login.body.token}` };
  });

  afterAll(async () => {
    const s = await prisma.student.findMany({ where: { admissionNo: { startsWith: 'E2E-FAC-' } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: s.map((x) => x.id) } } });
    await prisma.student.deleteMany({ where: { id: { in: s.map((x) => x.id) } } });
    await prisma.facilityFeeStructure.deleteMany({ where: { facility: { name: routeName } } });
    await prisma.facility.deleteMany({ where: { name: routeName } });
    await app.close();
  });

  it('creates a route, prices it per installment, assigns a student, and bills it', async () => {
    const school = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO1' } });
    const year = await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } });
    const std = await prisma.standard.findFirstOrThrow({ where: { schoolId: school.id, name: 'Class 1' }, include: { sections: true } });
    const insts = await prisma.installment.findMany({ where: { schoolId: school.id, yearId: year.id }, orderBy: { number: 'asc' } });

    const created = await http().post('/api/facilities').set(auth)
      .send({ schoolId: school.id, kind: 'TRANSPORT', name: routeName }).expect(201);
    const facilityId = created.body.id;

    const list = await http().get(`/api/facilities?schoolId=${school.id}&kind=TRANSPORT`).set(auth).expect(200);
    expect(list.body.map((f: { name: string }) => f.name)).toContain(routeName);

    // The grid save replaces the whole kind, like /fee-structure replaces a whole class:
    // fetch the current one first so Route A/B's seeded pricing isn't wiped out.
    const existing = await http().get(`/api/facilities/structure?yearId=${year.id}&schoolId=${school.id}&kind=TRANSPORT`).set(auth).expect(200);
    const keep = existing.body.map((c: { facilityId: number; installmentId: number; amount: string }) => ({ ...c, amount: Number(c.amount) }));
    await http().put('/api/facilities/structure').set(auth).send({
      yearId: year.id, schoolId: school.id, kind: 'TRANSPORT',
      items: [...keep, ...insts.map((i) => ({ facilityId, installmentId: i.id, amount: 700 }))],
    }).expect(200);

    const { body: st } = await http().post('/api/students').set(auth).send({
      schoolId: school.id, yearId: year.id, admissionNo, name: 'Commuter',
      sectionId: std.sections[0].id, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);

    await http().put(`/api/students/${st.id}/facilities`).set(auth)
      .send({ yearId: year.id, kind: 'HOSTEL', facilityId: 999999 }).expect(400); // wrong kind/id
    const assign = await http().put(`/api/students/${st.id}/facilities`).set(auth)
      .send({ yearId: year.id, kind: 'TRANSPORT', facilityId }).expect(200);
    expect(assign.body).toEqual([{ kind: 'TRANSPORT', facilityId, name: routeName }]);

    // Class 1 grid (tuition 6000 x4, annual 8000 once) + the 700 route fee every installment.
    const bill = await http().get(`/api/students/${st.id}/bill?yearId=${year.id}&asOf=2026-04-01`).set(auth).expect(200);
    expect(bill.body.installments.map((i: { charges: string }) => i.charges)).toEqual(['14700.00', '6700.00', '6700.00', '6700.00']);
    expect(bill.body.installments[0].lines).toContainEqual({ feeHeadId: -facilityId, name: routeName, amount: '700.00' });

    // Switching off transport clears the fee.
    await http().put(`/api/students/${st.id}/facilities`).set(auth).send({ yearId: year.id, kind: 'TRANSPORT' }).expect(200);
    const cleared = await http().get(`/api/students/${st.id}/bill?yearId=${year.id}&asOf=2026-04-01`).set(auth).expect(200);
    expect(cleared.body.installments[0].charges).toBe('14000.00');
  });
});
