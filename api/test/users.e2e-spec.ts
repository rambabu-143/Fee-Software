import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Needs the seeded demo DB. Cleans up users named e2e-*.
describe('users (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    await prisma.user.deleteMany({ where: { username: { startsWith: 'e2e-' } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: 'e2e-' } } });
    await app.close();
  });

  it('enforces school scoping, role limits, and instant deactivation', async () => {
    const root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    const [s1, s2] = await Promise.all(['DEMO1', 'DEMO2'].map((code) => prisma.school.findUniqueOrThrow({ where: { code } })));

    await http().post('/api/users').set(root).send({ username: 'e2e-admin', password: 'short', role: 'ADMIN', schoolId: s1.id }).expect(400);
    await http().post('/api/users').set(root).send({ username: 'e2e-admin', password: 'password1', role: 'ADMIN' }).expect(400); // no school
    const { body: admin } = await http().post('/api/users').set(root)
      .send({ username: 'e2e-admin', password: 'password1', role: 'ADMIN', schoolId: s1.id }).expect(201);
    expect(admin).not.toHaveProperty('passwordHash');
    await http().post('/api/users').set(root).send({ username: 'e2e-admin', password: 'password1', role: 'ADMIN', schoolId: s1.id }).expect(409);

    const a = await login('e2e-admin', 'password1');
    await http().post('/api/users').set(a).send({ username: 'e2e-root', password: 'password1', role: 'SUPERADMIN' }).expect(403);
    await http().post('/api/users').set(a).send({ username: 'e2e-other', password: 'password1', role: 'VIEWER', schoolId: s2.id }).expect(403);
    const { body: acc } = await http().post('/api/users').set(a).send({ username: 'e2e-acc', password: 'password1', role: 'ACCOUNTANT' }).expect(201);
    expect(acc.schoolId).toBe(s1.id); // defaulted to the admin's school
    const list = await http().get('/api/users').set(a).expect(200);
    expect(list.body.every((x: { schoolId: number }) => x.schoolId === s1.id)).toBe(true);
    await http().patch(`/api/users/${admin.id}`).set(a).send({ active: false }).expect(400); // not yourself

    const t = await login('e2e-acc', 'password1');
    await http().get('/api/users').set(t).expect(403); // accountants can't manage users
    await http().get('/api/auth/me').set(t).expect(200);
    await http().patch(`/api/users/${acc.id}`).set(a).send({ active: false }).expect(200);
    await http().get('/api/auth/me').set(t).expect(401); // existing token dies immediately

    await http().patch(`/api/users/${acc.id}`).set(a).send({ active: true, password: 'newpassword' }).expect(200);
    await login('e2e-acc', 'newpassword');
  });
});
