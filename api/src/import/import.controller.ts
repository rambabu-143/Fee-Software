import { BadRequestException, Body, Controller, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { normalizeMobile } from '../sms/sms.provider.js';
import { validEmail } from '../email/email.provider.js';

const MAX_ROWS = 2000;

class StudentImportDto {
  @IsInt() schoolId: number;
  @IsInt() yearId: number;
  // Rows are validated one by one below so the caller gets every problem at once, not just the first.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_ROWS) rows: Record<string, unknown>[];
}

type Clean = {
  admissionNo: string; name: string; sectionId: number; rollNo?: number; isNewAdmission?: boolean;
  dob?: Date; fatherName?: string; motherName?: string; phone?: string; email?: string;
  admissionDate?: Date; gender?: 'M' | 'F' | 'OTHER'; religion?: string; category?: string; nationality?: string;
  address?: string; fatherEmail?: string; motherEmail?: string;
};

const GENDER: Record<string, 'M' | 'F' | 'OTHER'> = { m: 'M', male: 'M', boy: 'M', f: 'F', female: 'F', girl: 'F', other: 'OTHER', o: 'OTHER' };
const PLAIN = ['religion', 'category', 'nationality', 'address'] as const;
const EMAILS = ['fatherEmail', 'motherEmail'] as const;

const str = (v: unknown) => (v == null ? '' : String(v).trim());

@Controller('import')
export class ImportController {
  constructor(private prisma: PrismaService) {}

  // Safe by default: nothing is written unless dryRun=false is passed explicitly.
  // The real run is one transaction: any bad row => nothing saved. Re-running the same file is a no-op (upsert).
  @Roles('ADMIN')
  @Post('students')
  async students(@CurrentUser() u: AuthUser, @Query('dryRun') dryRun: string | undefined, @Body() dto: StudentImportDto) {
    assertSchool(u, dto.schoolId);
    const live = dryRun === 'false';
    if (!(await this.prisma.academicYear.findUnique({ where: { id: dto.yearId } }))) throw new BadRequestException('Unknown year');

    const sections = await this.prisma.section.findMany({ where: { standard: { schoolId: dto.schoolId } }, include: { standard: true } });
    const sectionId = new Map(sections.map((s) => [`${s.standard.name}|${s.name}`.toLowerCase(), s.id]));

    const errors: { row: number; msg: string }[] = [];
    const clean: Clean[] = [];
    const seen = new Set<string>();
    dto.rows.forEach((raw, idx) => {
      const row = idx + 1;
      const bad = (msg: string) => errors.push({ row, msg });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('Row is not an object');
      const admissionNo = str(raw.admissionNo), name = str(raw.name);
      if (!admissionNo) bad('admissionNo is required');
      else if (seen.has(admissionNo.toLowerCase())) bad(`Duplicate admissionNo ${admissionNo} in this file`);
      else seen.add(admissionNo.toLowerCase());
      if (!name) bad('name is required');
      const sid = sectionId.get(`${str(raw.standard)}|${str(raw.section)}`.toLowerCase());
      if (!sid) bad(`Unknown class/section "${str(raw.standard)} ${str(raw.section)}"`);

      const out: Clean = { admissionNo, name, sectionId: sid ?? 0 };
      if (str(raw.rollNo)) { const n = Number(raw.rollNo); Number.isInteger(n) && n > 0 ? (out.rollNo = n) : bad('rollNo must be a positive whole number'); }
      for (const k of ['dob', 'admissionDate'] as const) {
        if (!str(raw[k])) continue;
        const d = new Date(str(raw[k]));
        // round-trip check rejects 2026-02-31, which Date would silently roll into March
        /^\d{4}-\d{2}-\d{2}$/.test(str(raw[k])) && !isNaN(+d) && d.toISOString().startsWith(str(raw[k])) ? (out[k] = d) : bad(`${k} must be a valid YYYY-MM-DD date`);
      }
      if (str(raw.gender)) { const g = GENDER[str(raw.gender).toLowerCase()]; g ? (out.gender = g) : bad('gender must be M, F or OTHER'); }
      for (const k of PLAIN) if (str(raw[k])) out[k] = str(raw[k]);
      for (const k of EMAILS) if (str(raw[k])) validEmail(str(raw[k])) ? (out[k] = str(raw[k])) : bad(`Invalid ${k}`);
      if (str(raw.phone)) { const p = normalizeMobile(str(raw.phone)); p ? (out.phone = p) : bad('Invalid phone number'); }
      if (str(raw.email)) validEmail(str(raw.email)) ? (out.email = str(raw.email)) : bad('Invalid email');
      if (str(raw.fatherName)) out.fatherName = str(raw.fatherName);
      if (str(raw.motherName)) out.motherName = str(raw.motherName);
      if (str(raw.isNewAdmission)) {
        const t = str(raw.isNewAdmission).toLowerCase();
        ['true', 'yes', 'y', '1'].includes(t) ? (out.isNewAdmission = true) : ['false', 'no', 'n', '0'].includes(t) ? (out.isNewAdmission = false) : bad('isNewAdmission must be yes/no');
      }
      clean.push(out);
    });

    const existing = errors.length ? 0 : await this.prisma.student.count({ where: { schoolId: dto.schoolId, admissionNo: { in: clean.map((c) => c.admissionNo) } } });
    const plan = { rows: dto.rows.length, willCreate: clean.length - existing, willUpdate: existing };

    if (errors.length) {
      if (live) throw new BadRequestException({ message: 'Import rejected, nothing was saved', ok: false, errors });
      return { ok: false, dryRun: true, errors };
    }
    if (!live) return { ok: true, dryRun: true, errors, ...plan };

    await this.prisma.$transaction(async (tx) => {
      for (const c of clean) {
        const { admissionNo, sectionId: sid, rollNo, isNewAdmission, ...fields } = c;
        const student = await tx.student.upsert({
          where: { schoolId_admissionNo: { schoolId: dto.schoolId, admissionNo } },
          create: { schoolId: dto.schoolId, admissionNo, ...fields },
          update: fields, // only the columns present in the file
        });
        await tx.enrollment.upsert({
          where: { studentId_yearId: { studentId: student.id, yearId: dto.yearId } },
          create: { studentId: student.id, yearId: dto.yearId, sectionId: sid, rollNo, isNewAdmission: isNewAdmission ?? false },
          update: { sectionId: sid, ...(rollNo !== undefined ? { rollNo } : {}), ...(isNewAdmission !== undefined ? { isNewAdmission } : {}) },
        });
      }
    }, { timeout: 120_000 }); // ponytail: one transaction for up to 2000 rows; fine here, batch it if the cap ever grows
    return { ok: true, dryRun: false, errors, ...plan };
  }
}
