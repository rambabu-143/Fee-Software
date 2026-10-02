import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Needs the seeded demo DB. Cleans up the students it creates.
describe('students & bills (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());
  const admissionNo = `E2E-${Date.now()}`;

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
    const s = await prisma.student.findMany({ where: { admissionNo: { startsWith: 'E2E-' } } });
    const ids = s.map((x) => x.id);
    await prisma.paymentAllocation.deleteMany({ where: { payment: { studentId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: ids } } });
    // Rewind receipt numbers so the demo DB doesn't show gaps from test receipts.
    for (const c of await prisma.receiptCounter.findMany()) {
      const max = await prisma.payment.aggregate({ where: { schoolId: c.schoolId, yearId: c.yearId }, _max: { receiptNo: true } });
      await prisma.receiptCounter.update({ where: { schoolId_yearId: { schoolId: c.schoolId, yearId: c.yearId } }, data: { last: max._max.receiptNo ?? 0 } });
    }
    await prisma.student.deleteMany({ where: { id: { in: s.map((x) => x.id) } } });
    await prisma.academicYear.deleteMany({ where: { label: '2099-00' } });
    await app.close();
  });

  async function ctx(code: string) {
    const school = await prisma.school.findUniqueOrThrow({ where: { code } });
    const year = await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } });
    const std = await prisma.standard.findFirstOrThrow({ where: { schoolId: school.id, name: 'Class 1' }, include: { sections: true } });
    const computer = await prisma.feeHead.findFirstOrThrow({ where: { schoolId: school.id, name: 'Computer Fee' } });
    return { schoolId: school.id, yearId: year.id, sectionId: std.sections[0].id, computerId: computer.id };
  }

  it('admits a student and bills them from the fee grid', async () => {
    const c = await ctx('DEMO1');
    const created = await http().post('/api/students').set(auth).send({
      schoolId: c.schoolId, yearId: c.yearId, admissionNo, name: 'Test Pupil',
      sectionId: c.sectionId, isNewAdmission: false, optionalHeadIds: [c.computerId],
    }).expect(201);

    // Seed grid for Class 1 (sortOrder 2): tuition 6000 x4, annual 8000 once, computer 1000 x4.
    const bill = await http().get(`/api/students/${created.body.id}/bill?yearId=${c.yearId}&asOf=2026-04-01`).set(auth).expect(200);
    expect(bill.body.installments.map((i: { charges: string }) => i.charges)).toEqual(['15000.00', '7000.00', '7000.00', '7000.00']);
    expect(bill.body.totals).toEqual({ charges: '36000.00', fine: '0.00', paid: '0.00', due: '36000.00' });

    // First installment fine starts 2026-04-20 at 10/day -> 3 days by 04-22.
    const late = await http().get(`/api/students/${created.body.id}/bill?yearId=${c.yearId}&asOf=2026-04-22`).set(auth).expect(200);
    expect(late.body.installments[0]).toMatchObject({ fineDays: 3, fine: '30.00', due: '15030.00' });

    const list = await http().get(`/api/students?schoolId=${c.schoolId}&yearId=${c.yearId}&q=${admissionNo}`).set(auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].enrollment).toMatchObject({ className: 'Class 1 A', optionalHeadIds: [c.computerId] });
  });

  it("rejects another school's section and duplicate admission numbers", async () => {
    const c1 = await ctx('DEMO1');
    const c2 = await ctx('DEMO2');
    const body = { schoolId: c1.schoolId, yearId: c1.yearId, name: 'X', isNewAdmission: false, optionalHeadIds: [] };
    await http().post('/api/students').set(auth).send({ ...body, admissionNo: `E2E-x${Date.now()}`, sectionId: c2.sectionId }).expect(400);
    await http().post('/api/students').set(auth).send({ ...body, admissionNo, sectionId: c1.sectionId }).expect(409);
  });

  it('promotes into a new year only with a section', async () => {
    const c = await ctx('DEMO1');
    const st = await prisma.student.findFirstOrThrow({ where: { admissionNo } });
    const next = await prisma.academicYear.create({ data: { label: '2099-00', startDate: new Date('2099-04-01'), endDate: new Date('2100-03-31') } });
    await http().patch(`/api/students/${st.id}`).set(auth).send({ yearId: next.id }).expect(400);
    await http().patch(`/api/students/${st.id}`).set(auth).send({ yearId: next.id, sectionId: c.sectionId }).expect(200);
    expect(await prisma.enrollment.count({ where: { studentId: st.id } })).toBe(2);
  });

  it('collects, allocates oldest-first, freezes the fine, and cancels', async () => {
    const c = await ctx('DEMO1');
    const { body: st } = await http().post('/api/students').set(auth).send({
      schoolId: c.schoolId, yearId: c.yearId, admissionNo: `${admissionNo}-P`, name: 'Payer',
      sectionId: c.sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);
    const pay = (b: object) => http().post('/api/payments').set(auth).send({ studentId: st.id, yearId: c.yearId, ...b });

    await pay({ amount: 100, mode: 'CHEQUE', date: '2026-04-22' }).expect(400); // no reference
    await pay({ amount: 100, mode: 'CASH', date: '2999-01-01' }).expect(400); // future
    await pay({ amount: 1e7, mode: 'CASH', date: '2026-04-22' }).expect(400); // more than due

    // Class 1 without computer fee: first installment 14000 + 3 days fine 30.
    const r = await pay({ amount: 14530, mode: 'UPI', reference: 'TXN123', date: '2026-04-22' }).expect(201);
    expect(r.body.allocations).toEqual([
      { installment: 'First (Apr-Jun)', charges: '14000.00', fine: '30.00' },
      { installment: 'Second (Jul-Sep)', charges: '500.00', fine: '0.00' },
    ]);
    await http().get(`/api/payments/${r.body.id}/pdf`).set(auth).expect(200).expect('Content-Type', 'application/pdf');
    await http().get(`/api/students/${st.id}/bill.pdf?yearId=${c.yearId}`).set(auth).expect(200).expect('Content-Type', 'application/pdf');
    await pay({ amount: 10, mode: 'CASH', date: '2026-04-21' }).expect(400); // backdated before a receipt

    const bill = await http().get(`/api/students/${st.id}/bill?yearId=${c.yearId}&asOf=2026-05-30`).set(auth).expect(200);
    expect(bill.body.installments[0]).toMatchObject({ fine: '30.00', paid: '14030.00', due: '0.00' });

    const q = `schoolId=${c.schoolId}&yearId=${c.yearId}`;
    const coll = await http().get(`/api/reports/collection?${q}&from=2026-04-22&to=2026-04-22`).set(auth).expect(200);
    expect(coll.body).toContainEqual({ date: '2026-04-22', mode: 'UPI', receipts: 1, amount: '14530.00' });
    // As of 05-30 only the first installment is past due, and it's cleared; 5500 + 6000 + 6000 is still to come.
    const dues = await http().get(`/api/reports/dues?${q}&asOf=2026-05-30`).set(auth).expect(200);
    expect(dues.body.find((d: { studentId: number }) => d.studentId === st.id)).toMatchObject({ overdue: '0.00', due: '17500.00', fine: '30.00' });

    await http().post(`/api/payments/${r.body.id}/cancel`).set(auth).send({ reason: 'bounced' }).expect(201);
    await http().post(`/api/payments/${r.body.id}/cancel`).set(auth).send({ reason: 'again' }).expect(400);
    const after = await http().get(`/api/students/${st.id}/bill?yearId=${c.yearId}&asOf=2026-04-22`).set(auth).expect(200);
    expect(after.body.totals.paid).toBe('0.00');
  });

  it('applies concessions to the bill', async () => {
    const c = await ctx('DEMO1');
    const tuition = await prisma.feeHead.findFirstOrThrow({ where: { schoolId: c.schoolId, name: 'Tuition Fee' } });
    const { body: st } = await http().post('/api/students').set(auth).send({
      schoolId: c.schoolId, yearId: c.yearId, admissionNo: `${admissionNo}-C`, name: 'Scholar',
      sectionId: c.sectionId, isNewAdmission: false, optionalHeadIds: [],
    }).expect(201);
    const put = (items: object[]) => http().put(`/api/students/${st.id}/concessions`).set(auth).send({ yearId: c.yearId, items });

    await put([{ feeHeadId: tuition.id, percent: 10, amount: 100, reason: 'Both' }]).expect(400);
    await put([{ feeHeadId: tuition.id, reason: 'Neither' }]).expect(400);
    await put([{ feeHeadId: tuition.id, percent: 50, reason: 'Staff ward' }]).expect(200);

    // Class 1: tuition 6000 x4 halved, annual 8000 untouched.
    const bill = await http().get(`/api/students/${st.id}/bill?yearId=${c.yearId}&asOf=2026-04-01`).set(auth).expect(200);
    expect(bill.body.installments.map((i: { charges: string }) => i.charges)).toEqual(['11000.00', '3000.00', '3000.00', '3000.00']);

    await put([]).expect(200);
    const { body: list } = await http().get(`/api/students/${st.id}/concessions?yearId=${c.yearId}`).set(auth).expect(200);
    expect(list).toEqual([]);
  });
});
