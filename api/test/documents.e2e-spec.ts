import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { DocumentsModule } from './../src/documents/documents.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Needs a seeded DB. Creates its own class/students/users (users docs-x-*, students DOCX-*, classes DOCX *) and removes them.
describe('documents (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base = '';
  const http = () => request(base);
  const tag = `${Date.now()}`;
  const bearer = async (username: string, password: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password }).expect(201)).body.token}` });
  // Binary download -> Buffer.
  const bin = (r: request.Test) => r.buffer(true).parse((res, cb) => {
    const c: Buffer[] = [];
    res.on('data', (d: Buffer) => c.push(d));
    res.on('end', () => cb(null, Buffer.concat(c)));
  });
  const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';
  const unzipList = (b: Buffer) => {
    const f = join(mkdtempSync(join(tmpdir(), 'docs-')), 'x.zip');
    writeFileSync(f, b);
    execFileSync('unzip', ['-t', f]); // throws if the archive is corrupt
    return execFileSync('unzip', ['-Z1', f]).toString().trim().split('\n').sort();
  };

  let root: Record<string, string>, admin1: Record<string, string>, acct1: Record<string, string>, viewer1: Record<string, string>, admin2: Record<string, string>;
  let s1: number, yearId: number, standardId: number, sectionId: number, feeStandardId: number, feeSectionId: number, headId: number;
  let sA: number, sC: number, sD: number, sB: number; // A,C,D in own class; B in an own class with its own fee grid (so other suites editing the seed grid can't affect it)
  let origSchool: { affiliationNo: string | null; schoolNo: string | null; address: string | null; kind: 'SENIOR' | 'JUNIOR' };
  const mk = (n: string, extra: object = {}, section = sectionId) => http().post('/api/students').set(admin1).send({
    schoolId: s1, yearId, admissionNo: `DOCX-${tag}-${n}`, name: `Doc Student ${n}`, sectionId: section,
    isNewAdmission: false, optionalHeadIds: [], dob: '2010-03-05', fatherName: 'FATHER ONE', motherName: 'MOTHER ONE', ...extra,
  }).expect(201).then((r) => r.body.id as number);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule, DocumentsModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    root = await bearer('admin', process.env.SEED_ADMIN_PASSWORD ?? 'admin123');
    const school1 = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO1' } });
    const school2 = await prisma.school.findUniqueOrThrow({ where: { code: 'DEMO2' } });
    s1 = school1.id;
    origSchool = { affiliationNo: school1.affiliationNo, schoolNo: school1.schoolNo, address: school1.address, kind: school1.kind };
    // Pin by label: other suites briefly flip isCurrent when they create years.
    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    for (const [u, role, schoolId] of [['docs-x-admin', 'ADMIN', s1], ['docs-x-acct', 'ACCOUNTANT', s1], ['docs-x-viewer', 'VIEWER', s1], ['docs-x-admin2', 'ADMIN', school2.id]] as const) {
      await prisma.user.deleteMany({ where: { username: u } });
      await http().post('/api/users').set(root).send({ username: u, password: 'password1', role, schoolId }).expect(201);
    }
    [admin1, acct1, viewer1, admin2] = await Promise.all(['docs-x-admin', 'docs-x-acct', 'docs-x-viewer', 'docs-x-admin2'].map((u) => bearer(u, 'password1')));
    standardId = (await http().post('/api/standards').set(admin1).send({ schoolId: s1, name: `DOCX ${tag}`, sortOrder: 998 }).expect(201)).body.id;
    sectionId = (await http().post('/api/sections').set(admin1).send({ standardId, name: 'A' }).expect(201)).body.id;
    feeStandardId = (await http().post('/api/standards').set(admin1).send({ schoolId: s1, name: `DOCX F ${tag}`, sortOrder: 997 }).expect(201)).body.id;
    feeSectionId = (await http().post('/api/sections').set(admin1).send({ standardId: feeStandardId, name: 'A' }).expect(201)).body.id;
    headId = (await prisma.feeHead.findFirstOrThrow({ where: { schoolId: s1, type: 'MONTHLY' } })).id;
    const inst = await prisma.installment.findFirstOrThrow({ where: { schoolId: s1, yearId }, orderBy: { number: 'asc' } });
    await http().put('/api/fee-structure').set(admin1).send({ yearId, standardId: feeStandardId, items: [{ feeHeadId: headId, installmentId: inst.id, amount: 5000 }] }).expect(200);
    sA = await mk('A', { fatherEmail: 'dad@example.com', motherEmail: 'mom@example.com' });
    sC = await mk('C');
    sD = await mk('D');
    sB = await mk('B', {}, feeSectionId);
    await prisma.student.update({ where: { id: sA }, data: { motherEmail: 'N/A' } }); // invalid on purpose
  });

  afterAll(async () => {
    const ids = (await prisma.student.findMany({ where: { admissionNo: { startsWith: `DOCX-${tag}` } }, select: { id: true } })).map((s) => s.id);
    const enr = await prisma.enrollment.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await prisma.emailLog.deleteMany({ where: { enrollmentId: { in: enr.map((e) => e.id) } } });
    await prisma.issuedDocument.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { issuedBy: { startsWith: 'docs-x-' } }] } });
    await prisma.paymentAllocation.deleteMany({ where: { payment: { studentId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { studentId: { in: ids } } }); // concessions cascade
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    const stds = { in: [standardId, feeStandardId].filter(Boolean) };
    await prisma.feeStructure.deleteMany({ where: { standardId: stds } });
    await prisma.section.deleteMany({ where: { standardId: stds } });
    await prisma.standard.deleteMany({ where: { id: stds } });
    await prisma.school.update({ where: { id: s1 }, data: origSchool });
    await prisma.user.deleteMany({ where: { username: { startsWith: 'docs-x-' } } });
    await app.close();
  });

  it('school letterhead + class teacher: roles, scoping, round-trip', async () => {
    const body = { affiliationNo: '2730001', schoolNo: '12345', address: '1 Demo Road', kind: 'JUNIOR' };
    await http().patch(`/api/schools/${s1}`).set(viewer1).send(body).expect(403);
    await http().patch(`/api/schools/${s1}`).set(admin2).send(body).expect(403);
    await http().patch(`/api/schools/${s1}`).set(admin1).send({ kind: 'MIDDLE' }).expect(400);
    await http().patch(`/api/schools/${s1}`).set(admin1).send({ code: 'X' }).expect(400); // code is immutable
    await http().patch(`/api/schools/${s1}`).set(admin1).send(body).expect(200);
    const got = (await http().get('/api/schools').set(admin1).expect(200)).body.find((s: { id: number }) => s.id === s1);
    expect(got).toMatchObject(body);
    await http().patch(`/api/schools/${s1}`).set(admin1).send({ kind: 'SENIOR' }).expect(200);

    await http().patch(`/api/sections/${sectionId}`).set(acct1).send({ classTeacher: 'Ms Rao' }).expect(403);
    await http().patch(`/api/sections/${sectionId}`).set(admin2).send({ classTeacher: 'Ms Rao' }).expect(403);
    await http().patch(`/api/sections/${sectionId}`).set(admin1).send({ classTeacher: 'Ms Rao' }).expect(200);
    const stds = (await http().get(`/api/standards?schoolId=${s1}`).set(admin1).expect(200)).body;
    expect(stds.find((s: { id: number }) => s.id === standardId).sections[0].classTeacher).toBe('Ms Rao');
  });

  it('TC: ADMIN only, validated, scoped, serials unique, reissue supersedes, dues block + override', async () => {
    const dto = (studentId: number, extra: object = {}) => ({ studentId, yearId, dateOfIssue: '2026-10-01', leavingReason: 'Parent transfer', board: 'CBSE', generalConduct: 'Good', staffName: 'Clerk', ...extra });
    await http().post('/api/documents/tc').set(acct1).send(dto(sA)).expect(403);
    await http().post('/api/documents/tc').set(viewer1).send(dto(sA)).expect(403);
    await http().post('/api/documents/tc').set(admin2).send(dto(sA)).expect(403); // other school
    await http().post('/api/documents/tc').set(admin1).send({ studentId: sA, yearId, dateOfIssue: '2026-10-01' }).expect(400); // no reason
    await http().post('/api/documents/tc').set(admin1).send(dto(sA, { bogus: 1 })).expect(400);
    await http().post('/api/documents/tc').set(admin1).send(dto(sA, { yearId: 999999 })).expect(404);

    // Dues pending (own class has a fee grid) -> blocked; override passes.
    const blocked = await http().post('/api/documents/tc').set(admin1).send(dto(sB)).expect(400);
    expect(blocked.body.message).toMatch(/pending/i);
    await bin(http().post('/api/documents/tc').set(admin1).send(dto(sB, { overrideDues: true }))).expect(201);

    // Three students at once: no duplicate serial.
    const res = await Promise.all([sA, sC, sD].map((s) => bin(http().post('/api/documents/tc').set(admin1).send(dto(s))).expect(201)));
    for (const r of res) { expect(isPdf(r.body)).toBe(true); expect(r.headers['content-type']).toMatch(/pdf/); }
    const serials = res.map((r) => Number(r.headers['x-serial-no']));
    expect(new Set(serials).size).toBe(3);

    // Reissue for A: new serial, old one superseded, marked duplicate.
    const again = await bin(http().post('/api/documents/tc').set(admin1).send(dto(sA, { leavingReason: 'Reissue after loss' }))).expect(201);
    expect(Number(again.headers['x-serial-no'])).toBeGreaterThan(Math.max(...serials));
    const list = (await http().get(`/api/students/${sA}/documents`).set(viewer1).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list.filter((d: { supersededAt: string | null }) => d.supersededAt === null)).toHaveLength(1);
    await http().get(`/api/students/${sA}/documents`).set(admin2).expect(403);
    const latest = list.find((d: { supersededAt: unknown }) => d.supersededAt === null);
    const row = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: latest.id } });
    expect((row.payload as { duplicate: boolean; name: string }).duplicate).toBe(true);
    expect((row.payload as { name: string }).name).toBe('Doc Student A');

    // Reprint uses the stored snapshot, even after the student is renamed.
    await prisma.student.update({ where: { id: sA }, data: { name: 'Renamed' } });
    const rp = await bin(http().get(`/api/documents/tc/${latest.id}/pdf`).set(acct1)).expect(200);
    expect(isPdf(rp.body)).toBe(true);
    await prisma.student.update({ where: { id: sA }, data: { name: 'Doc Student A' } });
    await http().get(`/api/documents/tc/${latest.id}/pdf`).set(viewer1).expect(403);
    await http().get(`/api/documents/tc/${latest.id}/pdf`).set(admin2).expect(403);
    await http().get('/api/documents/tc/99999999/pdf').set(admin1).expect(404);
  });

  it('fee certificate (ITC): lines sum to total, match bill, cancelled receipts excluded', async () => {
    await http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}`).set(viewer1).expect(403);
    await http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}`).set(admin2).expect(403);
    await http().get(`/api/students/${sB}/fee-certificate`).set(admin1).expect(400);
    const empty = (await http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}&json=1`).set(admin1).expect(200)).body;
    expect(empty.total).toBe('0.00');
    // ponytail: retry once on 409 - receipt-number collision when another suite collects in this school+year at the same instant.
    const pay = async (amount: number) => {
      const send = () => http().post('/api/payments').set(admin1).send({ studentId: sB, yearId, amount, mode: 'CASH' });
      let r = await send();
      if (r.status === 409) r = await send();
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    await pay(1000.5);
    const p2 = await pay(499.25);
    const cert = (await http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}&json=1`).set(acct1).expect(200)).body;
    expect(cert.lines).toHaveLength(2);
    const sum = cert.lines.reduce((s: number, l: { amount: string }) => s + Math.round(Number(l.amount) * 100), 0);
    expect(sum).toBe(Math.round(Number(cert.total) * 100));
    expect(cert.total).toBe('1499.75');
    for (const l of cert.lines) expect(Math.round((Number(l.charges) + Number(l.fine)) * 100)).toBe(Math.round(Number(l.amount) * 100));
    const bill = (await http().get(`/api/students/${sB}/bill?yearId=${yearId}`).set(admin1).expect(200)).body;
    expect(bill.totals.paid).toBe(cert.total);
    const pdf = await bin(http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}`).set(admin1)).expect(200);
    expect(isPdf(pdf.body)).toBe(true);
    await http().post(`/api/payments/${p2}/cancel`).set(admin1).send({ reason: 'test cancel' }).expect(201);
    expect((await http().get(`/api/students/${sB}/fee-certificate?yearId=${yearId}&json=1`).set(admin1)).body.total).toBe('1000.50');
  });

  it('admission certificate pdf + stub email log (valid addresses only, nothing sent)', async () => {
    const pdf = await bin(http().get(`/api/students/${sA}/admission-certificate.pdf?yearId=${yearId}`).set(acct1)).expect(200);
    expect(isPdf(pdf.body)).toBe(true);
    await http().get(`/api/students/${sA}/admission-certificate.pdf?yearId=${yearId}`).set(viewer1).expect(403);
    await http().post(`/api/students/${sA}/admission-certificate/send`).set(admin2).send({ yearId }).expect(403);
    await http().post(`/api/students/${sA}/admission-certificate/send`).set(admin1).send({ yearId, to: 'cousin' }).expect(400);
    const r = (await http().post(`/api/students/${sA}/admission-certificate/send`).set(admin1).send({ yearId }).expect(201)).body;
    expect(r).toEqual({ logged: ['dad@example.com'], skipped: 1, delivered: false });
    const e = await prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: sA, yearId } } });
    const logs = await prisma.emailLog.findMany({ where: { enrollmentId: e.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ address: 'dad@example.com', status: 'QUEUED' });
    expect((await http().post(`/api/students/${sB}/admission-certificate/send`).set(admin1).send({ yearId }).expect(201)).body.logged).toEqual([]); // no emails on file
  });

  it('prep-to-I admission forms zip: valid archive, one pdf per student, scoped and capped', async () => {
    const z = await bin(http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}`).set(acct1)).expect(200);
    expect(z.headers['content-type']).toMatch(/zip/);
    expect(unzipList(z.body)).toEqual([`DOCX-${tag}-A.pdf`, `DOCX-${tag}-C.pdf`, `DOCX-${tag}-D.pdf`]);
    const one = await bin(http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}&studentIds=${sC}`).set(admin1)).expect(200);
    expect(unzipList(one.body)).toEqual([`DOCX-${tag}-C.pdf`]);
    await http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}&studentIds=abc`).set(admin1).expect(400);
    await http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}`).set(viewer1).expect(403);
    await http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}`).set(admin2).expect(403);
    await http().get(`/api/sections/99999999/admission-forms.zip?yearId=${yearId}`).set(admin1).expect(404);
    await http().get(`/api/sections/${sectionId}/admission-forms.zip?yearId=${yearId}&studentIds=${sB}`).set(admin1).expect(400); // not in this section
  });

  it('concession forms: staff + non-concession students skipped and reported', async () => {
    const enr = (s: number) => prisma.enrollment.findUniqueOrThrow({ where: { studentId_yearId: { studentId: s, yearId } } });
    await prisma.concession.create({ data: { enrollmentId: (await enr(sA)).id, feeHeadId: headId, percent: 25, reason: 'Merit', category: 'EDC' } });
    await prisma.concession.create({ data: { enrollmentId: (await enr(sC)).id, feeHeadId: headId, percent: 50, reason: 'Staff ward', category: 'STAFF' } });
    const q = `yearId=${yearId}&lastDate=2027-02-28`;
    await http().get(`/api/sections/${sectionId}/concession-forms.zip?yearId=${yearId}`).set(admin1).expect(400); // lastDate required
    await http().get(`/api/sections/${sectionId}/concession-forms.zip?yearId=${yearId}&lastDate=soon`).set(admin1).expect(400);
    await http().get(`/api/sections/${sectionId}/concession-forms.zip?${q}`).set(admin2).expect(403);
    await http().get(`/api/sections/${sectionId}/concession-forms.zip?${q}`).set(viewer1).expect(403);
    const z = await bin(http().get(`/api/sections/${sectionId}/concession-forms.zip?${q}`).set(admin1)).expect(200);
    expect(unzipList(z.body)).toEqual([`DOCX-${tag}-A.pdf`, '_skipped.txt']);
    const one = await bin(http().get(`/api/students/${sA}/concession-form?${q}`).set(acct1)).expect(200);
    expect(isPdf(one.body)).toBe(true);
    await http().get(`/api/students/${sC}/concession-form?${q}`).set(admin1).expect(400); // staff
    await http().get(`/api/students/${sD}/concession-form?${q}`).set(admin1).expect(400); // none
    await http().get(`/api/students/${sA}/concession-form?${q}`).set(admin2).expect(403);
    await http().get(`/api/sections/${feeSectionId}/concession-forms.zip?${q}`).set(admin1).expect(400); // nobody eligible
  });
});
