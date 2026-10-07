import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { GuardiansModule } from './../src/guardians/guardians.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Student profile fields, guardians, occupations, subjects. Builds its own two schools and removes them after.
describe('students ext: profile fields, guardians, occupations, subjects (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tag = `SX${Date.now()}`;
  let base = '';
  const http = () => request(base);
  const hdr: Record<string, { Authorization: string }> = {};
  let a: { schoolId: number; yearId: number; sectionId: number };
  let b: { schoolId: number };
  let studentId: number;

  const login = async (username: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password: 'pass12345' })).body.token}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule, GuardiansModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const year = await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } });
    const sa = await prisma.school.create({ data: { code: `${tag}A`, name: 'SX A' } });
    const sb = await prisma.school.create({ data: { code: `${tag}B`, name: 'SX B' } });
    const std = await prisma.standard.create({ data: { schoolId: sa.id, name: 'X1', sortOrder: 1 } });
    const sec = await prisma.section.create({ data: { standardId: std.id, name: 'A' } });
    a = { schoolId: sa.id, yearId: year.id, sectionId: sec.id };
    b = { schoolId: sb.id };
    const passwordHash = await bcrypt.hash('pass12345', 4);
    for (const [name, role, schoolId] of [['acc', 'ACCOUNTANT', sa.id], ['view', 'VIEWER', sa.id], ['accb', 'ACCOUNTANT', sb.id], ['adm', 'ADMIN', sa.id]] as const) {
      await prisma.user.create({ data: { username: `${tag}${name}`.toLowerCase(), passwordHash, role, schoolId } });
      hdr[name] = await login(`${tag}${name}`.toLowerCase());
    }
  });

  afterAll(async () => {
    const ids = [a.schoolId, b.schoolId];
    await prisma.enrollment.deleteMany({ where: { student: { schoolId: { in: ids } } } });
    await prisma.student.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.occupation.deleteMany({ where: { schoolId: { in: ids }, parentId: { not: null } } });
    await prisma.occupation.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.subject.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.section.deleteMany({ where: { standard: { schoolId: { in: ids } } } });
    await prisma.standard.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.user.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('creates a student with the new profile fields and lists them back', async () => {
    const body = {
      schoolId: a.schoolId, yearId: a.yearId, admissionNo: 'SX-1', name: 'Asha', sectionId: a.sectionId, isNewAdmission: false, optionalHeadIds: [],
      gender: 'F', religion: 'Christian', category: 'GEN', nationality: 'INDIAN', aadhaar: '123412341234', penNo: 'PEN1', cbseRegNo: 'CB1',
      address: '1 Main St', admissionDate: '2024-06-01', fatherEmail: 'f@x.com', motherEmail: 'm@x.com', familyId: 4242,
    };
    const created = await http().post('/api/students').set(hdr.acc).send(body).expect(201);
    studentId = created.body.id;
    expect(created.body).toMatchObject({ gender: 'F', religion: 'Christian', penNo: 'PEN1', familyId: 4242, fatherEmail: 'f@x.com' });
    expect(created.body.admissionDate).toBe('2024-06-01T00:00:00.000Z');

    const list = await http().get(`/api/students?schoolId=${a.schoolId}&yearId=${a.yearId}`).set(hdr.acc).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ aadhaar: '123412341234', address: '1 Main St', nationality: 'INDIAN', category: 'GEN' });
  });

  it('updates the new fields and rejects bad values', async () => {
    const patched = await http().patch(`/api/students/${studentId}`).set(hdr.acc)
      .send({ yearId: a.yearId, religion: 'Hindu', gender: 'OTHER', admissionDate: '2025-01-02' }).expect(200);
    expect(patched.body).toMatchObject({ religion: 'Hindu', gender: 'OTHER' });
    expect(patched.body.admissionDate).toBe('2025-01-02T00:00:00.000Z');
    await http().patch(`/api/students/${studentId}`).set(hdr.acc).send({ yearId: a.yearId, gender: 'X' }).expect(400);
    await http().patch(`/api/students/${studentId}`).set(hdr.acc).send({ yearId: a.yearId, fatherEmail: 'nope' }).expect(400);
    await http().patch(`/api/students/${studentId}`).set(hdr.view).send({ yearId: a.yearId, religion: 'X' }).expect(403);
  });

  let occParent: number, occChild: number, guardianId: number;
  it('occupations: admin-only writes, one level of nesting, school scoped', async () => {
    await http().post('/api/occupations').set(hdr.acc).send({ schoolId: a.schoolId, name: 'Pro' }).expect(403);
    occParent = (await http().post('/api/occupations').set(hdr.adm).send({ schoolId: a.schoolId, name: 'Professional' }).expect(201)).body.id;
    occChild = (await http().post('/api/occupations').set(hdr.adm).send({ schoolId: a.schoolId, name: 'Engineer', parentId: occParent }).expect(201)).body.id;
    // a grandchild is refused
    await http().post('/api/occupations').set(hdr.adm).send({ schoolId: a.schoolId, name: 'Civil', parentId: occChild }).expect(400);
    // duplicate name -> 409
    await http().post('/api/occupations').set(hdr.adm).send({ schoolId: a.schoolId, name: 'Engineer' }).expect(409);
    const list = await http().get(`/api/occupations?schoolId=${a.schoolId}`).set(hdr.view).expect(200);
    expect(list.body.map((o: { name: string }) => o.name)).toEqual(['Engineer', 'Professional']);
    await http().get(`/api/occupations?schoolId=${a.schoolId}`).set(hdr.accb).expect(403);
  });

  it('guardians: CRUD, validation, occupation must be of the same school', async () => {
    const g = await http().post(`/api/students/${studentId}/guardians`).set(hdr.acc)
      .send({ name: 'Raj', relation: 'FATHER', mobile: '9000000001', occupationId: occChild, isStaff: true, staffBranch: 'Main' }).expect(201);
    guardianId = g.body.id;
    expect(g.body).toMatchObject({ studentId, isStaff: true, staffBranch: 'Main', occupationId: occChild });
    await http().post(`/api/students/${studentId}/guardians`).set(hdr.acc).send({ name: 'X', relation: 'UNCLE' }).expect(400);
    await http().post(`/api/students/${studentId}/guardians`).set(hdr.view).send({ name: 'X', relation: 'MOTHER' }).expect(403);
    await http().post(`/api/students/${studentId}/guardians`).set(hdr.accb).send({ name: 'X', relation: 'MOTHER' }).expect(403);

    const otherOcc = await prisma.occupation.create({ data: { schoolId: b.schoolId, name: 'Other' } });
    await http().post(`/api/students/${studentId}/guardians`).set(hdr.acc).send({ name: 'M', relation: 'MOTHER', occupationId: otherOcc.id }).expect(400);

    await http().patch(`/api/guardians/${guardianId}`).set(hdr.acc).send({ designation: 'Lead' }).expect(200);
    const list = await http().get(`/api/students/${studentId}/guardians`).set(hdr.view).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].designation).toBe('Lead');
    await http().get(`/api/students/${studentId}/guardians`).set(hdr.accb).expect(403);

    // in-use occupation cannot be deleted
    await http().delete(`/api/occupations/${occChild}`).set(hdr.adm).expect(409);
    await http().delete(`/api/guardians/${guardianId}`).set(hdr.acc).expect(200);
    await http().delete(`/api/occupations/${occChild}`).set(hdr.adm).expect(200);
  });

  it('subjects: catalogue + per-student assignment replaces the set, foreign subjects refused', async () => {
    const mk = (name: string, kind: string) => http().post('/api/subjects').set(hdr.adm).send({ schoolId: a.schoolId, name, kind }).expect(201);
    const hindi = (await mk('Hindi', 'LANGUAGE')).body.id;
    const music = (await mk('Music', 'ADDITIONAL')).body.id;
    await http().post('/api/subjects').set(hdr.adm).send({ schoolId: a.schoolId, name: 'Bad', kind: 'NOPE' }).expect(400);
    const foreign = await prisma.subject.create({ data: { schoolId: b.schoolId, name: 'Foreign', kind: 'CORE' } });

    await http().put(`/api/students/${studentId}/subjects`).set(hdr.acc).send({ yearId: a.yearId, subjectIds: [hindi, music] }).expect(200);
    let got = await http().get(`/api/students/${studentId}/subjects?yearId=${a.yearId}`).set(hdr.view).expect(200);
    expect(got.body.map((s: { name: string }) => s.name).sort()).toEqual(['Hindi', 'Music']);
    await http().put(`/api/students/${studentId}/subjects`).set(hdr.acc).send({ yearId: a.yearId, subjectIds: [hindi] }).expect(200);
    got = await http().get(`/api/students/${studentId}/subjects?yearId=${a.yearId}`).set(hdr.view).expect(200);
    expect(got.body.map((s: { name: string }) => s.name)).toEqual(['Hindi']);
    await http().put(`/api/students/${studentId}/subjects`).set(hdr.acc).send({ yearId: a.yearId, subjectIds: [foreign.id] }).expect(400);
    await http().put(`/api/students/${studentId}/subjects`).set(hdr.view).send({ yearId: a.yearId, subjectIds: [] }).expect(403);
    // a student with no enrollment in that year
    const other = await prisma.academicYear.upsert({ where: { label: '2097-98' }, update: {}, create: { label: '2097-98', startDate: new Date('2097-04-01'), endDate: new Date('2098-03-31') } });
    await http().put(`/api/students/${studentId}/subjects`).set(hdr.acc).send({ yearId: other.id, subjectIds: [] }).expect(400);
    // in-use subject refused, then freed
    await http().delete(`/api/subjects/${hindi}`).set(hdr.adm).expect(409);
    await http().put(`/api/students/${studentId}/subjects`).set(hdr.acc).send({ yearId: a.yearId, subjectIds: [] }).expect(200);
    await http().delete(`/api/subjects/${hindi}`).set(hdr.adm).expect(200);
    await prisma.academicYear.deleteMany({ where: { label: '2097-98', enrollments: { none: {} }, payments: { none: {} } } });
  });
});
