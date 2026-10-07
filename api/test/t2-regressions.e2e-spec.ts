import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Regressions found by the end-to-end pass over students/documents/reports. Needs a seeded DB.
// Everything lives in its own school (code ZRG*) and is removed afterwards.
describe('end-to-end regressions (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let auth: Record<string, string>;
  let base = '';
  const http = () => request(base);
  const code = `ZRG${[...String(Date.now())].map((d) => 'ABCDEFGHIJ'[+d]).join('').slice(-6)}`;
  let schoolId: number, yearId: number, sectionId: number, standardId: number, headId: number, instId: number, bankId: number;
  const N = 520; // more than the old 500-row list cap and the 60-form zip cap

  const bin = (r: request.Test) => r.buffer(true).parse((res, cb) => {
    const c: Buffer[] = [];
    res.on('data', (d: Buffer) => c.push(d));
    res.on('end', () => cb(null, Buffer.concat(c)));
  });
  // Text drawn in a pdfkit page (hex strings in TJ/Tj), good enough to look for a stamp.
  const pdfText = (b: Buffer) => {
    let out = '';
    for (const m of b.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let d: string;
      try { d = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
      for (const h of d.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
      for (const l of d.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) out += l[1];
    }
    return out;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.useBodyParser('json', { limit: '2mb' });
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);
    const token = (await http().post('/api/auth/login').send({ username: 'admin', password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123' }).expect(201)).body.token;
    auth = { Authorization: `Bearer ${token}` };
    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    schoolId = (await http().post('/api/schools').set(auth).send({ code, name: 'Regression School' }).expect(201)).body.id;
    standardId = (await http().post('/api/standards').set(auth).send({ schoolId, name: 'R One', sortOrder: 1 }).expect(201)).body.id;
    sectionId = (await http().post('/api/sections').set(auth).send({ standardId, name: 'A' }).expect(201)).body.id;
    headId = (await http().post('/api/fee-heads').set(auth).send({ schoolId, name: 'Tuition', type: 'MONTHLY' }).expect(201)).body.id;
    instId = (await http().post('/api/installments').set(auth).send({ schoolId, yearId, number: 1, label: 'Inst 1', dueDate: '2026-04-10', finePerDay: 0 }).expect(201)).body.id;
    await http().put('/api/fee-structure').set(auth).send({ yearId, standardId, items: [{ feeHeadId: headId, installmentId: instId, amount: 1000 }] }).expect(200);
    bankId = (await http().post('/api/banks').set(auth).send({ schoolId, name: 'Reg Bank' }).expect(201)).body.id;
    const rows = Array.from({ length: N }, (_, i) => ({ admissionNo: `RG-${i}`, name: `Reg ${i}`, standard: 'R One', section: 'A' }));
    await http().post('/api/import/students?dryRun=false').set(auth).send({ schoolId, yearId, rows }).expect(201);
  });

  afterAll(async () => {
    const stds = { in: [standardId] };
    await prisma.paymentAllocation.deleteMany({ where: { payment: { schoolId } } });
    await prisma.payment.deleteMany({ where: { schoolId } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId } });
    await prisma.enrollment.deleteMany({ where: { student: { schoolId } } }); // concessions cascade
    await prisma.student.deleteMany({ where: { schoolId } });
    await prisma.feeStructure.deleteMany({ where: { standardId: stds } });
    await prisma.installment.deleteMany({ where: { schoolId } });
    await prisma.feeHead.deleteMany({ where: { schoolId } });
    await prisma.bank.deleteMany({ where: { schoolId } });
    await prisma.section.deleteMany({ where: { standardId: stds } });
    await prisma.standard.deleteMany({ where: { id: stds } });
    await prisma.school.delete({ where: { id: schoolId } });
    await app.close();
  });

  it('student list is not silently truncated past 500', async () => {
    const list = (await http().get(`/api/students?schoolId=${schoolId}&yearId=${yearId}`).set(auth).expect(200)).body;
    expect(list).toHaveLength(N);
  });

  it('concession category can be saved, is returned, and drives the reports', async () => {
    const ids = (await http().get(`/api/students?schoolId=${schoolId}&yearId=${yearId}&q=RG-1`).set(auth).expect(200)).body.slice(0, 2).map((s: { id: number }) => s.id);
    await http().put(`/api/students/${ids[0]}/concessions`).set(auth)
      .send({ yearId, items: [{ feeHeadId: headId, percent: 50, reason: 'Needy', category: 'ECONOMIC' }] }).expect(200);
    await http().put(`/api/students/${ids[1]}/concessions`).set(auth)
      .send({ yearId, items: [{ feeHeadId: headId, percent: 100, reason: 'Staff ward' }] }).expect(200); // no category
    const back = (await http().get(`/api/students/${ids[0]}/concessions?yearId=${yearId}`).set(auth).expect(200)).body;
    expect(back[0].category).toBe('ECONOMIC');
    const rep = (await http().get(`/api/reports/concessions?schoolId=${schoolId}&yearId=${yearId}&category=ECONOMIC`).set(auth).expect(200)).body;
    expect(rep).toHaveLength(1);
    const sum = (await http().get(`/api/reports/concessions?schoolId=${schoolId}&yearId=${yearId}&summary=1`).set(auth).expect(200)).body[0];
    expect(sum.ECONOMIC).toBe('500.00');
    expect(sum.UNCATEGORISED).toBe('1000.00');
  });

  it('concession-forms zip counts only students with concessions, not the whole 520-student section', async () => {
    const z = await bin(http().get(`/api/sections/${sectionId}/concession-forms.zip?yearId=${yearId}&lastDate=2026-12-31`).set(auth).expect(200));
    const f = join(mkdtempSync(join(tmpdir(), 'reg-')), 'x.zip');
    writeFileSync(f, z.body);
    execFileSync('unzip', ['-t', f]);
    const names = execFileSync('unzip', ['-Z1', f]).toString().trim().split('\n').sort();
    expect(names.filter((n) => n.endsWith('.pdf'))).toHaveLength(1); // the staff-ward one is skipped
    expect(names).toContain('_skipped.txt');
  });

  it('CSV exports are UTF-8 with a BOM so Excel reads Telugu/Hindi names', async () => {
    const r = await bin(http().get(`/api/reports/studentwise?schoolId=${schoolId}&yearId=${yearId}&format=csv`).set(auth).expect(200));
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect((r.body as Buffer).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('a bounced cheque receipt is stamped BOUNCED, a good one is not', async () => {
    const [a, b] = (await http().get(`/api/students?schoolId=${schoolId}&yearId=${yearId}&q=RG-30`).set(auth).expect(200)).body.slice(0, 2).map((s: { id: number }) => s.id);
    const collect = async (studentId: number) => (await http().post('/api/payments').set(auth)
      .send({ studentId, yearId, amount: 100, mode: 'CHEQUE', bankId, chequeNo: `CH${studentId}`, chequeDate: '2026-10-01', reference: `CH${studentId}` }).expect(201)).body.id as number;
    const [pa, pb] = [await collect(a), await collect(b)];
    const today = new Date().toISOString().slice(0, 10);
    await http().post(`/api/payments/${pa}/reconcile`).set(auth).send({ status: 'BOUNCED', bankDate: today }).expect(201);
    const bounced = await bin(http().get(`/api/payments/${pa}/pdf`).set(auth).expect(200));
    const fine = await bin(http().get(`/api/payments/${pb}/pdf`).set(auth).expect(200));
    expect(pdfText(bounced.body as Buffer)).toContain('BOUNCED');
    expect(pdfText(fine.body as Buffer)).not.toContain('BOUNCED');
  });
});
