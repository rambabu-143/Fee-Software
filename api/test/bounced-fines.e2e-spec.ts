import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// A bounced cheque's fine is not collected fine: /reports/fines must drop it, like every other money report.
describe('fines report ignores bounced receipts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZBF${Date.now()}`;
  let auth: { Authorization: string };
  let schoolId = 0, yearId = 0, studentId = 0, bankId = 0;

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

    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Bounced fine school' } })).id;
    yearId = (await prisma.academicYear.create({ data: { label: tag, startDate: new Date('2025-04-01'), endDate: new Date('2026-03-31') } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'One', sortOrder: 1 } });
    const sectionId = (await prisma.section.create({ data: { standardId: std.id, name: 'A' } })).id;
    const head = await prisma.feeHead.create({ data: { schoolId, name: 'Tuition', type: 'MONTHLY' } });
    const inst = await prisma.installment.create({
      data: { schoolId, yearId, number: 1, label: 'I1', dueDate: new Date('2025-04-10'), fineStartDate: new Date('2025-04-15'), finePerDay: '10.00' },
    });
    await prisma.feeStructure.create({ data: { yearId, standardId: std.id, feeHeadId: head.id, installmentId: inst.id, amount: '1000.00' } });
    studentId = (await prisma.student.create({ data: { schoolId, admissionNo: `${tag}-1`, name: 'Fined' } })).id;
    await prisma.enrollment.create({ data: { studentId, yearId, sectionId } });
    bankId = (await prisma.bank.create({ data: { schoolId, name: 'Test Bank' } })).id;
  });

  afterAll(async () => {
    await prisma.deposit.deleteMany({ where: { studentId } });
    await prisma.paymentAllocation.deleteMany({ where: { payment: { schoolId } } });
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId } });
    await prisma.enrollment.deleteMany({ where: { yearId } });
    await prisma.student.deleteMany({ where: { schoolId } });
    await prisma.feeStructure.deleteMany({ where: { yearId } });
    await prisma.installment.deleteMany({ where: { schoolId } });
    await prisma.section.deleteMany({ where: { standard: { schoolId } } });
    await prisma.standard.deleteMany({ where: { schoolId } });
    await prisma.feeHead.deleteMany({ where: { schoolId } });
    await prisma.bank.deleteMany({ where: { schoolId } });
    await prisma.academicYear.delete({ where: { id: yearId } });
    await prisma.school.delete({ where: { id: schoolId } });
    await app.close();
  });

  const fines = async () => (await http().get(`/api/reports/fines?schoolId=${schoolId}&yearId=${yearId}`).set(auth).expect(200)).body;

  it('fine counts while the cheque is live, and disappears when it bounces', async () => {
    const pay = await http().post('/api/payments').set(auth)
      .send({ studentId, yearId, amount: 200, mode: 'CHEQUE', date: '2025-04-17', bankId, chequeNo: 'BF1', reference: 'BF1' }).expect(201);
    expect(pay.body.allocations).toEqual([{ installment: 'I1', charges: '170.00', fine: '30.00' }]); // 3 days x 10, fine first
    expect((await fines()).totals).toEqual({ count: 1, fine: '30.00' });

    await http().post(`/api/payments/${pay.body.id}/reconcile`).set(auth).send({ status: 'BOUNCED', bankDate: '2025-04-18' }).expect(201);
    expect(await fines()).toEqual({ rows: [], totals: { count: 0, fine: '0.00' } });

    // ...and a bounced receipt is not a live receipt to hang a deposit on either
    await http().post('/api/deposits').set(auth)
      .send({ studentId, kind: 'CAUTION', amount: 100, receivedYearId: yearId, paymentId: pay.body.id }).expect(400);
  });
});
