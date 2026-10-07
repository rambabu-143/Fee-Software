import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { SmsModule } from './../src/sms/sms.module.js';
import { EmailModule } from './../src/email/email.module.js';
import { ImportModule } from './../src/import/import.module.js';
import { AuditModule } from './../src/audit/audit.module.js';
import { AuditInterceptor } from './../src/audit/audit.interceptor.js';
import { SettingsModule } from './../src/settings/settings.module.js';

// Runs inside its own throwaway school (code A5OPS: one class, one section, no fee grid) so it can't disturb, or be
// disturbed by, the other specs sharing the DB. DEMO2 only supplies "another school's admin". Everything is removed after.
describe('ops: sms, email, import, settings, audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const login = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });
  let root: Record<string, string>, admin: Record<string, string>, acct: Record<string, string>, viewer: Record<string, string>, other: Record<string, string>;
  let s1: number, s2: number, yearId: number;
  const className = 'A5 Class', sectionName = 'A';
  const enr: number[] = [];

  const cleanup = async () => {
    const school = await prisma.school.findUnique({ where: { code: 'A5OPS' } });
    if (school) {
      const where = { schoolId: school.id };
      await Promise.all([prisma.smsLog, prisma.emailLog, prisma.smsTemplate, prisma.emailTemplate, prisma.setting, prisma.auditLog].map((m) => (m as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({ where })));
      await prisma.enrollment.deleteMany({ where: { student: where } });
      await prisma.student.deleteMany({ where });
      await prisma.section.deleteMany({ where: { standard: where } });
      await prisma.standard.deleteMany({ where });
      await prisma.user.deleteMany({ where });
      await prisma.school.delete({ where: { id: school.id } });
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: 'a5ops-' } } });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule, SmsModule, EmailModule, ImportModule, AuditModule, SettingsModule],
      providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' }); // same as main.ts
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    s2 = (await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } })).id;
    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    await cleanup();
    s1 = (await prisma.school.create({ data: { code: 'A5OPS', name: 'A5 Ops School' } })).id;
    const std = await prisma.standard.create({ data: { schoolId: s1, name: className, sortOrder: 0 } });
    await prisma.section.create({ data: { standardId: std.id, name: sectionName } });
    root = await login('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    for (const [u, role, schoolId] of [['admin', 'ADMIN', s1], ['acct', 'ACCOUNTANT', s1], ['viewer', 'VIEWER', s1], ['other', 'ADMIN', s2]] as const) {
      await http().post('/api/users').set(root).send({ username: `a5ops-${u}`, password: 'password1', role, schoolId }).expect(201);
    }
    [admin, acct, viewer, other] = await Promise.all(['admin', 'acct', 'viewer', 'other'].map((u) => login(`a5ops-${u}`, 'password1')));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('authz: 401 without a token, 403 for the wrong role or school', async () => {
    for (const [m, p] of [['get', `/api/sms-templates?schoolId=${s1}`], ['get', `/api/settings?schoolId=${s1}`], ['get', '/api/audit'], ['post', '/api/import/students']] as const) {
      await http()[m](p).expect(401);
    }
    const tpl = { schoolId: s1, forType: 'general', content: 'E2E hi' };
    await http().post('/api/sms-templates').set(acct).send(tpl).expect(403);
    await http().post('/api/sms-templates').set(viewer).send(tpl).expect(403);
    await http().post('/api/sms-templates').set(other).send(tpl).expect(403); // another school's admin
    await http().get(`/api/sms-templates?schoolId=${s1}`).set(viewer).expect(403);
    await http().get(`/api/sms-templates?schoolId=${s1}`).set(acct).expect(200);
    await http().get(`/api/sms/log?schoolId=${s1}`).set(viewer).expect(403);
    await http().get(`/api/sms/log?schoolId=${s1}`).set(other).expect(403);
    await http().post('/api/import/students').set(acct).send({ schoolId: s1, yearId, rows: [{}] }).expect(403);
    await http().post('/api/email-templates').set(acct).send({ schoolId: s1, name: 'E2E x', subject: 's', body: 'b' }).expect(403);
    await http().get('/api/audit').set(acct).expect(403);
    await http().get('/api/audit').set(viewer).expect(403);
  });

  it('import: dry-run by default, per-row errors, all-or-nothing, idempotent, capped', async () => {
    const row = (n: number, extra: object = {}) => ({ admissionNo: `E2E-OPS-${n}`, name: `Ops Kid ${n}`, standard: className, section: sectionName, ...extra });
    const url = (dry?: string) => `/api/import/students${dry ? `?dryRun=${dry}` : ''}`;
    const count = () => prisma.student.count({ where: { admissionNo: { startsWith: 'E2E-OPS-' } } });
    const body = (rows: object[]) => ({ schoolId: s1, yearId, rows });

    // good file, no dryRun param => nothing written
    const good = [row(1, { phone: '98765 43210', email: 'one@example.com', fatherName: 'Dad One', rollNo: 7 }), row(2), row(3, { isNewAdmission: 'yes' })];
    const dry = await http().post(url()).set(admin).send(body(good)).expect(201);
    expect(dry.body).toMatchObject({ ok: true, dryRun: true, willCreate: 3, willUpdate: 0 });
    expect(await count()).toBe(0);

    // every problem reported with its row number
    const bad = [
      row(10), row(10), { ...row(11), name: '' }, row(12, { standard: 'Nope' }), row(13, { phone: '123' }),
      row(14, { dob: '31/12/2010' }), row(15, { email: 'N/A' }), row(16, { rollNo: 0 }), 'oops' as never,
    ];
    const rep = await http().post(url('true')).set(admin).send(body(bad)).expect(201);
    expect(rep.body.ok).toBe(false);
    const msgs = rep.body.errors.map((e: { row: number; msg: string }) => `${e.row}:${e.msg}`).join('|');
    for (const frag of ['2:Duplicate admissionNo', '3:name is required', '4:Unknown class', '5:Invalid phone', '6:dob must', '7:Invalid email', '8:rollNo', '9:Row is not an object']) {
      expect(msgs).toContain(frag);
    }
    expect(await count()).toBe(0);

    // real run with one bad row among good ones => 400 and NOTHING saved
    const mixed = [...good, row(99, { standard: 'Nope' })];
    const rej = await http().post(url('false')).set(admin).send(body(mixed)).expect(400);
    expect(rej.body.errors).toHaveLength(1);
    expect(await count()).toBe(0);

    // real run
    const live = await http().post(url('false')).set(admin).send(body(good)).expect(201);
    expect(live.body).toMatchObject({ ok: true, dryRun: false, willCreate: 3 });
    expect(await count()).toBe(3);
    const s = await prisma.student.findUniqueOrThrow({ where: { schoolId_admissionNo: { schoolId: s1, admissionNo: 'E2E-OPS-1' } }, include: { enrollments: true } });
    expect(s).toMatchObject({ phone: '9876543210', fatherName: 'Dad One' });
    expect(s.enrollments).toHaveLength(1);
    expect(s.enrollments[0]).toMatchObject({ yearId, rollNo: 7, isNewAdmission: false });
    for (const n of [1, 2, 3]) enr.push((await prisma.enrollment.findFirstOrThrow({ where: { student: { admissionNo: `E2E-OPS-${n}`, schoolId: s1 }, yearId } })).id);

    // same file again => updates, no duplicates
    const again = await http().post(url('false')).set(admin).send(body(good)).expect(201);
    expect(again.body).toMatchObject({ willCreate: 0, willUpdate: 3 });
    expect(await count()).toBe(3);
    expect(await prisma.enrollment.count({ where: { student: { admissionNo: { startsWith: 'E2E-OPS-' } }, yearId } })).toBe(3);

    // caps and validation at the edge
    const huge = Array.from({ length: 2001 }, (_, i) => row(1000 + i));
    await http().post(url('true')).set(admin).send(body(huge)).expect(400);
    await http().post(url('true')).set(admin).send(body([])).expect(400);
    await http().post(url('true')).set(admin).send({ schoolId: s1, yearId: 999999, rows: [row(5)] }).expect(400);
    await http().post(url('true')).set(other).send(body(good)).expect(403);
  });

  it('sms: templates, per-row results, skips, log, provider failure, switch-off', async () => {
    await http().post('/api/sms-templates').set(admin).send({ schoolId: s1, forType: 'general', content: '   ' }).expect(400);
    await http().post('/api/sms-templates').set(admin).send({ schoolId: s1, forType: 'bogus', content: 'E2E x' }).expect(400);
    const { body: t } = await http().post('/api/sms-templates').set(admin)
      .send({ schoolId: s1, forType: 'defaulter', starting: 'E2E Dear parent, ', content: '{name} ({admNo}) owes Rs {due}.', ending: ' -School' }).expect(201);
    const list = await http().get(`/api/sms-templates?schoolId=${s1}&type=defaulter`).set(acct).expect(200);
    expect(list.body.map((x: { id: number }) => x.id)).toContain(t.id);
    await http().patch(`/api/sms-templates/${t.id}`).set(other).send({ ending: ' hacked' }).expect(403);
    await http().patch(`/api/sms-templates/${t.id}`).set(admin).send({ ending: ' -Office' }).expect(200);

    // enr[0] valid phone, enr[1] none, enr[2] garbage
    await prisma.student.updateMany({ where: { admissionNo: 'E2E-OPS-3' }, data: { phone: 'abc' } });
    const send = (ids: number[], who = acct) => http().post('/api/sms/send').set(who).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: ids });
    const r = await send([...enr, 999999]).expect(201);
    const by = Object.fromEntries(r.body.results.map((x: { enrollmentId: number; status: string; reason?: string }) => [x.enrollmentId, x]));
    expect(by[enr[0]].status).toBe('SENT');
    expect(by[enr[1]]).toMatchObject({ status: 'SKIPPED', reason: 'No mobile number' });
    expect(by[enr[2]]).toMatchObject({ status: 'SKIPPED', reason: 'Invalid mobile number' });
    expect(by[999999].status).toBe('SKIPPED');
    expect(r.body.sent).toBe(1);

    const log = await http().get(`/api/sms/log?schoolId=${s1}&type=defaulter&status=SENT`).set(acct).expect(200);
    const mine = log.body.filter((l: { body: string }) => l.body.startsWith('E2E'));
    expect(mine).toHaveLength(1);
    expect(mine[0].number).toBe('9876543210');
    expect(mine[0].body).toMatch(/^E2E Dear parent, Ops Kid 1 \(E2E-OPS-1\) owes Rs \d+\.\d\d\. -Office$/);
    await http().get(`/api/sms/log?schoolId=${s1}&status=NOPE`).set(acct).expect(400);

    // duplicate ids in one request are sent once; oversize batch refused
    await send([enr[0], enr[0]]).expect(201);
    expect((await prisma.smsLog.count({ where: { schoolId: s1, body: { startsWith: 'E2E' } } }))).toBe(2);
    await http().post('/api/sms/send').set(acct).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: Array.from({ length: 501 }, (_, i) => i + 1) }).expect(400);
    await http().post('/api/sms/send').set(acct).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: [] }).expect(400);
    await send([enr[0]], viewer).expect(403);
    await send([enr[0]], other).expect(403);

    // unimplemented provider => row FAILED, request still fine, logged as FAILED
    process.env.SMS_PROVIDER = 'textlocal';
    try {
      const f = await send([enr[0]]).expect(201);
      expect(f.body.results[0]).toMatchObject({ status: 'FAILED' });
      expect(f.body.sent).toBe(0);
      expect(await prisma.smsLog.count({ where: { schoolId: s1, body: { startsWith: 'E2E' }, status: 'FAILED' } })).toBe(1);
    } finally { delete process.env.SMS_PROVIDER; }

    // switched off per school
    await http().put('/api/settings/smsEnabled').set(admin).send({ value: false }).expect(200);
    await send([enr[0]]).expect(400);
    await http().put('/api/settings/smsEnabled').set(admin).send({ value: true }).expect(200);

    // soft delete: gone from the list, can't be used
    await http().delete(`/api/sms-templates/${t.id}`).set(admin).expect(200);
    expect((await http().get(`/api/sms-templates?schoolId=${s1}`).set(acct)).body.map((x: { id: number }) => x.id)).not.toContain(t.id);
    await send([enr[0]]).expect(400);
  });

  it('email: valid + distinct addresses only, one log row per address', async () => {
    await http().post('/api/email-templates').set(admin).send({ schoolId: s1, name: 'E2E x', subject: 'E2E', body: '   ' }).expect(400);
    const { body: t } = await http().post('/api/email-templates').set(admin)
      .send({ schoolId: s1, name: 'E2E notice', subject: 'E2E fees for {name}', body: 'Dear parent, {name} owes {due} by {lastDate}.' }).expect(201);
    await prisma.student.updateMany({ where: { admissionNo: 'E2E-OPS-1' }, data: { fatherEmail: 'dad@example.com', motherEmail: 'ONE@example.com' } }); // = student's own, case-insensitive
    await prisma.student.updateMany({ where: { admissionNo: 'E2E-OPS-3' }, data: { email: 'NA', fatherEmail: 'N/A' } });
    const r = await http().post('/api/email/send').set(acct).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: enr }).expect(201);
    const by = Object.fromEntries(r.body.results.map((x: { enrollmentId: number }) => [x.enrollmentId, x]));
    expect(by[enr[0]]).toMatchObject({ status: 'SENT', sent: 2 }); // one@ + dad@, mother's duplicate collapsed
    expect(by[enr[1]]).toMatchObject({ status: 'SKIPPED', reason: 'No valid email address' });
    expect(by[enr[2]]).toMatchObject({ status: 'SKIPPED', reason: 'No valid email address' });
    const log = await http().get(`/api/email/log?schoolId=${s1}&status=SENT`).set(acct).expect(200);
    const mine = log.body.filter((l: { subject: string }) => l.subject.startsWith('E2E'));
    expect(mine.map((l: { address: string }) => l.address).sort()).toEqual(['dad@example.com', 'one@example.com']);
    expect(mine[0].subject).toBe('E2E fees for Ops Kid 1');
    await http().post('/api/email/send').set(viewer).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: enr }).expect(403);

    // SMTP configured but nodemailer not installed => FAILED rows, not a crash
    process.env.SMTP_HOST = 'smtp.invalid';
    try {
      const f = await http().post('/api/email/send').set(acct).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: [enr[0]] }).expect(201);
      expect(f.body.results[0]).toMatchObject({ status: 'FAILED' });
    } finally { delete process.env.SMTP_HOST; }
    await http().delete(`/api/email-templates/${t.id}`).set(admin).expect(200);
    await http().post('/api/email/send').set(acct).send({ schoolId: s1, templateId: t.id, yearId, enrollmentIds: enr }).expect(400);
  });

  it('settings: whitelist, types, defaults, role limits', async () => {
    const get = (who = viewer) => http().get(`/api/settings?schoolId=${s1}`).set(who);
    expect((await get().expect(200)).body).toEqual({ receiptFooter: '', smsEnabled: true, lateFeeEnabled: true });
    await http().put('/api/settings/receiptFooter').set(admin).send({ value: 'Thank you' }).expect(200);
    await http().put('/api/settings/lateFeeEnabled').set(admin).send({ schoolId: s1, value: false }).expect(200);
    expect((await get().expect(200)).body).toEqual({ receiptFooter: 'Thank you', smsEnabled: true, lateFeeEnabled: false });
    await http().put('/api/settings/nope').set(admin).send({ value: 1 }).expect(400); // unknown key
    await http().put('/api/settings/smsEnabled').set(admin).send({ value: 'yes' }).expect(400); // wrong type
    await http().put('/api/settings/receiptFooter').set(admin).send({ value: 'x'.repeat(201) }).expect(400);
    await http().put('/api/settings/receiptFooter').set(admin).send({}).expect(400);
    await http().put('/api/settings/receiptFooter').set(acct).send({ value: 'hi' }).expect(403);
    await http().put('/api/settings/receiptFooter').set(viewer).send({ value: 'hi' }).expect(403);
    await http().put('/api/settings/receiptFooter').set(other).send({ schoolId: s1, value: 'hi' }).expect(403);
    await http().get(`/api/settings?schoolId=${s1}`).set(other).expect(403);
    await http().get('/api/settings').set(root).expect(400); // superadmin must say which school
  });

  it('audit: logs mutations, redacts secrets, skips login, school-scoped, read-only', async () => {
    const q = (p: string, who = admin) => http().get(`/api/audit${p}`).set(who);
    const all = (await q('?take=200').expect(200)).body;
    expect(all.total).toBeGreaterThan(0);
    expect(all.rows.every((r: { schoolId: number }) => r.schoolId === s1)).toBe(true); // school admin only sees own school
    expect(all.rows.map((r: { entity: string }) => r.entity)).not.toContain('auth'); // logins never logged
    expect(all.rows.map((r: { entity: string }) => r.entity)).toEqual(expect.arrayContaining(['sms-templates', 'import', 'settings']));

    // user creation by the root user carried password1 in the body; it must be redacted. schoolId is in that body
    const users = (await q('?entity=users&take=200', root).expect(200)).body.rows.filter((r: { after: { username?: string } | null }) => r.after?.username?.startsWith('a5ops-'));
    expect(users.length).toBeGreaterThanOrEqual(4);
    for (const u of users) {
      expect(u.action).toBe('CREATE');
      expect(JSON.stringify(u.after)).not.toContain('password1');
      expect(u.after.password).toBe('[redacted]');
    }
    // the cleanup of the import payload: only a summary, not 2000 rows, for oversized bodies; small ones are kept
    const imp = (await q('?entity=import').expect(200)).body.rows;
    expect(imp.length).toBeGreaterThan(0);
    expect(imp[0].username).toBe('a5ops-admin');
    // failed requests are not logged
    const before = (await q('?entity=sms-templates').expect(200)).body.total;
    await http().post('/api/sms-templates').set(admin).send({ schoolId: s1, forType: 'bogus', content: 'E2E x' }).expect(400);
    expect((await q('?entity=sms-templates').expect(200)).body.total).toBe(before);
    // filters + paging
    expect((await q('?entity=sms-templates&take=1').expect(200)).body.rows).toHaveLength(1);
    expect((await q('?entity=sms-templates&entityId=999999').expect(200)).body.rows).toHaveLength(0);
    // immutable through the API
    for (const m of ['put', 'patch', 'delete', 'post'] as const) await http()[m]('/api/audit/1').set(root).send({}).expect(404);
    await http().delete('/api/audit').set(root).expect(404);
    await q('', other).expect(200); // other school's admin: allowed, but sees none of school 1's rows
    expect((await q('?take=200', other)).body.rows.every((r: { schoolId: number }) => r.schoolId === s2)).toBe(true);
    await q(`?schoolId=${s1}`, other).expect(403);
  });
});
