import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { listen } from './support.js';

describe('health (e2e)', () => {
  let app: INestApplication;
  let base = '';
  let down = false;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    base = await listen(app);
    // Make the DB ping fail on demand instead of really stopping Postgres.
    const prisma = app.get(PrismaService);
    const real = prisma.$queryRaw.bind(prisma);
    (prisma as { $queryRaw: unknown }).$queryRaw = (...a: unknown[]) =>
      down ? Promise.reject(new Error('connection refused')) : (real as (...x: unknown[]) => unknown)(...a);
  });
  afterAll(() => app.close());

  it('is public and ok while the database answers', async () => {
    const res = await request(base).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database ping fails', async () => {
    down = true;
    try {
      await request(base).get('/api/health').expect(503);
    } finally {
      down = false;
    }
  });
});
