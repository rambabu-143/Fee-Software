import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';

// Needs the seeded DB (npx prisma db seed).
describe('auth (e2e)', () => {
  let base = '';
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
  });

  afterAll(() => app.close());

  it('rejects requests without a token', () =>
    request(base).get('/api/schools').expect(401));

  it('rejects a wrong password', () =>
    request(base)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' })
      .expect(401));

  it('logs in and lists schools', async () => {
    const login = await request(base)
      .post('/api/auth/login')
      .send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' })
      .expect(201);
    const res = await request(base)
      .get('/api/schools')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(res.body.map((s: { code: string }) => s.code)).toContain('DEMO1');
  });
});
