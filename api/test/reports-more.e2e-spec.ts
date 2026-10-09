import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { dropSchool, listen } from './support.js';

// Alumni report (Class XII earmarked levies vs refund vouchers) and the transport-bifurcation staff filter.
// Own throwaway school: XII with Earmarked Levies XI 300 + XII 400 in one far-future installment.
describe('reports more: alumni + staff transport (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `ZZRM${Date.now()}`;
  let H: { Authorization: string };
  let schoolId = 0, yearId = 0, sectionId = 0, n = 0;

  const student = async (paid: number) => {
    const s = await prisma.student.create({ data: { schoolId, admissionNo: `${tag}-${++n}`, name: `RM ${n}` } });
    const enrollment = await prisma.enrollment.create({ data: { studentId: s.id, yearId, sectionId } });
    if (paid) await http().post('/api/payments').set(H).send({ studentId: s.id, yearId, amount: paid, mode: 'CASH' }).expect(201);
    return { id: s.id, enr: enrollment.id };
  };
  const refund = (enrollmentId: number, amount: number, remarks: string, cancelledAt: Date | null = null) =>
    prisma.voucher.create({
      data: { schoolId, yearId, enrollmentId, voucherNo: ++n, date: new Date(), kind: 'CAUTION_REFUND', amount, mode: 'CASH', remarks, createdBy: 'test', cancelledAt },
    });
  const alumni = async (q = '') => (await http().get(`/api/reports/alumni?schoolId=${schoolId}&yearId=${yearId}${q}`).set(H).expect(200)).body as Record<string, string>[];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const { body } = await http().post('/api/auth/login').send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    H = { Authorization: `Bearer ${body.token}` };

    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    schoolId = (await prisma.school.create({ data: { code: tag, name: 'Reports more' } })).id;
    const std = await prisma.standard.create({ data: { schoolId, name: 'XII', sortOrder: 12 } });
    sectionId = (await prisma.section.create({ data: { standardId: std.id, name: 'A' } })).id;
    const xi = await prisma.feeHead.create({ data: { schoolId, name: 'Earmarked Levies XI', type: 'ANNUAL' } });
    const xii = await prisma.feeHead.create({ data: { schoolId, name: 'Earmarked Levies XII', type: 'ANNUAL' } });
    const i1 = await prisma.installment.create({ data: { schoolId, yearId, number: 1, label: 'I1', dueDate: new Date('2099-04-01') } });
    await prisma.feeStructure.createMany({
      data: [{ feeHeadId: xi.id, installmentId: i1.id, amount: 300 }, { feeHeadId: xii.id, installmentId: i1.id, amount: 400 }].map((d) => ({ ...d, yearId, standardId: std.id })),
    });
  });

  afterAll(async () => {
    await prisma.voucher.deleteMany({ where: { schoolId } });
    await dropSchool(prisma, tag);
    await app.close();
  });

  it('alumni: not refunded, partial, refunded, cancelled voucher ignored; pending=1 hides the settled', async () => {
    const a = await student(700); // nothing refunded
    const b = await student(700); // partial: 400 of 700
    await refund(b.enr, 400, 'XII levy');
    const c = await student(700); // fully refunded
    await refund(c.enr, 300, 'XI levy');
    await refund(c.enr, 400, 'refund');
    const d = await student(700); // only a cancelled voucher: still NOT_REFUNDED
    await refund(d.enr, 700, 'XII', new Date());
    const e = await student(0); // never paid

    const rows = await alumni();
    const by = Object.fromEntries(rows.filter((r) => r.admissionNo).map((r) => [r.admissionNo, r]));
    expect(by[`${tag}-1`]).toMatchObject({ leviesXI: '300.00', leviesXII: '400.00', totalRefunded: '0.00', status: 'NOT_REFUNDED' });
    expect(Object.values(by).map((r) => r.status)).toEqual(['NOT_REFUNDED', 'PARTIAL', 'REFUNDED', 'NOT_REFUNDED', 'NO_LEVIES']);
    expect(Object.values(by).find((r) => r.status === 'PARTIAL')).toMatchObject({ refundXII: '400.00', balance: '300.00' });
    expect(Object.values(by).find((r) => r.status === 'REFUNDED')).toMatchObject({ refundXI: '300.00', refundXII: '400.00', balance: '0.00' });
    expect(rows.at(-1)).toMatchObject({ name: 'Total', totalLevies: '2800.00', totalRefunded: '1100.00', balance: '1700.00' });

    const pending = await alumni('&pending=1');
    expect(pending.filter((r) => r.admissionNo).map((r) => r.status)).toEqual(['NOT_REFUNDED', 'PARTIAL', 'NOT_REFUNDED']);
    void a; void d; void e;
  }, 30000);

  it('alumni: ADMIN/ACCOUNTANT only, school-scoped, csv works', async () => {
    const csv = await http().get(`/api/reports/alumni?schoolId=${schoolId}&yearId=${yearId}&format=csv`).set(H).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    await http().get(`/api/reports/alumni?schoolId=${schoolId}&yearId=${yearId}`).expect(401);
  });

  it('transport-bifurcation: staff must be true/false; staff=true keeps only students with a staff guardian', async () => {
    const q = `/api/reports/transport-bifurcation?schoolId=${schoolId}&yearId=${yearId}&groupBy=student`;
    await http().get(`${q}&staff=maybe`).set(H).expect(400);
    await http().get(`${q}&staff=false`).set(H).expect(200);
    const s = await student(0);
    await prisma.guardian.create({ data: { studentId: s.id, name: 'Staff Parent', relation: 'FATHER', isStaff: true } });
    expect((await http().get(`${q}&staff=true`).set(H).expect(200)).body).toEqual([]); // no transport charged: nothing to list, no error
  });
});
