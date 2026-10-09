import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseDatePipe, ParseIntPipe, Post, Query, Res, StreamableFile,
} from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import type { Response } from 'express';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import {
  admissionCertPdf, admissionFormPdf, concessionFormPdf, feeCertPdf, nextClassName, tcPdf, zip, type SchoolHead, type StudentForm,
} from './pdfs.js';

const MAX_FORMS = 60; // ponytail: synchronous zip; add a job queue if sections ever exceed this

class TcDto {
  @IsInt() studentId: number;
  @IsInt() yearId: number;
  @IsDateString() dateOfIssue: string;
  @IsString() @MinLength(2) leavingReason: string;
  @IsOptional() @IsDateString() dateOfWithdrawal?: string;
  @IsOptional() @IsString() class?: string;
  @IsOptional() @IsString() board?: string;
  @IsOptional() @IsString() higherClass?: string;
  @IsOptional() @IsString() combo?: string;
  @IsOptional() @IsString() monthDuePaid?: string;
  @IsOptional() @IsInt() totalWorkDays?: number;
  @IsOptional() @IsInt() totalWorkPresent?: number;
  @IsOptional() @IsString() generalConduct?: string;
  @IsOptional() @IsString() nationality?: string;
  @IsOptional() @IsString() staffName?: string;
  // Issue even though fees are pending.
  @IsOptional() @IsBoolean() overrideDues?: boolean;
}

class SendAdmissionCertDto {
  @IsInt() yearId: number;
  @IsOptional() @IsIn(['father', 'mother', 'both']) to?: 'father' | 'mother' | 'both';
}

const validEmail = (e?: string | null): e is string => !!e && !/^n\/?a$/i.test(e.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const isStaff = (c: { category: string | null; reason: string }) => /staff/i.test(c.category ?? '') || /staff/i.test(c.reason);
// "2026-27" -> next session "2027-28"
const nextSession = (start: Date) => `${start.getUTCFullYear() + 1}-${String((start.getUTCFullYear() + 2) % 100).padStart(2, '0')}`;

@Controller()
export class DocumentsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  private file(res: Response, buf: Buffer, name: string, type = 'application/pdf') {
    res.setHeader('Content-Type', type);
    return new StreamableFile(buf, { disposition: `inline; filename="${name}"` });
  }

  private async enrolled(u: AuthUser, studentId: number, yearId: number) {
    const e = await this.prisma.enrollment.findUnique({
      where: { studentId_yearId: { studentId, yearId } },
      include: {
        student: true, year: true, withdrawal: true,
        section: { include: { standard: { include: { school: true } } } },
        concessions: { include: { feeHead: true } },
      },
    });
    if (!e) throw new NotFoundException('Student is not enrolled in this year');
    assertSchool(u, e.student.schoolId);
    return e;
  }

  private head = (s: { name: string; address: string | null; affiliationNo: string | null; schoolNo: string | null; kind: 'SENIOR' | 'JUNIOR' }): SchoolHead => s;

  private form(e: Awaited<ReturnType<DocumentsController['enrolled']>>): StudentForm {
    return {
      school: this.head(e.section.standard.school), year: e.year.label, className: `${e.section.standard.name} ${e.section.name}`,
      s: { ...e.student },
    };
  }

  // ---- TC ---------------------------------------------------------------

  @Roles('ADMIN')
  @Post('documents/tc')
  async issueTc(@CurrentUser() u: AuthUser, @Body() dto: TcDto, @Res({ passthrough: true }) res: Response) {
    const e = await this.enrolled(u, dto.studentId, dto.yearId);
    const school = e.section.standard.school;
    if (!dto.overrideDues) {
      const bill = await this.billing.build(dto.studentId, dto.yearId, new Date());
      if (bill.totals.due > 0) throw new BadRequestException(`Fees pending (Rs. ${fromPaise(bill.totals.due)}); clear them or set overrideDues`);
    }
    const { studentId: _s, yearId: _y, overrideDues: _o, ...typed } = dto;
    const st = e.student;
    // Snapshot the student so a reprint never changes if the record is edited later.
    const payload = {
      ...typed,
      class: dto.class ?? e.section.standard.name,
      dateOfWithdrawal: dto.dateOfWithdrawal ?? e.withdrawal?.date.toISOString().slice(0, 10) ?? null,
      nationality: dto.nationality ?? st.nationality,
      admissionNo: st.admissionNo, name: st.name, fatherName: st.fatherName, motherName: st.motherName,
      dob: st.dob?.toISOString() ?? null, admissionDate: st.admissionDate?.toISOString() ?? null, penNo: st.penNo, cbseRegNo: st.cbseRegNo,
      issuedWithDuesOverride: !!dto.overrideDues,
    };
    const doc = await this.prisma.$transaction(async (tx) => {
      // Serialise per school so two clerks never get the same serial.
      await tx.$queryRaw`SELECT id FROM "School" WHERE id = ${school.id} FOR UPDATE`;
      const max = await tx.issuedDocument.aggregate({ where: { schoolId: school.id, type: 'TC', yearId: dto.yearId }, _max: { serialNo: true } });
      const prior = await tx.issuedDocument.updateMany({
        where: { studentId: st.id, type: 'TC', supersededAt: null }, data: { supersededAt: new Date() },
      });
      return tx.issuedDocument.create({
        data: {
          schoolId: school.id, studentId: st.id, yearId: dto.yearId, type: 'TC', serialNo: (max._max.serialNo ?? 0) + 1,
          issuedOn: new Date(dto.dateOfIssue), issuedBy: u.username,
          payload: { ...payload, duplicate: prior.count > 0 } as Prisma.InputJsonValue,
        },
      });
    });
    res.setHeader('X-Document-Id', String(doc.id));
    res.setHeader('X-Serial-No', String(doc.serialNo));
    const buf = await tcPdf({ school: this.head(school), serialNo: doc.serialNo, duplicate: prior(doc.payload), year: e.year.label, p: doc.payload as Record<string, string> });
    return this.file(res, buf, `tc-${doc.serialNo}.pdf`);
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('documents/tc/:id/pdf')
  async tcReprint(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response) {
    const d = await this.prisma.issuedDocument.findUniqueOrThrow({ where: { id }, include: { school: true, year: true } });
    assertSchool(u, d.schoolId);
    if (d.type !== 'TC') throw new BadRequestException('Not a transfer certificate');
    const buf = await tcPdf({ school: this.head(d.school), serialNo: d.serialNo, duplicate: prior(d.payload), year: d.year.label, p: d.payload as Record<string, string> });
    return this.file(res, buf, `tc-${d.serialNo}.pdf`);
  }

  @Get('students/:id/documents')
  async list(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const s = await this.prisma.student.findUniqueOrThrow({ where: { id } });
    assertSchool(u, s.schoolId);
    return this.prisma.issuedDocument.findMany({
      where: { studentId: id }, orderBy: { id: 'desc' },
      select: { id: true, type: true, serialNo: true, yearId: true, issuedOn: true, issuedBy: true, supersededAt: true },
    });
  }

  // ---- Fee-paid certificate (income tax) ----------------------------------

  // Built from the student's non-cancelled receipts, so the lines always add up to the total. Refundable deposits
  // (caution / advance) are not fees: each receipt's deposit portion comes from its exact per-head split and is
  // deducted, so `eligibleTotal` = total - refundableTotal. Receipts from before per-head allocation (not yet
  // backfilled) show 0 refundable.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('students/:id/fee-certificate')
  async feeCert(
    @CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number,
    @Query('json') json: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const e = await this.enrolled(u, id, yearId);
    const pays = await this.prisma.payment.findMany({
      where: { studentId: id, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' } },
      orderBy: [{ date: 'asc' }, { receiptNo: 'asc' }],
      include: { allocations: { include: { installment: { select: { label: true, number: true } }, heads: { select: { refundable: true, amount: true } } } } },
    });
    let total = 0, refundableTotal = 0;
    const lines = pays.map((p) => {
      total += toPaise(p.amount.toFixed(2));
      const refundable = p.allocations.reduce((n, a) => n + a.heads.filter((h) => h.refundable).reduce((m, h) => m + toPaise(h.amount.toFixed(2)), 0), 0);
      refundableTotal += refundable;
      return {
        refundable,
        date: p.date.toISOString().slice(0, 10), receiptNo: p.receiptNo, mode: p.mode,
        installments: p.allocations.filter((a) => a.installment).sort((a, b) => a.installment!.number - b.installment!.number).map((a) => a.installment!.label).join(', ') || '-',
        charges: p.allocations.reduce((s, a) => s + toPaise(a.charges.toFixed(2)) + toPaise(a.arrear.toFixed(2)) + toPaise(a.bounce.toFixed(2)), 0),
        fine: p.allocations.reduce((s, a) => s + toPaise(a.fine.toFixed(2)), 0), amount: toPaise(p.amount.toFixed(2)),
      };
    });
    const data = {
      school: this.head(e.section.standard.school), year: e.year.label,
      student: { admissionNo: e.student.admissionNo, name: e.student.name, fatherName: e.student.fatherName, motherName: e.student.motherName, className: `${e.section.standard.name} ${e.section.name}` },
      lines: lines.map((l) => ({ ...l, charges: fromPaise(l.charges), fine: fromPaise(l.fine), refundable: fromPaise(l.refundable), amount: fromPaise(l.amount) })),
      total: fromPaise(total), refundableTotal: fromPaise(refundableTotal), eligibleTotal: fromPaise(total - refundableTotal),
    };
    if (json) return data;
    return this.file(res, await feeCertPdf(data), `fee-certificate-${e.student.admissionNo}.pdf`);
  }

  // ---- Admission certificate + stub email --------------------------------

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('students/:id/admission-certificate.pdf')
  async admissionCert(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number, @Res({ passthrough: true }) res: Response) {
    const e = await this.enrolled(u, id, yearId);
    return this.file(res, await admissionCertPdf(this.form(e)), `admission-certificate-${e.student.admissionNo}.pdf`);
  }

  // ponytail: no SMTP wired. Valid addresses get an EmailLog row (QUEUED, nothing is sent);
  // swap the stub for nodemailer when SMTP_* credentials exist.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('students/:id/admission-certificate/send')
  async sendAdmissionCert(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SendAdmissionCertDto) {
    const e = await this.enrolled(u, id, dto.yearId);
    const to = dto.to ?? 'both';
    const wanted = [to !== 'mother' && e.student.fatherEmail, to !== 'father' && e.student.motherEmail];
    const valid = [...new Set(wanted.filter((x): x is string => typeof x === 'string' && validEmail(x)).map((x) => x.trim()))];
    const subject = `Admission Certificate - ${e.student.name}`;
    await this.prisma.emailLog.createMany({
      data: valid.map((address) => ({
        schoolId: e.student.schoolId, enrollmentId: e.id, address, subject, status: 'QUEUED' as const,
        providerResponse: 'stub: SMTP not configured, nothing was sent',
      })),
    });
    return { logged: valid, skipped: 2 - valid.length, delivered: false };
  }

  // ---- Bulk forms ---------------------------------------------------------

  // withConcession: only students holding a concession, so the cap counts forms, not the whole class.
  private async sectionRoster(u: AuthUser, sectionId: number, yearId: number, studentIds?: string, withConcession = false) {
    const sec = await this.prisma.section.findUnique({ where: { id: sectionId }, include: { standard: { include: { school: true } } } });
    if (!sec) throw new NotFoundException('Section not found');
    assertSchool(u, sec.standard.schoolId);
    const ids = studentIds ? studentIds.split(',').map(Number) : undefined;
    if (ids?.some((n) => !Number.isInteger(n))) throw new BadRequestException('studentIds must be comma-separated integers');
    const enrollments = await this.prisma.enrollment.findMany({
      where: { sectionId, yearId, student: { active: true, ...(ids ? { id: { in: ids } } : {}) }, ...(withConcession ? { concessions: { some: {} } } : {}) },
      include: { student: true, year: true, concessions: { include: { feeHead: true } } },
      orderBy: { student: { admissionNo: 'asc' } },
      take: MAX_FORMS + 1,
    });
    if (enrollments.length > MAX_FORMS) throw new BadRequestException(`At most ${MAX_FORMS} forms per download; pass studentIds to narrow it`);
    return { sec, enrollments };
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('sections/:id/admission-forms.zip')
  async admissionForms(
    @CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number,
    @Query('studentIds') studentIds: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { sec, enrollments } = await this.sectionRoster(u, id, yearId, studentIds);
    if (!enrollments.length) throw new BadRequestException('No students in this section for the year');
    // Any form failing fails the whole zip, so a half-empty class never looks complete.
    const files = await Promise.all(enrollments.map(async (e) => ({
      name: `${e.student.admissionNo}.pdf`,
      buf: await admissionFormPdf({ school: this.head(sec.standard.school), year: e.year.label, className: `${sec.standard.name} ${sec.name}`, s: e.student }),
    })));
    return this.file(res, await zip(files), `admission-forms-${sec.standard.name}-${sec.name}.zip`, 'application/zip');
  }

  private concessionPdf(
    e: Awaited<ReturnType<DocumentsController['sectionRoster']>>['enrollments'][number],
    sec: Awaited<ReturnType<DocumentsController['sectionRoster']>>['sec'], lastDate: Date,
    standards: { name: string; sortOrder: number }[],
  ) {
    return concessionFormPdf({
      nextClass: nextClassName(standards, sec.standard.name),
      school: this.head(sec.standard.school), year: e.year.label, className: `${sec.standard.name} ${sec.name}`, s: e.student,
      nextSession: nextSession(e.year.startDate), officeSession: e.year.label, classTeacher: sec.classTeacher,
      lastDate: lastDate.toISOString().slice(0, 10),
      concessions: e.concessions.map((c) => ({
        head: c.feeHead.name, category: c.category, text: c.percent ? `${c.percent.toString()}%` : `Rs. ${c.amount?.toString() ?? '0'}`,
      })),
    });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('sections/:id/concession-forms.zip')
  async concessionForms(
    @CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number,
    @Query('lastDate', new ParseDatePipe()) lastDate: Date, @Query('studentIds') studentIds: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sec, enrollments } = await this.sectionRoster(u, id, yearId, studentIds, true);
    const standards = await this.prisma.standard.findMany({ where: { schoolId: sec.standard.schoolId }, select: { name: true, sortOrder: true } });
    const eligible = enrollments.filter((e) => e.concessions.length && !e.concessions.some(isStaff));
    if (!eligible.length) throw new BadRequestException('No students with a (non-staff) concession in this section');
    const files: { name: string; buf: Buffer | string }[] = await Promise.all(eligible.map(async (e) => ({
      name: `${e.student.admissionNo}.pdf`, buf: await this.concessionPdf(e, sec, lastDate, standards),
    })));
    const skipped = enrollments.filter((e) => !eligible.includes(e)).map((e) => `${e.student.admissionNo} ${e.student.name}: staff concession`);
    const none = await this.prisma.enrollment.count({ where: { sectionId: id, yearId, student: { active: true }, concessions: { none: {} } } });
    if (none) skipped.push(`${none} other students have no concession`);
    if (skipped.length) files.push({ name: '_skipped.txt', buf: skipped.join('\n') });
    return this.file(res, await zip(files), `concession-forms-${sec.standard.name}-${sec.name}.zip`, 'application/zip');
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('students/:id/concession-form')
  async concessionForm(
    @CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number,
    @Query('lastDate', new ParseDatePipe()) lastDate: Date, @Res({ passthrough: true }) res: Response,
  ) {
    const e = await this.enrolled(u, id, yearId);
    if (!e.concessions.length) throw new BadRequestException('Student has no concession');
    if (e.concessions.some(isStaff)) throw new BadRequestException('Staff concessions are not re-applied through this form');
    const standards = await this.prisma.standard.findMany({ where: { schoolId: e.section.standard.schoolId }, select: { name: true, sortOrder: true } });
    return this.file(res, await this.concessionPdf(e, e.section, lastDate, standards), `concession-form-${e.student.admissionNo}.pdf`);
  }
}

function prior(payload: unknown) {
  return !!(payload as { duplicate?: boolean }).duplicate;
}
