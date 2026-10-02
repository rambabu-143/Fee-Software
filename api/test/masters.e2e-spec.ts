import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

// Needs the seeded demo DB (npx prisma db seed). Restores anything it changes.
describe('masters (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' });
    auth = { Authorization: `Bearer ${login.body.token}` };
  });

  afterAll(() => app.close());

  async function demo(code: string) {
    const schools = (await http().get('/api/schools').set(auth)).body;
    const schoolId = schools.find((s: { code: string }) => s.code === code).id;
    const yearId = (await http().get('/api/years').set(auth)).body.find((y: { label: string }) => y.label === '2026-27').id;
    const standards = (await http().get(`/api/standards?schoolId=${schoolId}`).set(auth)).body;
    const heads = (await http().get(`/api/fee-heads?schoolId=${schoolId}`).set(auth)).body;
    const insts = (await http().get(`/api/installments?schoolId=${schoolId}&yearId=${yearId}`).set(auth)).body;
    return { schoolId, yearId, standardId: standards[0].id, heads, insts };
  }

  it('saves and reloads a fee grid, dropping zero cells', async () => {
    const d = await demo('DEMO1');
    const url = `/api/fee-structure?yearId=${d.yearId}&standardId=${d.standardId}`;
    const original = (await http().get(url).set(auth)).body;

    const items = [
      { feeHeadId: d.heads[0].id, installmentId: d.insts[0].id, amount: 1234.5 },
      { feeHeadId: d.heads[1].id, installmentId: d.insts[1].id, amount: 0 },
    ];
    const saved = await http()
      .put('/api/fee-structure')
      .set(auth)
      .send({ yearId: d.yearId, standardId: d.standardId, items })
      .expect(200);
    expect(saved.body).toEqual([{ feeHeadId: d.heads[0].id, installmentId: d.insts[0].id, amount: '1234.50' }]);

    await http()
      .put('/api/fee-structure')
      .set(auth)
      .send({ yearId: d.yearId, standardId: d.standardId, items: original.map((r: { amount: string }) => ({ ...r, amount: Number(r.amount) })) })
      .expect(200);
  });

  it("rejects another school's fee head in a class's grid", async () => {
    const d1 = await demo('DEMO1');
    const d2 = await demo('DEMO2');
    await http()
      .put('/api/fee-structure')
      .set(auth)
      .send({
        yearId: d1.yearId,
        standardId: d1.standardId,
        items: [{ feeHeadId: d2.heads[0].id, installmentId: d1.insts[0].id, amount: 100 }],
      })
      .expect(400);
  });

  it('rejects negative amounts and duplicate cells', async () => {
    const d = await demo('DEMO1');
    const cell = { feeHeadId: d.heads[0].id, installmentId: d.insts[0].id };
    const put = (items: object[]) =>
      http().put('/api/fee-structure').set(auth).send({ yearId: d.yearId, standardId: d.standardId, items });
    await put([{ ...cell, amount: -5 }]).expect(400);
    await put([{ ...cell, amount: 5 }, { ...cell, amount: 6 }]).expect(400);
  });

  it('refuses to delete a class that has sections (409), and duplicate names (409)', async () => {
    const d = await demo('DEMO1');
    await http().delete(`/api/standards/${d.standardId}`).set(auth).expect(409);
    await http().post('/api/standards').set(auth).send({ schoolId: d.schoolId, name: 'Nursery', sortOrder: 99 }).expect(409);
  });
});
