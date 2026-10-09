import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { dropSchool, listen, makeSchool } from './support.js';

// Private school FDSF (42 seeded students, fee grid) so nothing here depends on, or disturbs, the DEMO data.
describe('small fixes: import fields, pagination, concession categories, swagger names (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });
  let admin: Record<string, string>, other: Record<string, string>;
  let schoolId = 0, yearId = 0, feeHeadId = 0;
  let className = '', sectionName = '';

  const cleanup = async () => {
    await dropSchool(prisma, 'FDSF');
    await prisma.user.deleteMany({ where: { username: { startsWith: 'fdsf-' } } });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    app.useBodyParser('json', { limit: '2mb' });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    await cleanup();
    const school = await makeSchool(prisma, 'FDSF');
    schoolId = school.id;
    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    feeHeadId = (await prisma.feeHead.findFirstOrThrow({ where: { schoolId } })).id;
    const sec = await prisma.section.findFirstOrThrow({ where: { standard: { schoolId } }, include: { standard: true } });
    className = sec.standard.name; sectionName = sec.name;
    const s2 = (await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } })).id;
    const root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    for (const [u, sid] of [['admin', schoolId], ['other', s2]] as const) {
      await http().post('/api/users').set(root).send({ username: `fdsf-${u}`, password: 'password1', role: 'ADMIN', schoolId: sid }).expect(201);
    }
    [admin, other] = await Promise.all(['admin', 'other'].map((u) => login(`fdsf-${u}`, 'password1')));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('import: admissionDate and the other new student fields are validated, then saved', async () => {
    const row = (n: number, extra: object = {}) => ({ admissionNo: `FD-IMP-${n}`, name: `Imp Kid ${n}`, standard: className, section: sectionName, ...extra });
    const post = (rows: object[], dry = 'true') => http().post(`/api/import/students?dryRun=${dry}`).set(admin).send({ schoolId, yearId, rows });

    const bad = await post([
      row(1, { admissionDate: '2026-02-31' }), row(2, { gender: 'robot' }), row(3, { fatherEmail: 'nope' }), row(4, { motherEmail: 'x@' }), row(5, { admissionDate: '01/04/2026' }),
    ]).expect(201);
    expect(bad.body.ok).toBe(false);
    const msgs = bad.body.errors.map((e: { row: number; msg: string }) => `${e.row}:${e.msg}`);
    expect(msgs).toEqual([
      '1:admissionDate must be a valid YYYY-MM-DD date', '2:gender must be M, F or OTHER', '3:Invalid fatherEmail', '4:Invalid motherEmail', '5:admissionDate must be a valid YYYY-MM-DD date',
    ]);
    // a live run with bad rows saves nothing
    await post([row(6), row(7, { gender: 'robot' })], 'false').expect(400);
    expect(await prisma.student.count({ where: { admissionNo: { startsWith: 'FD-IMP-' } } })).toBe(0);

    const good = row(8, {
      admissionDate: '2026-04-01', gender: 'Female', religion: 'Hindu', category: 'General', nationality: 'Indian',
      address: '12 Main Rd, Hyderabad', fatherEmail: 'dad@example.com', motherEmail: 'mom@example.com',
    });
    expect((await post([good]).expect(201)).body).toMatchObject({ ok: true, willCreate: 1, willUpdate: 0 });
    await post([good], 'false').expect(201);
    const s = await prisma.student.findFirstOrThrow({ where: { admissionNo: 'FD-IMP-8' } });
    expect(s).toMatchObject({ gender: 'F', religion: 'Hindu', category: 'General', nationality: 'Indian', address: '12 Main Rd, Hyderabad', fatherEmail: 'dad@example.com', motherEmail: 'mom@example.com' });
    expect(s.admissionDate?.toISOString().slice(0, 10)).toBe('2026-04-01');

    // re-import is idempotent; columns absent from the file keep their value
    expect((await post([row(8)], 'false').expect(201)).body).toMatchObject({ willCreate: 0, willUpdate: 1 });
    expect((await prisma.student.findFirstOrThrow({ where: { admissionNo: 'FD-IMP-8' } })).religion).toBe('Hindu');
    await prisma.enrollment.deleteMany({ where: { student: { admissionNo: { startsWith: 'FD-IMP-' } } } });
    await prisma.student.deleteMany({ where: { admissionNo: { startsWith: 'FD-IMP-' } } });
  });

  it('students list: unchanged without limit; limit/offset page it and X-Total-Count has the full count', async () => {
    const q = `schoolId=${schoolId}&yearId=${yearId}`;
    const total = await prisma.student.count({ where: { schoolId } });
    expect(total).toBe(42);

    const all = await http().get(`/api/students?${q}`).set(admin).expect(200);
    expect(all.body).toHaveLength(total);
    expect(all.headers['x-total-count']).toBe(String(total));

    const p1 = await http().get(`/api/students?${q}&limit=10&offset=0`).set(admin).expect(200);
    const p5 = await http().get(`/api/students?${q}&limit=10&offset=40`).set(admin).expect(200);
    const p2 = await http().get(`/api/students?${q}&limit=10&offset=10`).set(admin).expect(200);
    expect([p1.body.length, p2.body.length, p5.body.length]).toEqual([10, 10, 2]);
    expect(p1.headers['x-total-count']).toBe('42');
    // pages are contiguous slices of the same ordering
    expect([...p1.body, ...p2.body].map((s: { id: number }) => s.id)).toEqual(all.body.slice(0, 20).map((s: { id: number }) => s.id));
    expect(p5.body.map((s: { id: number }) => s.id)).toEqual(all.body.slice(40).map((s: { id: number }) => s.id));

    // the search filter changes the total, not just the page
    const f = await http().get(`/api/students?${q}&q=FDSF-001&limit=3`).set(admin).expect(200);
    expect(f.headers['x-total-count']).toBe(String(await prisma.student.count({ where: { schoolId, admissionNo: { contains: 'FDSF-001', mode: 'insensitive' } } })));
    expect(f.body).toHaveLength(3);

    for (const bad of ['limit=0', 'limit=5001', 'limit=abc', 'offset=-1', 'limit=5&offset=-3']) {
      await http().get(`/api/students?${q}&${bad}`).set(admin).expect(400);
    }
    await http().get(`/api/students?${q}&limit=5`).set(other).expect(403); // another school's admin
    await http().get(`/api/students?${q}&limit=5`).expect(401);
  });

  it('sms and email logs: default is unchanged, limit/offset page with X-Total-Count', async () => {
    await prisma.smsLog.createMany({ data: Array.from({ length: 7 }, (_, i) => ({ schoolId, number: `98765432${10 + i}`, type: 'general', body: `m${i}`, status: 'SENT' as const })) });
    await prisma.emailLog.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ schoolId, address: `a${i}@example.com`, subject: `s${i}`, status: 'SENT' as const })) });
    for (const [path, n] of [['sms', 7], ['email', 5]] as const) {
      const all = await http().get(`/api/${path}/log?schoolId=${schoolId}`).set(admin).expect(200);
      expect(all.body).toHaveLength(n);
      expect(all.headers['x-total-count']).toBe(String(n));
      const pg = await http().get(`/api/${path}/log?schoolId=${schoolId}&limit=2&offset=1`).set(admin).expect(200);
      expect(pg.body.map((r: { id: number }) => r.id)).toEqual(all.body.slice(1, 3).map((r: { id: number }) => r.id));
      expect(pg.headers['x-total-count']).toBe(String(n));
      await http().get(`/api/${path}/log?schoolId=${schoolId}&limit=0`).set(admin).expect(400);
      await http().get(`/api/${path}/log?schoolId=${schoolId}&limit=2`).set(other).expect(403);
    }
  });

  it('concession categories: saved with the concession, listed (distinct, sorted) for the school only', async () => {
    const students = (await http().get(`/api/students?schoolId=${schoolId}&yearId=${yearId}&limit=3`).set(admin).expect(200)).body as { id: number }[];
    const save = (id: number, category?: string) => http().put(`/api/students/${id}/concessions`).set(admin)
      .send({ yearId, items: [{ feeHeadId, percent: 10, reason: 'e2e', ...(category ? { category } : {}) }] });
    expect(await http().get(`/api/students/concession-categories?schoolId=${schoolId}`).set(admin).expect(200).then((r) => r.body)).toEqual([]);
    expect((await save(students[0].id, 'Staff').expect(200)).body[0].category).toBe('Staff');
    await save(students[1].id, 'Economic').expect(200);
    await save(students[2].id, 'Staff').expect(200);
    await save(students[2].id).expect(200); // a concession without a category is allowed and adds nothing
    expect((await http().get(`/api/students/concession-categories?schoolId=${schoolId}`).set(admin).expect(200)).body).toEqual(['Economic', 'Staff']);
    await http().get(`/api/students/concession-categories?schoolId=${schoolId}`).set(other).expect(403);
    await http().get(`/api/students/concession-categories?schoolId=${schoolId}`).expect(401);
    // the other school's categories never show up here
    expect((await http().get('/api/students/concession-categories?schoolId=1').set(admin).expect(403)).body.message).toBeDefined();
  });

  it('swagger: the DTOs that used to share a name now have their own schema', async () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build()) as unknown as {
      paths: Record<string, Record<string, { requestBody?: { content: { 'application/json': { schema: { $ref?: string } } } } }>>;
      components: { schemas: Record<string, unknown> };
    };
    const body = (path: string, method: string) => doc.paths[path][method].requestBody?.content['application/json'].schema.$ref?.split('/').pop();
    expect(body('/api/fee-structure', 'put')).toBe('SaveFeeStructureDto');
    expect(body('/api/facilities/structure', 'put')).toBe('SaveFacilityStructureDto');
    expect(body('/api/sms/send', 'post')).toBe('SendSmsDto');
    expect(body('/api/email/send', 'post')).toBe('SendEmailDto');
    expect(body('/api/import/students', 'post')).toBe('StudentImportDto');
    expect(body('/api/students/{id}/admission-certificate/send', 'post')).toBe('SendAdmissionCertDto');
    // ponytail: the nested *ItemDto schemas only exist when the nest-cli swagger plugin runs (nest build/start), not under vitest
    for (const gone of ['ItemDto', 'SaveStructureDto', 'SendDto']) expect(doc.components.schemas[gone]).toBeUndefined();
  });
});
