import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { listen } from './support.js';
import { AppModule } from './../src/app.module.js';
import { GuardiansModule } from './../src/guardians/guardians.module.js';
import { ReportsExtraModule } from './../src/reports-extra/reports-extra.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Reports on a private school with hand-computable fees (no fines: installments have no fine start).
//
//  class A4-1 (A): Tuition 1000 x2, Annual 600 (inst 1), Computer 100 x2 (opt-in)
//  class A4-2 (A): Tuition 2000 x2, Annual 800 (inst 1), Computer 100 x2 (opt-in)
//  transport slab 300 per installment; a stop leg is half, so pickup+drop = 300 per installment.
//
//  s1 A4-001 A4-1  Christian, family F, opt-in Computer, transport both legs, Tuition concession 10% (STAFF)
//     inst1 = 900+600+100+300 = 1900, inst2 = 900+100+300 = 1300 -> 3200; pays 1000 cash
//  s2 A4-002 A4-2  christian (lower), Nepali, family F, Annual concession 50 (EDC)
//     inst1 = 2000+750 = 2750, inst2 = 2000 -> 4750; pays 500 UPI
//  s3 A4-003 A4-1  CHRISTIAN no concession; inst1 1600, inst2 1000 -> 2600; pays 1600 cash
//  s4 A4-004 A4-1  Hindu; 2600; one receipt cancelled, one bounced (neither counts)
//  s5 A4-005 A4-1  withdrawn before the first installment (charges 0, off the roll), same family F
describe('reports-extra (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tag = `RX${Date.now()}`;
  let base = '';
  const http = () => request(base);
  const hdr: Record<string, { Authorization: string }> = {};
  let schoolId: number, otherSchoolId: number, yearId: number, std1: number, std2: number, sec1: number, headComp: number;
  const q = (extra = '') => `schoolId=${schoolId}&yearId=${yearId}${extra}`;
  const get = (path: string, who = 'adm') => http().get(`/api/reports/${path}`).set(hdr[who]);

  const login = async (username: string) =>
    ({ Authorization: `Bearer ${(await http().post('/api/auth/login').send({ username, password: 'pass12345' })).body.token}` });
  const pay = (studentId: number, amount: number, mode: string, reference?: string) =>
    http().post('/api/payments').set(hdr.adm).send({ studentId, yearId, amount, mode, reference }).expect(201);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule, GuardiansModule, ReportsExtraModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    base = await listen(app);
    prisma = app.get(PrismaService);

    yearId = (await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } })).id;
    const school = await prisma.school.create({ data: { code: `${tag}A`, name: 'RX A' } });
    schoolId = school.id;
    otherSchoolId = (await prisma.school.create({ data: { code: `${tag}B`, name: 'RX B' } })).id;

    const mkStd = async (name: string, sortOrder: number) => {
      const s = await prisma.standard.create({ data: { schoolId, name, sortOrder } });
      const sec = await prisma.section.create({ data: { standardId: s.id, name: 'A' } });
      return { std: s.id, sec: sec.id };
    };
    const c1 = await mkStd('A4-1', 1), c2 = await mkStd('A4-2', 2);
    std1 = c1.std; std2 = c2.std; sec1 = c1.sec;

    const head = (name: string, type: 'MONTHLY' | 'ANNUAL' | 'OPTIONAL') => prisma.feeHead.create({ data: { schoolId, name, type } });
    const tuition = await head('Tuition', 'MONTHLY'), annual = await head('Annual', 'ANNUAL'), comp = await head('Computer', 'OPTIONAL');
    headComp = comp.id;
    const inst = [1, 2].map((n) => prisma.installment.create({ data: { schoolId, yearId, number: n, label: `I${n}`, dueDate: new Date(`2099-0${n}-01`) } }));
    const [i1, i2] = await Promise.all(inst);
    const grid = (standardId: number, tuitionAmt: number, annualAmt: number) => [
      { standardId, feeHeadId: tuition.id, installmentId: i1.id, amount: tuitionAmt },
      { standardId, feeHeadId: tuition.id, installmentId: i2.id, amount: tuitionAmt },
      { standardId, feeHeadId: annual.id, installmentId: i1.id, amount: annualAmt },
      { standardId, feeHeadId: comp.id, installmentId: i1.id, amount: 100 },
      { standardId, feeHeadId: comp.id, installmentId: i2.id, amount: 100 },
    ].map((d) => ({ ...d, yearId }));
    await prisma.feeStructure.createMany({ data: [...grid(std1, 1000, 600), ...grid(std2, 2000, 800)] });

    // transport: route R1 -> stop on slab S1 (300 per installment)
    const route = await prisma.facility.create({ data: { schoolId, kind: 'TRANSPORT', name: 'R1' } });
    const slab = await prisma.facility.create({ data: { schoolId, kind: 'SLAB', name: 'S1' } });
    await prisma.facilityFeeStructure.createMany({ data: [i1, i2].map((i) => ({ yearId, facilityId: slab.id, installmentId: i.id, amount: 300 })) });
    const stop = await prisma.stop.create({ data: { routeId: route.id, slabId: slab.id, name: 'Stop1', sequence: 1, pickupTime: '07:30', dropTime: '15:30' } });

    const fam = 7_000_000 + (Date.now() % 1_000_000);
    const mkStudent = async (n: number, name: string, sectionId: number, extra: object = {}) => {
      const s = await prisma.student.create({ data: { schoolId, admissionNo: `A4-00${n}`, name, ...extra } });
      const e = await prisma.enrollment.create({ data: { studentId: s.id, yearId, sectionId } });
      return { id: s.id, enr: e.id };
    };
    const s1 = await mkStudent(1, 'Aarav', c1.sec, { gender: 'M', religion: 'Christian', familyId: fam });
    const s2 = await mkStudent(2, '=Evil, Name', c2.sec, { gender: 'F', religion: 'christian', nationality: 'NEPALI', familyId: fam });
    const s3 = await mkStudent(3, 'Chitra', c1.sec, { gender: 'F', religion: 'CHRISTIAN', nationality: 'indian' });
    const s4 = await mkStudent(4, 'Dev', c1.sec, { religion: 'Hindu', nationality: null });
    const s5 = await mkStudent(5, 'Esha', c1.sec, { familyId: fam });
    await prisma.enrollment.update({ where: { id: s1.enr }, data: { optionalHeads: { connect: [{ id: comp.id }] } } });
    await prisma.concession.create({ data: { enrollmentId: s1.enr, feeHeadId: tuition.id, percent: 10, reason: 'Staff ward', category: 'STAFF' } });
    await prisma.concession.create({ data: { enrollmentId: s2.enr, feeHeadId: annual.id, amount: 50, reason: 'Needy', category: 'EDC' } });
    await prisma.transportAssignment.create({ data: { enrollmentId: s1.enr, pickupStopId: stop.id, dropStopId: stop.id } });
    await prisma.withdrawal.create({ data: { enrollmentId: s5.enr, date: new Date('2026-01-01'), reason: 'Left', balanceDue: 0, excessPaid: 0, createdBy: 'test' } });
    await prisma.student.update({ where: { id: s5.id }, data: { active: false } });

    // guardians: s1/s2 fathers share one mobile + name (1 contact, 1 name: not a suggestion, already one family);
    // s3/s4 fathers share mobile + email + name (2 contacts: suggested).
    const prof = await prisma.occupation.create({ data: { schoolId, name: 'Professional' } });
    const eng = await prisma.occupation.create({ data: { schoolId, name: 'Engineer', parentId: prof.id } });
    await prisma.guardian.createMany({
      data: [
        { studentId: s1.id, name: 'Raj Kumar', relation: 'FATHER', mobile: '9000000001', occupationId: eng.id, isStaff: true, staffBranch: 'Main', designation: 'Lead' },
        { studentId: s2.id, name: 'Raj  Kumar', relation: 'FATHER', mobile: '9000000001', occupationId: prof.id },
        { studentId: s3.id, name: 'Mohan Rao', relation: 'FATHER', mobile: '+91 91111-11111', email: 'Mohan@X.com' },
        { studentId: s4.id, name: 'Mohan Rao', relation: 'FATHER', mobile: '9111111111', email: 'mohan@x.com' },
      ],
    });
    const hindi = await prisma.subject.create({ data: { schoolId, name: 'Hindi', kind: 'LANGUAGE' } });
    const french = await prisma.subject.create({ data: { schoolId, name: 'French', kind: 'LANGUAGE' } });
    const music = await prisma.subject.create({ data: { schoolId, name: 'Music', kind: 'ADDITIONAL' } });
    const sub = (enrollmentId: number, ...subjectIds: number[]) => prisma.studentSubject.createMany({ data: subjectIds.map((subjectId) => ({ enrollmentId, subjectId })) });
    await sub(s1.enr, hindi.id, music.id); await sub(s2.enr, french.id); await sub(s3.enr, hindi.id);

    const passwordHash = await bcrypt.hash('pass12345', 4);
    for (const [name, role, sid] of [['adm', 'ADMIN', schoolId], ['acc', 'ACCOUNTANT', schoolId], ['view', 'VIEWER', schoolId], ['accb', 'ACCOUNTANT', otherSchoolId]] as const) {
      await prisma.user.create({ data: { username: `${tag}${name}`.toLowerCase(), passwordHash, role, schoolId: sid } });
      hdr[name] = await login(`${tag}${name}`.toLowerCase());
    }

    await pay(s1.id, 1000, 'CASH');
    await pay(s3.id, 1600, 'CASH');
    await pay(s2.id, 500, 'UPI', 'UTR12345');
    const gone = (await pay(s4.id, 200, 'CASH')).body.id;
    await http().post(`/api/payments/${gone}/cancel`).set(hdr.adm).send({ reason: 'entered wrong' }).expect(201);
    const bounced = (await pay(s4.id, 300, 'UPI', 'UTR99999')).body.id;
    await prisma.payment.update({ where: { id: bounced }, data: { clearStatus: 'BOUNCED' } });
  });

  afterAll(async () => {
    const ids = [schoolId, otherSchoolId];
    await prisma.paymentAllocation.deleteMany({ where: { payment: { schoolId: { in: ids } } } });
    await prisma.payment.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.receiptCounter.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.enrollment.deleteMany({ where: { student: { schoolId: { in: ids } } } });
    await prisma.student.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.feeStructure.deleteMany({ where: { standard: { schoolId: { in: ids } } } });
    await prisma.facilityFeeStructure.deleteMany({ where: { facility: { schoolId: { in: ids } } } });
    await prisma.stop.deleteMany({ where: { route: { schoolId: { in: ids } } } });
    await prisma.facility.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.installment.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.feeHead.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.section.deleteMany({ where: { standard: { schoolId: { in: ids } } } });
    await prisma.standard.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.occupation.deleteMany({ where: { schoolId: { in: ids }, parentId: { not: null } } });
    await prisma.occupation.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.subject.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.user.deleteMany({ where: { schoolId: { in: ids } } });
    await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('access: viewers and other schools are refused on every report; suggestions are admin-only', async () => {
    const paths = ['siblings', 'siblings/suggestions', 'staff-wards', 'minority', 'non-indian', 'occupation', 'subjects', `fee-head-optin&feeHeadId=${headComp}`,
      'classwise', 'studentwise', 'bifurcation', 'transport-bifurcation', 'routes', 'concessions', 'payments-summary'];
    for (const p of paths) {
      const url = `${p.split('&')[0]}?${q(p.includes('&') ? `&${p.split('&')[1]}` : '')}`;
      expect((await get(url, 'view')).status, `viewer ${p}`).toBe(403);
      expect((await get(url, 'accb')).status, `other school ${p}`).toBe(403);
      expect((await http().get(`/api/reports/${url}`)).status, `anon ${p}`).toBe(401);
      if (p !== 'siblings/suggestions') expect((await get(url, 'acc')).status, `accountant ${p}`).toBe(200);
    }
    expect((await get(`siblings/suggestions?${q()}`, 'acc')).status).toBe(403);
    expect((await get(`siblings/suggestions?${q()}`, 'adm')).status).toBe(200);
  });

  it('siblings: the highest class anchors; withdrawn family members are left out; filters apply to the anchor', async () => {
    const r = (await get(`siblings?${q()}`)).body;
    expect(r).toHaveLength(1);
    expect(r[0].anchor).toMatchObject({ admissionNo: 'A4-002', className: 'A4-2 A' });
    expect(r[0].siblings).toEqual([{ admissionNo: 'A4-001', name: 'Aarav', className: 'A4-1 A' }]);
    expect((await get(`siblings?${q(`&standardId=${std1}`)}`)).body).toEqual([]);
    expect((await get(`siblings?${q(`&standardId=${std2}`)}`)).body).toHaveLength(1);
    const csv = (await get(`siblings?${q('&format=csv')}`)).text.replace(/^\uFEFF/, '');
    expect(csv.split('\r\n')[0]).toBe('familyId,anchorAdmissionNo,anchorName,anchorClass,siblingAdmissionNo,siblingName,siblingClass');
    // formula guard + quoting on the "=Evil, Name" student
    expect(csv).toContain(`"'=Evil, Name"`);
    expect(csv).toContain(',A4-001,Aarav,A4-1 A');
  });

  it('sibling suggestions: only the pair sharing 2 contacts (phone formats and email case normalised)', async () => {
    const r = (await get(`siblings/suggestions?${q()}`)).body;
    expect(r).toEqual([{ aAdmissionNo: 'A4-003', aName: 'Chitra', aClass: 'A4-1 A', bAdmissionNo: 'A4-004', bName: 'Dev', bClass: 'A4-1 A', sharedContacts: 2, sharedNames: 1 }]);
  });

  it('staff wards, minority, non-indian', async () => {
    const sw = (await get(`staff-wards?${q()}`)).body;
    expect(sw).toEqual([{ sNo: 1, admissionNo: 'A4-001', student: 'Aarav', className: 'A4-1 A', staffName: 'Raj Kumar', relation: 'FATHER', branch: 'Main', category: 'STAFF', concession: 'Staff ward' }]);

    const mi = (await get(`minority?${q()}`)).body;
    expect(mi.map((x: { admissionNo: string; fullPaying: string; concessionName: string }) => [x.admissionNo, x.fullPaying, x.concessionName]))
      .toEqual([['A4-001', 'NO', 'STAFF'], ['A4-002', 'NO', 'EDC'], ['A4-003', 'YES', '']]);
    expect((await get(`minority?${q('&religion=hindu')}`)).body.map((x: { admissionNo: string }) => x.admissionNo)).toEqual(['A4-004']);

    // A4-003 "indian" (any case), A4-004 null and the withdrawn student are not listed
    expect((await get(`non-indian?${q()}`)).body).toEqual([{ admissionNo: 'A4-002', name: '=Evil, Name', className: 'A4-2 A', nationality: 'NEPALI' }]);
  });

  it('occupation: category matches its sub-categories; sub filter is exact', async () => {
    const all = (await get(`occupation?${q()}`)).body;
    expect(all.map((x: { admissionNo: string }) => x.admissionNo)).toEqual(['A4-001', 'A4-002', 'A4-003', 'A4-004']);
    expect(all[2]).toMatchObject({ occupation: '', subCategory: '' });
    const prof = await prisma.occupation.findFirstOrThrow({ where: { schoolId, name: 'Professional' } });
    const eng = await prisma.occupation.findFirstOrThrow({ where: { schoolId, name: 'Engineer' } });
    const byCat = (await get(`occupation?${q(`&occupationId=${prof.id}`)}`)).body;
    expect(byCat.map((x: { admissionNo: string; occupation: string; subCategory: string }) => [x.admissionNo, x.occupation, x.subCategory]))
      .toEqual([['A4-001', 'Professional', 'Engineer'], ['A4-002', 'Professional', '']]);
    const bySub = (await get(`occupation?${q(`&subId=${eng.id}`)}`)).body;
    expect(bySub).toHaveLength(1);
    expect(bySub[0]).toMatchObject({ slNo: 1, admissionNo: 'A4-001', designation: 'Lead', mobile: '9000000001' });
  });

  it('subjects: language vs additional, filter by subject, gender shown', async () => {
    const lang = (await get(`subjects?${q()}`)).body;
    expect(lang.map((x: { admissionNo: string; subjects: string; gender: string; className: string }) => [x.admissionNo, x.subjects, x.gender, x.className]))
      .toEqual([['A4-001', 'Hindi', 'M', 'A4-1'], ['A4-003', 'Hindi', 'F', 'A4-1'], ['A4-002', 'French', 'F', 'A4-2']]);
    const hindi = await prisma.subject.findFirstOrThrow({ where: { schoolId, name: 'Hindi' } });
    expect((await get(`subjects?${q(`&subjectId=${hindi.id}&standardId=${std2}`)}`)).body).toEqual([]);
    const add = (await get(`subjects?${q('&kind=ADDITIONAL')}`)).body;
    expect(add).toEqual([{ slNo: 1, admissionNo: 'A4-001', name: 'Aarav', className: 'A4-1', section: 'A', gender: 'M', subjects: 'Music' }]);
    expect((await get(`subjects?${q('&kind=CORE')}`)).status).toBe(400);
  });

  it('fee-head-optin: opted-in students with the head cost for their class; non-optional heads refused', async () => {
    const r = (await get(`fee-head-optin?${q(`&feeHeadId=${headComp}`)}`)).body;
    expect(r).toMatchObject({ feeHead: 'Computer', count: 1, total: '200.00' });
    expect(r.rows).toEqual([{ slNo: 1, admissionNo: 'A4-001', name: 'Aarav', className: 'A4-1', section: 'A', amount: '200.00' }]);
    const tuition = await prisma.feeHead.findFirstOrThrow({ where: { schoolId, name: 'Tuition' } });
    expect((await get(`fee-head-optin?${q(`&feeHeadId=${tuition.id}`)}`)).status).toBe(400);
    const csv = (await get(`fee-head-optin?${q(`&feeHeadId=${headComp}&format=csv`)}`)).text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(csv.at(-1)).toBe(',,TOTAL (1),,,200.00');
  });

  it('classwise: counts, charges, concession and per-head columns (withdrawn counted, charged nothing)', async () => {
    const rows = (await get(`classwise?${q()}`)).body;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      standard: 'A4-1', section: 'A', students: 4, newAdmissions: 0, continuing: 3, withdrawn: 1,
      charges: '8400.00', concession: '200.00', Tuition: '5800.00', Annual: '1800.00', Computer: '200.00', Transport: '600.00',
    });
    expect(rows[1]).toMatchObject({ standard: 'A4-2', section: 'A', students: 1, continuing: 1, charges: '4750.00', concession: '50.00', Tuition: '4000.00', Annual: '750.00' });
    expect(rows[1].Transport).toBeUndefined();
    const csv = (await get(`classwise?${q('&format=csv')}`)).text.replace(/^\uFEFF/, '').split('\r\n');
    expect(csv[0].startsWith('standard,section,students,newAdmissions,continuing,withdrawn,charges,concession,fine,paid,due,')).toBe(true);
    expect((await get(`classwise?${q(`&sectionId=${sec1}`)}`)).body).toHaveLength(1);
  });

  it('studentwise: per-student figures; paid/due reflect receipts', async () => {
    const rows = (await get(`studentwise?${q()}`)).body;
    const by = Object.fromEntries(rows.map((r: { admissionNo: string }) => [r.admissionNo, r]));
    expect(by['A4-001']).toMatchObject({ charges: '3200.00', concession: '200.00', paid: '1000.00', due: '2200.00', Tuition: '1800.00', Transport: '600.00' });
    expect(by['A4-002']).toMatchObject({ charges: '4750.00', paid: '500.00', due: '4250.00' });
    expect(by['A4-003']).toMatchObject({ charges: '2600.00', paid: '1600.00', due: '1000.00' });
    expect(by['A4-005']).toMatchObject({ charges: '0.00', active: 'NO' });
  });

  it('bifurcation: receipts land exactly on heads (fees in id order, transport, deposits last); cancelled and bounced receipts ignored', async () => {
    const rows = (await get(`bifurcation?${q()}`)).body;
    // s1 1000 of [Tuition 900, Annual 600, Computer 100, Transport 300] = Tuition 900 + Annual 100; s3 1600 = Tuition 1000 + Annual 600
    expect(rows).toEqual([
      { className: 'A4-1 A', Annual: '700.00', Tuition: '1900.00', total: '2600.00' },
      // s2 500 of [Tuition 2000, Annual 750] = all Tuition
      { className: 'A4-2 A', Tuition: '500.00', total: '500.00' },
    ]);
    const one = (await get(`bifurcation?${q('&groupBy=student&admissionNo=A4-001')}`)).body;
    expect(one).toEqual([{ admissionNo: 'A4-001', name: 'Aarav', className: 'A4-1 A', Annual: '100.00', Tuition: '900.00', total: '1000.00' }]);
    expect((await get(`bifurcation?${q('&from=2999-01-01')}`)).body).toEqual([]);
    expect((await get(`bifurcation?${q('&groupBy=nope')}`)).status).toBe(400);
  });

  it('transport-bifurcation and routes', async () => {
    expect((await get(`transport-bifurcation?${q()}`)).body).toEqual([{ className: 'A4-1 A', charged: '600.00', paid: '0.00', balance: '600.00' }]);
    const byStudent = (await get(`transport-bifurcation?${q('&groupBy=student')}`)).body;
    expect(byStudent).toEqual([{ admissionNo: 'A4-001', name: 'Aarav', className: 'A4-1 A', charged: '600.00', paid: '0.00', balance: '600.00' }]);
    // one pickup + one drop on a 600/yr slab: 300 + 300
    expect((await get(`routes?${q()}`)).body).toEqual([{ route: 'R1', slab: 'S1', sequence: 1, stop: 'Stop1', pickupTime: '07:30', dropTime: '15:30', pickups: 1, drops: 1, amount: '600.00' }]);
  });

  it('concessions: detail uses the real discount; summary is class x category', async () => {
    const d = (await get(`concessions?${q()}`)).body;
    expect(d.map((x: Record<string, string>) => [x.admissionNo, x.category, x.feeHead, x.percent, x.amountPerInstallment, x.concessionAmount]))
      .toEqual([['A4-001', 'STAFF', 'Tuition', '10.00', '', '200.00'], ['A4-002', 'EDC', 'Annual', '', '50.00', '50.00']]);
    expect((await get(`concessions?${q('&category=EDC')}`)).body).toHaveLength(1);
    const s = (await get(`concessions?${q('&summary=1')}`)).body;
    expect(s).toEqual([
      { className: 'A4-1 A', EDC: '0.00', STAFF: '200.00', total: '200.00' },
      { className: 'A4-2 A', EDC: '50.00', STAFF: '0.00', total: '50.00' },
    ]);
  });

  it('payments-summary: by mode and by head ignore cancelled and bounced receipts', async () => {
    const mode = (await get(`payments-summary?${q()}`)).body;
    expect(mode).toEqual([{ mode: 'CASH', receipts: 2, amount: '2600.00' }, { mode: 'UPI', receipts: 1, amount: '500.00' }]);
    const head = (await get(`payments-summary?${q('&groupBy=head')}`)).body;
    expect(head).toEqual([{ head: 'Annual', amount: '700.00' }, { head: 'Tuition', amount: '2400.00' }]);
    expect(head.reduce((s: number, h: { amount: string }) => s + Math.round(Number(h.amount) * 100), 0)).toBe(310000);
    const csv = (await get(`payments-summary?${q('&groupBy=head&format=csv')}`)).text.replace(/^\uFEFF/, '').split('\r\n');
    expect(csv.slice(0, 2)).toEqual(['head,amount', 'Annual,700.00']);
  });
});
