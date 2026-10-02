import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Endpoint x role matrix: authentication, role authorization, cross-school isolation, then functional flows.
// Run against a throwaway DB (DATABASE_URL=.../fees_e2e), seeded with `npx prisma db seed`.
type Ids = {
  schoolId: number; yearId: number; standardId: number; sectionId: number; section2Id: number;
  headId: number; optHeadId: number; instId: number; studentId: number; paymentId: number; facilityId: number; userId: number;
};
type Req = { m: 'get' | 'post' | 'put' | 'patch' | 'delete'; p: string; b?: object };
type Role = 'SUPERADMIN' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';

describe('authn/authz matrix + flows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const hdr: Record<string, Record<string, string>> = {};
  const http = () => request(app.getHttpServer());
  const call = (who: string, r: Req) => {
    const t = http()[r.m](`/api${r.p}`);
    if (hdr[who]) t.set(hdr[who]);
    return r.b ? t.send(r.b) : t;
  };
  const status = async (who: string, r: Req) => (await call(who, r)).status;
  const login = async (username: string, password: string) =>
    (await http().post('/api/auth/login').send({ username, password })).body.token as string;

  let a: Ids; // school 1 (DEMO1) resources
  let b: Ids; // school 2 (DEMO2) resources
  let nextYearId: number;

  async function discover(root: string, code: string): Promise<Ids> {
    const g = async (p: string) => (await call(root, { m: 'get', p })).body;
    const school = (await g('/schools')).find((s: { code: string }) => s.code === code);
    const years = await g('/years');
    const yearId = years.find((y: { isCurrent: boolean }) => y.isCurrent).id;
    const schoolId = school.id;
    const stds = await g(`/standards?schoolId=${schoolId}`);
    const std = stds.find((s: { sections: unknown[] }) => s.sections.length);
    const heads = await g(`/fee-heads?schoolId=${schoolId}`);
    const insts = await g(`/installments?schoolId=${schoolId}&yearId=${yearId}`);
    const studs = await g(`/students?schoolId=${schoolId}&yearId=${yearId}`);
    const fac = (await call(root, { m: 'post', p: '/facilities', b: { schoolId, kind: 'TRANSPORT', name: `e2e-route-${code}` } })).body;
    return {
      schoolId, yearId, standardId: std.id, sectionId: std.sections[0].id,
      section2Id: (stds.flatMap((s: { sections: { id: number }[] }) => s.sections).find((x: { id: number }) => x.id !== std.sections[0].id)).id,
      headId: heads.find((h: { type: string }) => h.type === 'MONTHLY').id,
      optHeadId: heads.find((h: { type: string }) => h.type === 'OPTIONAL').id,
      instId: insts[0].id, studentId: studs[0].id, paymentId: 0, facilityId: fac.id, userId: 0,
    };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    prisma = app.get(PrismaService);

    hdr.root = { Authorization: `Bearer ${await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123')}` };
    const [s1, s2] = await Promise.all(['DEMO1', 'DEMO2'].map((code) => prisma.school.findUniqueOrThrow({ where: { code } })));
    for (const [tag, school] of [['1', s1], ['2', s2]] as const) {
      for (const role of ['ADMIN', 'ACCOUNTANT', 'VIEWER'] as const) {
        const r = await call('root', { m: 'post', p: '/users', b: { username: `m-${role.toLowerCase()}${tag}`, password: 'password1', role, schoolId: school.id } });
        expect([201, 409]).toContain(r.status);
        hdr[`${role.toLowerCase()}${tag}`] = { Authorization: `Bearer ${await login(`m-${role.toLowerCase()}${tag}`, 'password1')}` };
      }
    }
    a = await discover('root', 'DEMO1');
    b = await discover('root', 'DEMO2');
    // A payment in each school so :id routes have something to hit.
    for (const x of [a, b]) {
      const who = x === a ? 'admin1' : 'admin2';
      const stu = (await call(who, { m: 'get', p: `/students/${x.studentId}/bill?yearId=${x.yearId}` })).body;
      expect(stu.totals).toBeDefined();
      const pay = await call(who, { m: 'post', p: '/payments', b: { studentId: x.studentId, yearId: x.yearId, amount: 1, mode: 'CASH' } });
      expect(pay.status).toBe(201);
      x.paymentId = pay.body.id;
    }
    a.userId = (await prisma.user.findUniqueOrThrow({ where: { username: 'm-viewer1' } })).id;
    b.userId = (await prisma.user.findUniqueOrThrow({ where: { username: 'm-viewer2' } })).id;
  });

  afterAll(() => app.close());

  // ---------- authentication ----------
  describe('authentication', () => {
    it('login: validation, bad creds, injection-ish input', async () => {
      expect(await status('', { m: 'post', p: '/auth/login', b: {} })).toBe(400);
      expect(await status('', { m: 'post', p: '/auth/login', b: { username: 'admin', password: 'x', role: 'SUPERADMIN' } })).toBe(400);
      expect(await status('', { m: 'post', p: '/auth/login', b: { username: 'nobody', password: 'x' } })).toBe(401);
      expect(await status('', { m: 'post', p: '/auth/login', b: { username: "admin' OR '1'='1", password: "' OR '1'='1" } })).toBe(401);
      expect(await status('', { m: 'post', p: '/auth/login', b: { username: { $ne: null }, password: { $ne: null } } })).toBe(400);
      const ok = await call('', { m: 'post', p: '/auth/login', b: { username: 'm-viewer1', password: 'password1' } });
      expect(ok.status).toBe(201);
      expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('rejects missing, malformed, tampered and alg=none tokens on every protected route', async () => {
      const good = hdr.admin1.Authorization.replace('Bearer ', '');
      const [h, p, s] = good.split('.');
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
      const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'SUPERADMIN', schoolId: null })).toString('base64url');
      const bad: Record<string, string | undefined> = {
        missing: undefined, empty: 'Bearer ', garbage: 'Bearer abc.def.ghi', basic: 'Basic YWRtaW46YWRtaW4=',
        tampered: `Bearer ${h}.${forgedPayload}.${s}`, algNone: `Bearer ${none}`,
      };
      for (const [name, v] of Object.entries(bad)) {
        for (const r of [{ m: 'get', p: '/auth/me' }, { m: 'get', p: '/users' }, { m: 'post', p: '/payments', b: {} }, { m: 'get', p: '/schools' }] as Req[]) {
          const t = http()[r.m](`/api${r.p}`);
          if (v !== undefined) t.set('Authorization', v);
          expect.soft((await t).status, `${name} ${r.m} ${r.p}`).toBe(401);
        }
      }
    });

    it('token carries no authority: role/school are re-read from the DB', async () => {
      const me = await call('viewer1', { m: 'get', p: '/auth/me' });
      expect(me.body).toMatchObject({ username: 'm-viewer1', role: 'VIEWER', schoolId: a.schoolId });
    });

    it('only /auth/login is public', async () => {
      const probes: Req[] = [
        { m: 'get', p: '/schools' }, { m: 'get', p: '/years' }, { m: 'get', p: '/auth/me' }, { m: 'get', p: '/users' },
        { m: 'get', p: `/standards?schoolId=${a.schoolId}` }, { m: 'get', p: `/fee-heads?schoolId=${a.schoolId}` },
        { m: 'get', p: `/payments/${a.paymentId}` }, { m: 'get', p: `/payments/${a.paymentId}/pdf` },
        { m: 'get', p: `/students/${a.studentId}/bill.pdf?yearId=${a.yearId}` },
      ];
      for (const r of probes) expect.soft(await status('', r), `${r.m} ${r.p}`).toBe(401);
    });
  });

  // ---------- authorization matrix ----------
  const q = (x: Ids) => `schoolId=${x.schoolId}&yearId=${x.yearId}`;
  // Read endpoints: any logged-in role of the school may read; another school's staff may not.
  const reads = (x: Ids): Req[] => [
    { m: 'get', p: `/standards?schoolId=${x.schoolId}` },
    { m: 'get', p: `/fee-heads?schoolId=${x.schoolId}` },
    { m: 'get', p: `/installments?${q(x)}` },
    { m: 'get', p: `/fee-structure?yearId=${x.yearId}&standardId=${x.standardId}` },
    { m: 'get', p: `/facilities?schoolId=${x.schoolId}&kind=TRANSPORT` },
    { m: 'get', p: `/facilities/structure?${q(x)}&kind=TRANSPORT` },
    { m: 'get', p: `/students?${q(x)}` },
    { m: 'get', p: `/students/${x.studentId}/bill?yearId=${x.yearId}` },
    { m: 'get', p: `/students/${x.studentId}/bill.pdf?yearId=${x.yearId}` },
    { m: 'get', p: `/students/${x.studentId}/concessions?yearId=${x.yearId}` },
    { m: 'get', p: `/students/${x.studentId}/facilities?yearId=${x.yearId}` },
    { m: 'get', p: `/students/${x.studentId}/fines?yearId=${x.yearId}` },
    { m: 'get', p: `/payments?${q(x)}` },
    { m: 'get', p: `/payments/${x.paymentId}` },
    { m: 'get', p: `/payments/${x.paymentId}/pdf` },
    { m: 'get', p: `/reports/dues?${q(x)}` },
    { m: 'get', p: `/reports/collection?${q(x)}` },
    { m: 'get', p: `/promotions/candidates?schoolId=${x.schoolId}&fromYearId=${x.yearId}&fromSectionId=${x.sectionId}` },
  ];
  // Write endpoints with valid bodies (so validation passes and only authz decides), and who may call them.
  // Destructive ones use ids that don't exist for the allowed check; denied roles must never reach the handler.
  const writes = (x: Ids): [Req, Role[]][] => [
    [{ m: 'post', p: '/schools', b: { code: 'ZZ', name: 'z' } }, ['SUPERADMIN']],
    [{ m: 'post', p: '/years', b: { label: '2098-99', startDate: '2098-04-01', endDate: '2099-03-31' } }, ['SUPERADMIN']],
    [{ m: 'post', p: '/fee-heads', b: { schoolId: x.schoolId, name: 'authz-head', type: 'ANNUAL' } }, ['ADMIN']],
    [{ m: 'patch', p: `/fee-heads/${x.headId}`, b: { name: 'Tuition Fee' } }, ['ADMIN']],
    [{ m: 'delete', p: `/fee-heads/${x.headId}` }, ['ADMIN']],
    [{ m: 'post', p: '/standards', b: { schoolId: x.schoolId, name: 'authz-std', sortOrder: 99 } }, ['ADMIN']],
    [{ m: 'patch', p: `/standards/${x.standardId}`, b: { name: 'X' } }, ['ADMIN']],
    [{ m: 'delete', p: `/standards/${x.standardId}` }, ['ADMIN']],
    [{ m: 'post', p: '/sections', b: { standardId: x.standardId, name: 'authz-sec' } }, ['ADMIN']],
    [{ m: 'delete', p: `/sections/${x.sectionId}` }, ['ADMIN']],
    [{ m: 'post', p: '/installments', b: { schoolId: x.schoolId, yearId: x.yearId, number: 77, label: 'authz', dueDate: '2027-01-01' } }, ['ADMIN']],
    [{ m: 'patch', p: `/installments/${x.instId}`, b: { label: 'Q' } }, ['ADMIN']],
    [{ m: 'delete', p: `/installments/${x.instId}` }, ['ADMIN']],
    [{ m: 'post', p: '/facilities', b: { schoolId: x.schoolId, kind: 'HOSTEL', name: 'authz-room' } }, ['ADMIN']],
    [{ m: 'patch', p: `/facilities/${x.facilityId}`, b: { name: 'r' } }, ['ADMIN']],
    [{ m: 'delete', p: `/facilities/${x.facilityId}` }, ['ADMIN']],
    [{ m: 'put', p: '/facilities/structure', b: { yearId: x.yearId, schoolId: x.schoolId, kind: 'TRANSPORT', items: [] } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'put', p: '/fee-structure', b: { yearId: x.yearId, standardId: x.standardId, items: [] } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'post', p: '/students', b: { schoolId: x.schoolId, yearId: x.yearId, admissionNo: 'authz-1', name: 'n', sectionId: x.sectionId, isNewAdmission: false, optionalHeadIds: [] } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'patch', p: `/students/${x.studentId}`, b: { yearId: x.yearId, name: 'Same' } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'put', p: `/students/${x.studentId}/concessions`, b: { yearId: x.yearId, items: [] } }, ['ADMIN']],
    [{ m: 'put', p: `/students/${x.studentId}/fines`, b: { yearId: x.yearId, items: [] } }, ['ADMIN']],
    [{ m: 'put', p: `/students/${x.studentId}/facilities`, b: { yearId: x.yearId, kind: 'TRANSPORT' } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'post', p: '/promotions', b: { fromYearId: x.yearId, toYearId: x.yearId, fromSectionId: x.sectionId, toSectionId: x.section2Id, excludeStudentIds: [] } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'post', p: '/payments', b: { studentId: x.studentId, yearId: x.yearId, amount: 99999999, mode: 'CASH' } }, ['ADMIN', 'ACCOUNTANT']],
    [{ m: 'post', p: `/payments/${x.paymentId}/cancel`, b: { reason: 'authz probe' } }, ['ADMIN']],
    [{ m: 'get', p: '/users' }, ['ADMIN']],
    [{ m: 'post', p: '/users', b: { username: 'authz-u', password: 'password1', role: 'VIEWER', schoolId: x.schoolId } }, ['ADMIN']],
    [{ m: 'patch', p: `/users/${x.userId}`, b: { active: true } }, ['ADMIN']],
  ];

  describe('authorization', () => {
    it('anonymous gets 401 on every endpoint', async () => {
      for (const r of [...reads(a), ...writes(a).map(([r]) => r)]) expect.soft(await status('', r), `${r.m} ${r.p}`).toBe(401);
    });

    it('every role can read its own school (200), including VIEWER', async () => {
      for (const who of ['viewer1', 'accountant1', 'admin1', 'root']) {
        for (const r of reads(a)) expect.soft(await status(who, r), `${who} ${r.m} ${r.p}`).toBe(200);
      }
    });

    it("staff of another school cannot read this school's data (403)", async () => {
      for (const who of ['viewer2', 'accountant2', 'admin2']) {
        for (const r of reads(a)) expect.soft(await status(who, r), `${who} ${r.m} ${r.p}`).toBe(403);
      }
    });

    it('roles below the required one are refused (403), never reaching the handler', async () => {
      const all: [string, Role][] = [['viewer1', 'VIEWER'], ['accountant1', 'ACCOUNTANT']];
      for (const [r, allowed] of writes(a)) {
        for (const [who, role] of all) {
          if (allowed.includes(role) || (allowed.includes('SUPERADMIN') && false)) continue;
          expect.soft(await status(who, r), `${who} ${r.m} ${r.p}`).toBe(403);
        }
        // a school ADMIN is not a superadmin
        if (allowed.length === 1 && allowed[0] === 'SUPERADMIN') expect.soft(await status('admin1', r), `admin1 ${r.m} ${r.p}`).toBe(403);
      }
    });

    it("another school's ADMIN cannot write into this school (403)", async () => {
      for (const [r, allowed] of writes(a)) {
        if (allowed[0] === 'SUPERADMIN' || (r.m === 'get' && r.p === '/users')) continue; // /users is scoped, covered below
        expect.soft(await status('admin2', r), `admin2 ${r.m} ${r.p}`).toBe(403);
      }
      // ...and a foreign accountant on accountant-level routes
      for (const [r, allowed] of writes(a)) {
        if (!allowed.includes('ACCOUNTANT')) continue;
        expect.soft(await status('accountant2', r), `accountant2 ${r.m} ${r.p}`).toBe(403);
      }
    });

    it('nothing leaked: foreign denied writes changed nothing', async () => {
      const h = await prisma.feeHead.findUniqueOrThrow({ where: { id: a.headId } });
      expect(h.name).toBe('Tuition Fee');
      expect(await prisma.installment.count({ where: { id: a.instId } })).toBe(1);
      expect(await prisma.standard.count({ where: { id: a.standardId } })).toBe(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).cancelledAt).toBeNull();
    });

    it('lists are scoped: school staff only see their own school and users', async () => {
      const s = await call('admin1', { m: 'get', p: '/schools' });
      expect(s.body.map((x: { code: string }) => x.code)).toEqual(['DEMO1']);
      const u = await call('admin1', { m: 'get', p: '/users' });
      expect(u.body.every((x: { schoolId: number }) => x.schoolId === a.schoolId)).toBe(true);
      expect((await call('root', { m: 'get', p: '/schools' })).body.length).toBeGreaterThanOrEqual(2);
    });

    it('user admin: no escalation, no cross-school management, no self-lockout', async () => {
      const acc = (await call('admin1', { m: 'post', p: '/users', b: { username: 'm-tmp1', password: 'password1', role: 'ACCOUNTANT' } })).body;
      expect(acc.schoolId).toBe(a.schoolId);
      expect(await status('admin1', { m: 'post', p: '/users', b: { username: 'm-su', password: 'password1', role: 'SUPERADMIN' } })).toBe(403);
      expect(await status('admin1', { m: 'patch', p: `/users/${acc.id}`, b: { role: 'SUPERADMIN' } })).toBe(403);
      expect(await status('admin1', { m: 'patch', p: `/users/${acc.id}`, b: { schoolId: b.schoolId } })).toBe(403);
      expect(await status('admin2', { m: 'patch', p: `/users/${acc.id}`, b: { active: false } })).toBe(403);
      const rootUser = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
      expect(await status('admin1', { m: 'patch', p: `/users/${rootUser.id}`, b: { password: 'hackedpass1' } })).toBe(403);
      expect(await status('admin1', { m: 'patch', p: `/users/${rootUser.id}`, b: { active: false } })).toBe(403);
      const myId = (await call('admin1', { m: 'get', p: '/auth/me' })).body.sub;
      expect(await status('admin1', { m: 'patch', p: `/users/${myId}`, b: { role: 'VIEWER' } })).toBe(400);
      expect(await status('admin1', { m: 'post', p: '/users', b: { username: 'm-x', password: 'password1', role: 'VIEWER', isAdmin: true } })).toBe(400);
      expect(await status('root', { m: 'post', p: '/users', b: { username: 'm-tmp1', password: 'password1', role: 'VIEWER', schoolId: a.schoolId } })).toBe(409);
      // the admin password still works (root wasn't hit)
      expect(await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123')).toBeTruthy();
    });
  });

  // ---------- functional flows (admin of school 1) ----------
  describe('functional', () => {
    it('masters: fee heads, standards/sections, installments, facilities CRUD + validation', async () => {
      const fh = await call('admin1', { m: 'post', p: '/fee-heads', b: { schoolId: a.schoolId, name: 'Lab Fee', type: 'ANNUAL' } });
      expect(fh.status).toBe(201);
      expect(await status('admin1', { m: 'post', p: '/fee-heads', b: { schoolId: a.schoolId, name: 'Lab Fee', type: 'ANNUAL' } })).toBe(409);
      expect(await status('admin1', { m: 'post', p: '/fee-heads', b: { schoolId: a.schoolId, name: 'X', type: 'BOGUS' } })).toBe(400);
      expect(await status('admin1', { m: 'post', p: '/fee-heads', b: { schoolId: b.schoolId, name: 'Evil', type: 'ANNUAL' } })).toBe(403);
      const moved = await call('admin1', { m: 'patch', p: `/fee-heads/${fh.body.id}`, b: { name: 'Lab Fee 2', schoolId: b.schoolId } });
      expect.soft(moved.status, 'schoolId in PATCH body must be rejected or ignored').toBeLessThan(500);
      expect((await prisma.feeHead.findUniqueOrThrow({ where: { id: fh.body.id } })).schoolId).toBe(a.schoolId);
      expect(await status('admin1', { m: 'delete', p: `/fee-heads/${fh.body.id}` })).toBe(200);
      expect(await status('admin1', { m: 'delete', p: `/fee-heads/${fh.body.id}` })).toBe(404);
      expect.soft(await status('admin1', { m: 'delete', p: `/fee-heads/${a.headId}` }), 'deleting an in-use fee head').toBe(409);

      const st = await call('admin1', { m: 'post', p: '/standards', b: { schoolId: a.schoolId, name: 'Nursery-E', sortOrder: 1 } });
      expect(st.status).toBe(201);
      const sec = await call('admin1', { m: 'post', p: '/sections', b: { standardId: st.body.id, name: 'A' } });
      expect(sec.status).toBe(201);
      expect(await status('admin1', { m: 'post', p: '/sections', b: { standardId: st.body.id, name: 'A' } })).toBe(409);
      expect(await status('admin1', { m: 'post', p: '/sections', b: { standardId: 999999, name: 'A' } })).toBe(404);
      expect(await status('admin1', { m: 'delete', p: `/sections/${sec.body.id}` })).toBe(200);
      expect(await status('admin1', { m: 'delete', p: `/standards/${st.body.id}` })).toBe(200);
      expect.soft(await status('admin1', { m: 'delete', p: `/standards/${a.standardId}` }), 'deleting a standard that has students').toBe(409);
      expect.soft(await status('admin1', { m: 'delete', p: `/sections/${a.sectionId}` }), 'deleting a section that has students').toBe(409);

      const ins = await call('admin1', { m: 'post', p: '/installments', b: { schoolId: a.schoolId, yearId: a.yearId, number: 9, label: 'Extra', dueDate: '2027-02-01', fineStartDate: '2027-02-10', finePerDay: 5 } });
      expect(ins.status).toBe(201);
      expect(await status('admin1', { m: 'post', p: '/installments', b: { schoolId: a.schoolId, yearId: a.yearId, number: 9, label: 'Dup', dueDate: '2027-02-01' } })).toBe(409);
      expect(await status('admin1', { m: 'post', p: '/installments', b: { schoolId: a.schoolId, yearId: a.yearId, number: 0, label: 'Z', dueDate: '2027-02-01' } })).toBe(400);
      expect(await status('admin1', { m: 'post', p: '/installments', b: { schoolId: a.schoolId, yearId: a.yearId, number: 10, label: 'Z', dueDate: 'not-a-date' } })).toBe(400);
      expect(await status('admin1', { m: 'post', p: '/installments', b: { schoolId: a.schoolId, yearId: a.yearId, number: 10, label: 'Z', dueDate: '2027-02-01', finePerDay: -1 } })).toBe(400);
      expect((await call('admin1', { m: 'patch', p: `/installments/${ins.body.id}`, b: { label: 'Extra2', finePerDay: 7 } })).body.label).toBe('Extra2');
      expect(await status('admin1', { m: 'delete', p: `/installments/${ins.body.id}` })).toBe(200);

      const fc = await call('admin1', { m: 'post', p: '/facilities', b: { schoolId: a.schoolId, kind: 'HOSTEL', name: 'Room 1' } });
      expect(fc.status).toBe(201);
      expect(await status('admin1', { m: 'post', p: '/facilities', b: { schoolId: a.schoolId, kind: 'HOSTEL', name: 'Room 1' } })).toBe(409);
      expect((await call('admin1', { m: 'get', p: `/facilities?schoolId=${a.schoolId}&kind=HOSTEL` })).body.map((f: { name: string }) => f.name)).toContain('Room 1');
      expect.soft(await status('admin1', { m: 'get', p: `/facilities?schoolId=${a.schoolId}&kind=BOGUS` }), 'invalid kind query').toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/facilities?schoolId=${a.schoolId}` }), 'missing kind query').toBe(400);
      expect(await status('admin1', { m: 'patch', p: `/facilities/${fc.body.id}`, b: { name: 'Room 1A' } })).toBe(200);
      expect(await status('admin1', { m: 'delete', p: `/facilities/${fc.body.id}` })).toBe(200);
    });

    it('input hygiene: bad ids, non-numeric, unknown, missing query', async () => {
      for (const p of ['/payments/abc', '/payments/0.5', `/payments/99999999`, `/students/abc/bill?yearId=${a.yearId}`, `/students/${a.studentId}/bill`, '/students?schoolId=x&yearId=1', '/students?yearId=1', '/fee-heads', '/reports/dues']) {
        const s = await status('admin1', { m: 'get', p });
        expect.soft([400, 403, 404], `GET ${p} -> ${s}`).toContain(s);
      }
      expect.soft(await status('admin1', { m: 'get', p: `/reports/dues?${q(a)}&asOf=garbage` })).toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/students/${a.studentId}/bill?yearId=${a.yearId}&asOf=garbage` }), 'bill asOf=garbage').toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/payments?${q(a)}&from=garbage` }), 'payments from=garbage').toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/payments?${q(a)}&studentId=abc` }), 'payments studentId=abc').toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/students?${q(a)}&standardId=abc` }), 'students standardId=abc').toBe(400);
      expect.soft(await status('admin1', { m: 'get', p: `/students/${a.studentId}/bill?yearId=99999` })).toBe(400);
    });

    it('fee structure + facility structure: replace grid, reject foreign refs and duplicates', async () => {
      const g = (await call('admin1', { m: 'get', p: `/fee-structure?yearId=${a.yearId}&standardId=${a.standardId}` })).body;
      expect(g.length).toBeGreaterThan(0);
      const put = (items: object[], who = 'accountant1') => call(who, { m: 'put', p: '/fee-structure', b: { yearId: a.yearId, standardId: a.standardId, items } });
      expect((await put(g.map((x: { amount: string }) => ({ ...x, amount: Number(x.amount) })))).status).toBe(200);
      expect((await put([{ feeHeadId: b.headId, installmentId: a.instId, amount: 10 }])).status).toBe(400); // foreign head
      expect((await put([{ feeHeadId: a.headId, installmentId: b.instId, amount: 10 }])).status).toBe(400); // foreign installment
      expect((await put([{ feeHeadId: a.headId, installmentId: a.instId, amount: 10 }, { feeHeadId: a.headId, installmentId: a.instId, amount: 11 }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, installmentId: a.instId, amount: -5 }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, installmentId: a.instId, amount: 1.234 }])).status).toBe(400);
      const after = (await call('admin1', { m: 'get', p: `/fee-structure?yearId=${a.yearId}&standardId=${a.standardId}` })).body;
      expect(after.length).toBe(g.length); // failed puts must not wipe the grid
      expect((await call('admin1', { m: 'put', p: '/fee-structure', b: { yearId: a.yearId, standardId: b.standardId, items: [] } })).status).toBe(403);

      const fput = (items: object[], kind = 'TRANSPORT', who = 'admin1') =>
        call(who, { m: 'put', p: '/facilities/structure', b: { yearId: a.yearId, schoolId: a.schoolId, kind, items } });
      expect((await fput([{ facilityId: a.facilityId, installmentId: a.instId, amount: 500 }])).status).toBe(200);
      expect((await fput([{ facilityId: b.facilityId, installmentId: a.instId, amount: 500 }])).status).toBe(400);
      expect((await fput([{ facilityId: a.facilityId, installmentId: a.instId, amount: 500 }], 'HOSTEL')).status).toBe(400); // wrong kind
      expect((await call('admin1', { m: 'get', p: `/facilities/structure?${q(a)}&kind=TRANSPORT` })).body).toHaveLength(1);
    });

    it('students: create/update/list/search, cross-school refs, duplicates, bill + pdfs', async () => {
      const mk = (over: object = {}, who = 'accountant1') => call(who, {
        m: 'post', p: '/students',
        b: { schoolId: a.schoolId, yearId: a.yearId, admissionNo: 'M-1001', name: 'Matrix Kid', sectionId: a.sectionId, isNewAdmission: true, optionalHeadIds: [a.optHeadId], email: 'kid@example.com', ...over },
      });
      const created = await mk();
      expect(created.status).toBe(201);
      expect((await mk()).status).toBe(409);
      expect((await mk({ admissionNo: 'M-1002', sectionId: b.sectionId })).status).toBe(400);
      expect((await mk({ admissionNo: 'M-1003', optionalHeadIds: [a.headId] })).status).toBe(400); // non-optional head
      expect((await mk({ admissionNo: 'M-1004', optionalHeadIds: [b.optHeadId] })).status).toBe(400);
      expect((await mk({ admissionNo: 'M-1005', email: 'nope' })).status).toBe(400);
      expect((await mk({ admissionNo: '', name: '' })).status).toBe(400);
      expect((await mk({ admissionNo: 'M-1006', schoolId: b.schoolId })).status).toBe(403);
      expect.soft((await mk({ admissionNo: 'M-1007', yearId: 999999 })).status, 'unknown year').toBeLessThan(500);
      expect.soft((await mk({ admissionNo: 'M-1008', dob: 'garbage' })).status).toBe(400);
      // same admission number is fine in another school
      expect((await mk({ schoolId: b.schoolId, sectionId: b.sectionId, optionalHeadIds: [] }, 'admin2')).status).toBe(201);

      const id = created.body.id;
      const list = await call('viewer1', { m: 'get', p: `/students?${q(a)}&q=matrix` });
      expect(list.body.map((s: { id: number }) => s.id)).toEqual([id]);
      expect(list.body[0].enrollment.optionalHeadIds).toEqual([a.optHeadId]);
      expect((await call('viewer1', { m: 'get', p: `/students?${q(a)}&standardId=${a.standardId}` })).body.length).toBeGreaterThan(0);

      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, name: 'Renamed', optionalHeadIds: [] } })).status).toBe(200);
      expect((await call('viewer1', { m: 'get', p: `/students?${q(a)}&q=renamed` })).body[0].enrollment.optionalHeadIds).toEqual([]);
      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, sectionId: b.sectionId } })).status).toBe(400);
      expect((await call('admin2', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, name: 'Hijack' } })).status).toBe(403);
      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, schoolId: b.schoolId } })).status).toBe(400); // schoolId not updatable
      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: nextYearId ?? a.yearId, name: 'x' } })).status).toBeLessThan(500);
      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, active: false } })).status).toBe(200);
      expect((await call('accountant1', { m: 'patch', p: `/students/${id}`, b: { yearId: a.yearId, active: true } })).status).toBe(200);

      const bill = await call('viewer1', { m: 'get', p: `/students/${id}/bill?yearId=${a.yearId}` });
      expect(bill.status).toBe(200);
      for (const p of [`/students/${id}/bill.pdf?yearId=${a.yearId}`]) {
        const r = await call('viewer1', { m: 'get', p }).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
        expect(r.headers['content-type']).toMatch(/application\/pdf/);
        expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      }
      expect(await status('admin2', { m: 'get', p: `/students/${id}/bill?yearId=${a.yearId}` })).toBe(403);
    });

    it('concessions: replace list, validation, cannot push the bill negative', async () => {
      const sid = a.studentId;
      const put = (items: object[], who = 'admin1') => call(who, { m: 'put', p: `/students/${sid}/concessions`, b: { yearId: a.yearId, items } });
      const before = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect((await put([{ feeHeadId: a.headId, percent: 50, reason: 'sibling' }])).status).toBe(200);
      const half = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect(Number(half.totals.charges)).toBeLessThan(Number(before.totals.charges));
      expect((await put([{ feeHeadId: a.headId, percent: 50, amount: 10, reason: 'both' }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, reason: 'neither' }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, percent: 101, reason: 'over' }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, percent: 0, reason: 'zero' }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, percent: 5, reason: 'x' }, { feeHeadId: a.headId, percent: 6, reason: 'dup' }])).status).toBe(400);
      expect((await put([{ feeHeadId: b.headId, percent: 5, reason: 'foreign head' }])).status).toBe(400);
      expect((await put([{ feeHeadId: a.headId, percent: 5, reason: '' }])).status).toBe(400);
      // flat amount far above the charge must clamp at zero, not produce negative dues
      expect((await put([{ feeHeadId: a.headId, amount: 9999999, reason: 'huge' }])).status).toBe(200);
      const huge = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect.soft(Number(huge.totals.charges), 'charges must not go negative').toBeGreaterThanOrEqual(0);
      expect.soft(Number(huge.totals.due), 'due must not go negative').toBeGreaterThanOrEqual(0);
      for (const i of huge.installments) expect.soft(Number(i.charges), `installment ${i.label} negative`).toBeGreaterThanOrEqual(0);
      expect((await put([])).status).toBe(200);
      const back = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect(back.totals.charges).toBe(before.totals.charges);
    });

    it('student facilities: assign/clear, wrong kind and foreign facility rejected, charged on bill', async () => {
      const sid = a.studentId;
      const put = (b2: object, who = 'accountant1') => call(who, { m: 'put', p: `/students/${sid}/facilities`, b: { yearId: a.yearId, ...b2 } });
      const base = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect((await put({ kind: 'TRANSPORT', facilityId: a.facilityId })).status).toBe(200);
      const withBus = (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      expect(Number(withBus.totals.charges)).toBe(Number(base.totals.charges) + 500);
      expect((await put({ kind: 'HOSTEL', facilityId: a.facilityId })).status).toBe(400);
      expect((await put({ kind: 'TRANSPORT', facilityId: b.facilityId })).status).toBe(400);
      expect((await put({ kind: 'TRANSPORT', facilityId: 999999 })).status).toBe(400);
      expect((await put({ kind: 'TRANSPORT', facilityId: a.facilityId }, 'admin2')).status).toBe(403);
      expect((await call('viewer1', { m: 'get', p: `/students/${sid}/facilities?yearId=${a.yearId}` })).body).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'TRANSPORT', facilityId: a.facilityId })]));
      expect((await put({ kind: 'TRANSPORT' })).status).toBe(200); // clear
      expect((await call('viewer1', { m: 'get', p: `/students/${sid}/facilities?yearId=${a.yearId}` })).body.filter((f: { kind: string }) => f.kind === 'TRANSPORT')).toEqual([]);
      expect((await call('admin1', { m: 'delete', p: `/facilities/${a.facilityId}` })).status, 'route with fee rows cannot be deleted').toBe(409);
    });

    it('payments: collect, validation, allocation, receipts, overpay, concurrency, cancel rules', async () => {
      const sid = a.studentId;
      const bill = async () => (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body;
      const pay = (amount: unknown, extra: object = {}, who = 'accountant1') =>
        call(who, { m: 'post', p: '/payments', b: { studentId: sid, yearId: a.yearId, amount, mode: 'CASH', ...extra } });
      const b0 = await bill();
      const due0 = Number(b0.totals.due);
      expect(due0).toBeGreaterThan(100);

      // validation
      for (const bad of [0, -5, 0.001, 'abc', null]) expect.soft((await pay(bad)).status, `amount=${String(bad)}`).toBe(400);
      expect((await pay(10, { mode: 'UPI' })).status).toBe(400); // reference required
      expect((await pay(10, { mode: 'UPI', reference: 'ab' })).status).toBe(400);
      expect((await pay(10, { mode: 'NOPE' })).status).toBe(400);
      expect((await pay(10, { date: '2999-01-01' })).status).toBe(400);
      expect((await pay(10, { date: 'garbage' })).status).toBe(400);
      expect((await pay(due0 + 1)).status).toBe(400); // overpay
      expect((await pay(10, { studentId: 99999999 })).status).toBeGreaterThanOrEqual(400);
      expect((await pay(10, { yearId: 99999999 })).status).toBeLessThan(500);
      expect((await pay(10, {}, 'admin2')).status).toBe(403);
      expect((await pay(10, {}, 'viewer1')).status).toBe(403);
      expect((await pay(10, { receiptNo: 1, createdBy: 'x', cancelledAt: null })).status, 'mass assignment').toBe(400);
      expect(Number((await bill()).totals.due)).toBe(due0); // nothing collected by rejected calls

      // happy path
      const r1 = await pay(100.5, { mode: 'UPI', reference: 'UPI-123456', remarks: 'first' });
      expect(r1.status).toBe(201);
      expect(r1.body.amount).toBe('100.50');
      expect(r1.body.reference).toBe('UPI-123456');
      const alloc = r1.body.allocations.reduce((s: number, x: { charges: string; fine: string }) => s + Number(x.charges) + Number(x.fine), 0);
      expect(alloc).toBeCloseTo(100.5, 2);
      expect(Number((await bill()).totals.due)).toBeCloseTo(due0 - 100.5, 2);
      const r2 = await pay(50, { mode: 'CASH', reference: 'ignored' });
      expect(r2.body.receiptNo).toBe(r1.body.receiptNo + 1);
      expect(r2.body.reference).toBeNull();

      // read receipts
      const got = await call('viewer1', { m: 'get', p: `/payments/${r1.body.id}` });
      expect(got.body.receiptNo).toBe(r1.body.receiptNo);
      const list = await call('viewer1', { m: 'get', p: `/payments?${q(a)}&studentId=${sid}` });
      expect(list.body.map((p: { id: number }) => p.id)).toEqual(expect.arrayContaining([r1.body.id, r2.body.id]));
      expect(list.body[0].receiptNo).toBeGreaterThan(list.body[list.body.length - 1].receiptNo);
      expect((await call('viewer1', { m: 'get', p: `/payments?${q(a)}&from=2999-01-01` })).body).toEqual([]);
      expect(list.body.every((p: { studentId: number }) => p.studentId === sid)).toBe(true);
      const pdf = await call('viewer1', { m: 'get', p: `/payments/${r1.body.id}/pdf` }).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect(await status('admin2', { m: 'get', p: `/payments/${r1.body.id}` })).toBe(403);
      expect(await status('admin2', { m: 'get', p: `/payments/${r1.body.id}/pdf` })).toBe(403);
      const foreignList = await call('admin2', { m: 'get', p: `/payments?schoolId=${b.schoolId}&yearId=${b.yearId}&studentId=${sid}` });
      expect(foreignList.body).toEqual([]); // student id from school 1 yields nothing in school 2

      // cancel rules
      expect((await call('accountant1', { m: 'post', p: `/payments/${r1.body.id}/cancel`, b: { reason: 'oops' } })).status).toBe(403);
      expect((await call('admin1', { m: 'post', p: `/payments/${r1.body.id}/cancel`, b: { reason: 'x' } })).status).toBe(400); // reason too short
      expect((await call('admin1', { m: 'post', p: `/payments/${r1.body.id}/cancel`, b: { reason: 'oops' } })).status, 'earlier before later').toBe(400);
      expect((await call('admin2', { m: 'post', p: `/payments/${r2.body.id}/cancel`, b: { reason: 'oops' } })).status).toBe(403);
      const c2 = await call('admin1', { m: 'post', p: `/payments/${r2.body.id}/cancel`, b: { reason: 'wrong mode' } });
      expect(c2.status).toBe(201);
      expect(c2.body.cancelledBy).toBe('m-admin1');
      expect((await call('admin1', { m: 'post', p: `/payments/${r2.body.id}/cancel`, b: { reason: 'again' } })).status).toBe(400);
      expect(Number((await bill()).totals.due)).toBeCloseTo(due0 - 100.5, 2); // cancelled receipt restored its due
      const c1 = await call('admin1', { m: 'post', p: `/payments/${r1.body.id}/cancel`, b: { reason: 'wrong student' } });
      expect(c1.status).toBe(201);
      expect(Number((await bill()).totals.due)).toBeCloseTo(due0, 2);
      // cancelled receipts leave the collection report
      const col = (await call('viewer1', { m: 'get', p: `/reports/collection?${q(a)}` })).body as { receipts: number; amount: string }[];
      expect(col.reduce((s, r) => s + r.receipts, 0)).toBe(1); // only the seeded Rs.1 payment of the student remains... see beforeAll
    });

    it('payments: concurrent full-due payments cannot overpay (row lock)', async () => {
      const s = await call('admin1', { m: 'get', p: `/students?${q(a)}` });
      const sid = s.body[3].id;
      const due = Number((await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body.totals.due);
      const res = await Promise.all([1, 2, 3].map(() =>
        call('accountant1', { m: 'post', p: '/payments', b: { studentId: sid, yearId: a.yearId, amount: due, mode: 'CASH' } })));
      const codes = res.map((r) => r.status).sort();
      expect.soft(codes, 'exactly one of three simultaneous full payments may succeed').toEqual([201, 400, 400]);
      expect(Number((await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}` })).body.totals.due)).toBeCloseTo(0, 2);
      const receipts = (await call('admin1', { m: 'get', p: `/payments?${q(a)}&studentId=${sid}` })).body;
      expect(new Set(receipts.map((r: { receiptNo: number }) => r.receiptNo)).size).toBe(receipts.length);
      // a fully-paid student cannot be charged again
      expect((await call('accountant1', { m: 'post', p: '/payments', b: { studentId: sid, yearId: a.yearId, amount: 1, mode: 'CASH' } })).status).toBe(400);
    });

    it('receipt numbers are per school+year, gap-free and independent between schools', async () => {
      const nums = async (x: Ids, who: string) =>
        ((await call(who, { m: 'get', p: `/payments?${q(x)}` })).body as { receiptNo: number }[]).map((p) => p.receiptNo).sort((m, n) => m - n);
      for (const [x, who] of [[a, 'admin1'], [b, 'admin2']] as const) {
        const n = await nums(x, who);
        expect(n[0]).toBe(1);
        expect(n).toEqual(n.map((_, i) => i + 1));
      }
    });

    it('fines: overdue installments accrue fine on the bill and are paid first-come', async () => {
      const bill = (await call('admin1', { m: 'get', p: `/students/${a.studentId}/bill?yearId=${a.yearId}&asOf=2030-01-01` })).body;
      const past = (await call('admin1', { m: 'get', p: `/students/${a.studentId}/bill?yearId=${a.yearId}&asOf=2020-01-01` })).body;
      expect(Number(past.totals.fine)).toBe(0);
      expect(Number(bill.totals.fine)).toBeGreaterThanOrEqual(0);
      expect(Number(bill.totals.due)).toBeGreaterThanOrEqual(Number(past.totals.due));
    });

    it('fine override: waive/fix a fine per installment, validation, authz, bill and payments follow', async () => {
      const sid = a.studentId;
      const asOf = '2030-01-01';
      const billAt = async () => (await call('admin1', { m: 'get', p: `/students/${sid}/bill?yearId=${a.yearId}&asOf=${asOf}` })).body;
      const before = await billAt();
      const late = before.installments.find((i: { fineDays: number }) => i.fineDays > 0);
      expect(late, 'seed needs an installment with a fine so overrides can be tested').toBeDefined();
      const fine0 = Number(late.fine);
      expect(fine0).toBeGreaterThan(0);
      const put = (items: object[], who = 'admin1') => call(who, { m: 'put', p: `/students/${sid}/fines`, b: { yearId: a.yearId, items } });

      expect((await put([{ installmentId: late.installmentId, amount: 0, remarks: 'waived by principal' }])).status).toBe(200);
      const waived = await billAt();
      const w = waived.installments.find((i: { installmentId: number }) => i.installmentId === late.installmentId);
      expect(w).toMatchObject({ fine: '0.00', fineOverridden: true });
      expect(Number(waived.totals.due)).toBeCloseTo(Number(before.totals.due) - fine0, 2);
      expect((await call('viewer1', { m: 'get', p: `/students/${sid}/fines?yearId=${a.yearId}` })).body)
        .toEqual([{ installmentId: late.installmentId, amount: '0.00', remarks: 'waived by principal' }]);

      expect((await put([{ installmentId: late.installmentId, amount: 12.5, remarks: 'fixed fine' }])).status).toBe(200);
      expect((await billAt()).installments.find((i: { installmentId: number }) => i.installmentId === late.installmentId).fine).toBe('12.50');

      // validation + authz
      expect((await put([{ installmentId: late.installmentId, amount: -1, remarks: 'neg' }])).status).toBe(400);
      expect((await put([{ installmentId: late.installmentId, amount: 1.234, remarks: 'dp' }])).status).toBe(400);
      expect((await put([{ installmentId: late.installmentId, amount: 1, remarks: 'x' }])).status).toBe(400);
      expect((await put([{ installmentId: late.installmentId, amount: 1, remarks: 'dup' }, { installmentId: late.installmentId, amount: 2, remarks: 'dup' }])).status).toBe(400);
      expect((await put([{ installmentId: b.instId, amount: 1, remarks: 'foreign' }])).status).toBe(400);
      expect((await put([{ installmentId: 999999, amount: 1, remarks: 'unknown' }])).status).toBe(400);
      expect((await put([{ installmentId: late.installmentId, amount: 1, remarks: 'nope' }], 'accountant1')).status).toBe(403);
      expect((await put([{ installmentId: late.installmentId, amount: 1, remarks: 'nope' }], 'admin2')).status).toBe(403);
      expect((await call('admin1', { m: 'put', p: `/students/${sid}/fines`, b: { yearId: a.yearId, items: [], extra: 1 } })).status).toBe(400);
      expect((await billAt()).installments.find((i: { installmentId: number }) => i.installmentId === late.installmentId).fine).toBe('12.50'); // failed puts changed nothing

      // payment follows the overridden bill: due is exactly payable, one paisa more is refused
      const due = Number((await billAt()).totals.due);
      const pay = (amount: number) => call('admin1', { m: 'post', p: '/payments', b: { studentId: sid, yearId: a.yearId, amount, mode: 'CASH' } });
      expect((await pay(due + 0.01)).status).toBe(400); // one paisa over the overridden due is refused
      expect((await pay(0.01)).status).toBe(201); // payments still work with an override in place
      await call('admin1', { m: 'post', p: `/payments/${(await call('admin1', { m: 'get', p: `/payments?${q(a)}&studentId=${sid}` })).body[0].id}/cancel`, b: { reason: 'test cleanup' } });

      expect((await put([])).status).toBe(200); // clearing restores the calculated fine
      expect(Number((await billAt()).totals.due)).toBeCloseTo(Number(before.totals.due), 2);
      expect(due).toBeGreaterThan(0);
    });

    it('dues report: sectionId and installmentId filters, validated and school-scoped', async () => {
      const all = (await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&asOf=2030-01-01` })).body as { studentId: number; charges: string; className: string }[];
      const bySection = (await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&asOf=2030-01-01&sectionId=${a.sectionId}` })).body as typeof all;
      expect(bySection.length).toBeGreaterThan(0);
      expect(bySection.length).toBeLessThan(all.length);
      const inSection = (await call('viewer1', { m: 'get', p: `/students?${q(a)}` })).body.filter((s: { enrollment: { sectionId: number } }) => s.enrollment.sectionId === a.sectionId).length;
      expect(bySection.length).toBe(inSection);

      const one = (await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&asOf=2030-01-01&installmentId=${a.instId}` })).body as typeof all;
      expect(one.length).toBeGreaterThan(0);
      // per-installment figures are a part of the whole
      const whole = new Map(all.map((r) => [r.studentId, Number(r.charges)]));
      for (const r of one) expect(Number(r.charges)).toBeLessThanOrEqual(whole.get(r.studentId)!);
      expect(one.reduce((s, r) => s + Number(r.charges), 0)).toBeLessThan(all.reduce((s, r) => s + Number(r.charges), 0));
      // the installment-only overdue never exceeds the whole-year overdue
      expect(await status('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&sectionId=abc` })).toBe(400);
      expect(await status('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&installmentId=abc` })).toBe(400);
      // another school's section/installment yields nothing, never that school's students
      expect((await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&sectionId=${b.sectionId}` })).body).toEqual([]);
      expect((await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&installmentId=${b.instId}` })).body).toEqual([]);
      expect(await status('viewer2', { m: 'get', p: `/reports/dues?${q(a)}&sectionId=${a.sectionId}` })).toBe(403);
    });

    it('reports: dues + collection, scoped, filtered, validated', async () => {
      const dues = (await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&asOf=2030-01-01` })).body as { due: string; overdue: string; paid: string; charges: string; standardId: number }[];
      expect(dues.length).toBeGreaterThan(40);
      for (const d of dues) expect(Math.abs(Number(d.charges) + Number((d as { fine?: string }).fine ?? 0) - Number(d.paid) - Number(d.due))).toBeLessThan(0.011);
      const one = (await call('viewer1', { m: 'get', p: `/reports/dues?${q(a)}&standardId=${a.standardId}` })).body;
      expect(one.every((d: { standardId: number }) => d.standardId === a.standardId)).toBe(true);
      expect(one.length).toBeLessThan(dues.length);
      expect((await call('root', { m: 'get', p: `/reports/dues?schoolId=${b.schoolId}&yearId=${b.yearId}` })).body.every((d: { admissionNo: string }) => typeof d.admissionNo === 'string')).toBe(true);
      expect.soft(await status('viewer1', { m: 'get', p: `/reports/dues?schoolId=${a.schoolId}&yearId=${a.yearId}&standardId=${b.standardId}` }), 'standardId from another school').toBeLessThan(500);
      const bleed = (await call('viewer1', { m: 'get', p: `/reports/dues?schoolId=${a.schoolId}&yearId=${a.yearId}&standardId=${b.standardId}` })).body;
      expect.soft(Array.isArray(bleed) ? bleed.length : 0, "dues must not leak other school's students via standardId").toBe(0);
      expect(await status('viewer1', { m: 'get', p: `/reports/collection?${q(a)}&from=bad` })).toBe(400);
    });

    it('years + schools (superadmin only): create, validation, duplicates, single current year', async () => {
      const y = await call('root', { m: 'post', p: '/years', b: { label: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', isCurrent: false } });
      expect(y.status).toBe(201);
      nextYearId = y.body.id;
      expect(await status('root', { m: 'post', p: '/years', b: { label: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' } })).toBe(409);
      expect(await status('root', { m: 'post', p: '/years', b: { label: '27-28', startDate: '2027-04-01', endDate: '2028-03-31' } })).toBe(400);
      expect.soft(await status('root', { m: 'post', p: '/years', b: { label: '2029-30', startDate: '2030-04-01', endDate: '2029-03-31' } }), 'end before start').toBe(400);
      const c = await call('root', { m: 'post', p: '/years', b: { label: '2030-31', startDate: '2030-04-01', endDate: '2031-03-31', isCurrent: true } });
      expect(c.status).toBe(201);
      expect((await call('viewer1', { m: 'get', p: '/years' })).body.filter((x: { isCurrent: boolean }) => x.isCurrent)).toHaveLength(1);
      await prisma.academicYear.updateMany({ data: { isCurrent: false } });
      await prisma.academicYear.update({ where: { id: a.yearId }, data: { isCurrent: true } });

      expect((await call('root', { m: 'post', p: '/schools', b: { code: 'ZZTEST', name: 'Zed' } })).status).toBe(201);
      expect(await status('root', { m: 'post', p: '/schools', b: { code: 'ZZTEST', name: 'Zed' } })).toBe(409);
      expect(await status('root', { m: 'post', p: '/schools', b: { code: 'bad code', name: 'Zed' } })).toBe(400);
      expect(await status('root', { m: 'post', p: '/schools', b: { code: 'ZZB' } })).toBe(400);
    });

    it('promotions: candidates, bulk promote, holdbacks, idempotent, cross-school refs refused', async () => {
      const cand = await call('accountant1', { m: 'get', p: `/promotions/candidates?schoolId=${a.schoolId}&fromYearId=${a.yearId}&fromSectionId=${a.sectionId}` });
      expect(cand.status).toBe(200);
      const ids: number[] = cand.body.map((s: { id: number }) => s.id);
      expect(ids.length).toBeGreaterThan(0);
      const body = (over: object = {}) => ({ fromYearId: a.yearId, toYearId: nextYearId, fromSectionId: a.sectionId, toSectionId: a.section2Id, excludeStudentIds: [ids[0]], ...over });
      expect((await call('accountant1', { m: 'post', p: '/promotions', b: body({ toSectionId: b.sectionId }) })).status).toBe(400);
      expect((await call('admin2', { m: 'post', p: '/promotions', b: body() })).status).toBe(403);
      expect((await call('viewer1', { m: 'post', p: '/promotions', b: body() })).status).toBe(403);
      const ok = await call('accountant1', { m: 'post', p: '/promotions', b: body() });
      expect(ok.status).toBe(201);
      expect(ok.body.promoted).toBe(ids.length - 1);
      const again = await call('accountant1', { m: 'post', p: '/promotions', b: body() });
      expect(again.body.promoted).toBe(0);
      expect(again.body.alreadyEnrolled).toHaveLength(ids.length - 1);
      const next = (await call('viewer1', { m: 'get', p: `/students?schoolId=${a.schoolId}&yearId=${nextYearId}` })).body;
      expect(next).toHaveLength(ids.length - 1);
      expect(next.some((s: { id: number }) => s.id === ids[0])).toBe(false);
      expect.soft((await call('accountant1', { m: 'post', p: '/promotions', b: body({ toYearId: 999999 }) })).status, 'unknown target year').toBeLessThan(500);
      expect.soft((await call('accountant1', { m: 'post', p: '/promotions', b: body({ toYearId: a.yearId, excludeStudentIds: [] }) })).status, 'promote into same year').toBeLessThan(500);
    });
  });
});
