import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// A carried previous-year arrear must show up in /reports/dues and make the student a defaulter,
// even when the new year has no overdue installment of its own. Own throwaway school and years.
describe('arrears in dues + defaulters (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZAD${Date.now()}`;
  let auth: { Authorization: string };
  let schoolId = 0, fromYearId = 0, toYearId = 0, studentId = 0, enrollmentId = 0;

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

    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Arrear dues school' } })).id;
    fromYearId = (await prisma.academicYear.create({ data: { label: `${tag}-F`, startDate: new Date('2001-04-01'), endDate: new Date('2002-03-31') } })).id;
    toYearId = (await prisma.academicYear.create({ data: { label: `${tag}-T`, startDate: new Date('2002-04-01'), endDate: new Date('2003-03-31') } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'One', sortOrder: 1 } });
    const sectionId = (await prisma.section.create({ data: { standardId: std.id, name: 'A' } })).id;
    studentId = (await prisma.student.create({ data: { schoolId, admissionNo: `${tag}-1`, name: 'Arrear Only' } })).id;
    enrollmentId = (await prisma.enrollment.create({ data: { studentId, yearId: toYearId, sectionId } })).id;
    await http().patch(`/api/arrears/${enrollmentId}`).set(auth).send({ amount: 500, reason: 'carried', fromYearId }).expect(200);
  });

  afterAll(async () => {
    await prisma.paymentAllocation.deleteMany({ where: { payment: { schoolId } } });
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId } });
    await prisma.arrearCarry.deleteMany({ where: { enrollmentId } });
    await prisma.enrollment.deleteMany({ where: { id: enrollmentId } });
    await prisma.student.deleteMany({ where: { schoolId } });
    await prisma.section.deleteMany({ where: { standard: { schoolId } } });
    await prisma.standard.deleteMany({ where: { schoolId } });
    await prisma.academicYear.deleteMany({ where: { id: { in: [fromYearId, toYearId] } } });
    await prisma.school.delete({ where: { id: schoolId } });
    await app.close();
  });

  const dues = async () => (await http().get(`/api/reports/dues?schoolId=${schoolId}&yearId=${toYearId}`).set(auth).expect(200)).body[0];
  const defaulters = async () => (await http().get(`/api/defaulters?schoolId=${schoolId}&yearId=${toYearId}`).set(auth).expect(200)).body as { studentId: number; overdue: string }[];

  it('arrear-only student: dues report and defaulters list both show the 500', async () => {
    expect(await dues()).toMatchObject({ charges: '500.00', paid: '0.00', due: '500.00', overdue: '500.00' });
    expect(await defaulters()).toEqual([expect.objectContaining({ studentId, overdue: '500.00' })]);
  });

  it('per-installment view leaves the arrear out', async () => {
    const inst = await prisma.installment.create({ data: { schoolId, yearId: toYearId, number: 1, label: 'I1', dueDate: new Date('2002-04-10') } });
    const r = (await http().get(`/api/reports/dues?schoolId=${schoolId}&yearId=${toYearId}&installmentId=${inst.id}`).set(auth).expect(200)).body;
    expect(r.every((x: { due: string }) => x.due === '0.00')).toBe(true);
    await prisma.installment.delete({ where: { id: inst.id } });
  });

  it('paying the arrear clears dues and drops the student from defaulters', async () => {
    await http().post('/api/payments').set(auth).send({ studentId, yearId: toYearId, amount: 500, mode: 'CASH' }).expect(201);
    expect(await dues()).toMatchObject({ charges: '500.00', paid: '500.00', due: '0.00', overdue: '0.00' });
    expect(await defaulters()).toEqual([]);
  });
});
