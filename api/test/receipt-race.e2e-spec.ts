import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Receipt numbers: many parallel FIRST collections in a brand-new school+year must get 1..N exactly once,
// and a counter that lags receipts inserted outside the API must self-heal instead of 409-ing forever.
// Own throwaway school/year, so the shared demo data and its "gap-free" assertions are untouched.
describe('receipt numbers under load (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZRR${Date.now()}`;
  let auth: { Authorization: string };
  let schoolId = 0, yearId = 0, sectionId = 0;
  let n = 0;

  const student = async () => {
    const s = await prisma.student.create({ data: { schoolId, admissionNo: `${tag}-${++n}`, name: `RR ${n}` } });
    await prisma.enrollment.create({ data: { studentId: s.id, yearId, sectionId } });
    return s.id;
  };
  const pay = (studentId: number) =>
    http().post('/api/payments').set(auth).send({ studentId, yearId, amount: 100, mode: 'CASH', date: '2025-05-01' });

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

    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Receipt race school' } })).id;
    yearId = (await prisma.academicYear.create({ data: { label: tag, startDate: new Date('2025-04-01'), endDate: new Date('2026-03-31') } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'One', sortOrder: 1 } });
    sectionId = (await prisma.section.create({ data: { standardId: std.id, name: 'A' } })).id;
    const head = await prisma.feeHead.create({ data: { schoolId, name: 'Tuition', type: 'MONTHLY' } });
    const inst = await prisma.installment.create({ data: { schoolId, yearId, number: 1, label: 'I1', dueDate: new Date('2025-04-10') } });
    await prisma.feeStructure.create({ data: { yearId, standardId: std.id, feeHeadId: head.id, installmentId: inst.id, amount: '5000.00' } });
  });

  afterAll(async () => {
    const where = { schoolId };
    await prisma.paymentAllocation.deleteMany({ where: { payment: where } });
    await prisma.payment.deleteMany({ where });
    await prisma.receiptCounter.deleteMany({ where });
    await prisma.enrollment.deleteMany({ where: { yearId } });
    await prisma.student.deleteMany({ where });
    await prisma.feeStructure.deleteMany({ where: { yearId } });
    await prisma.installment.deleteMany({ where });
    await prisma.section.deleteMany({ where: { standard: where } });
    await prisma.standard.deleteMany({ where });
    await prisma.feeHead.deleteMany({ where });
    await prisma.academicYear.delete({ where: { id: yearId } });
    await prisma.school.delete({ where: { id: schoolId } });
    await app.close();
  });

  it('40 parallel first collections get receipt numbers 1..40, no 409s', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, student));
    const res = await Promise.all(ids.map(pay));
    expect(res.map((r) => r.status).filter((s) => s !== 201)).toEqual([]);
    expect(res.map((r) => r.body.receiptNo).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('a counter that lags an out-of-band receipt self-heals (was: 409 on every collection)', async () => {
    const [a, b] = [await student(), await student()];
    const max = (await prisma.payment.aggregate({ where: { schoolId, yearId }, _max: { receiptNo: true } }))._max.receiptNo!;
    await prisma.receiptCounter.update({ where: { schoolId_yearId: { schoolId, yearId } }, data: { last: 1 } }); // simulate lag
    await prisma.payment.create({ data: { schoolId, yearId, studentId: a, receiptNo: max + 1, date: new Date('2025-04-02'), mode: 'CASH', amount: '10.00', createdBy: 'sql' } });
    const r = await pay(b);
    expect(r.status).toBe(201);
    expect(r.body.receiptNo).toBe(max + 2);
  });
});
