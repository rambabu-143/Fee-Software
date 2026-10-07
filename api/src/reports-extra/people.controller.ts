import { BadRequestException, Controller, Get, ParseIntPipe, Query, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import { BOM, respond, toCsv } from './csv.js';
import { classOf, rollWhere } from './shared.js';

const opt = new ParseIntPipe({ optional: true });
const join = (xs: (string | null | undefined)[]) => xs.filter(Boolean).join(', ');
const digits = (s: string) => s.replace(/\D/g, '').slice(-10);

// Reports over students/parents. Contains personal data, so ADMIN/ACCOUNTANT only.
@Roles('ADMIN', 'ACCOUNTANT')
@Controller('reports')
export class PeopleReportsController {
  constructor(private prisma: PrismaService) {}

  // Families (shared Student.familyId) with 2+ children on the roll; the highest-class child is the anchor.
  @Get('siblings')
  async siblings(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { ...rollWhere(schoolId, yearId), student: { schoolId, active: true, familyId: { not: null } } },
      include: { student: true, section: { include: { standard: true } } },
    });
    const families = new Map<number, typeof enrollments>();
    for (const e of enrollments) families.set(e.student.familyId!, [...(families.get(e.student.familyId!) ?? []), e]);
    const who = (e: (typeof enrollments)[number]) => ({ admissionNo: e.student.admissionNo, name: e.student.name, className: classOf(e) });
    const out = [...families.entries()]
      .filter(([, m]) => m.length > 1)
      .map(([familyId, m]) => {
        const sorted = [...m].sort((a, b) => b.section.standard.sortOrder - a.section.standard.sortOrder || a.student.admissionNo.localeCompare(b.student.admissionNo));
        return { familyId, anchor: sorted[0], siblings: sorted.slice(1) };
      })
      .filter((f) => (!standardId || f.anchor.section.standardId === standardId) && (!sectionId || f.anchor.sectionId === sectionId))
      .sort((a, b) => a.familyId - b.familyId)
      .map((f) => ({ familyId: f.familyId, anchor: who(f.anchor), siblings: f.siblings.map(who) }));
    if (format !== 'csv') return out;
    return respond(
      out.flatMap((f) => f.siblings.map((s) => ({
        familyId: f.familyId, anchorAdmissionNo: f.anchor.admissionNo, anchorName: f.anchor.name, anchorClass: f.anchor.className,
        siblingAdmissionNo: s.admissionNo, siblingName: s.name, siblingClass: s.className,
      }))),
      'csv', 'siblings',
    );
  }

  // Unlinked likely siblings: two students sharing 2+ parent contacts (mobile/email) or 2+ parent names.
  @Roles('ADMIN')
  @Get('siblings/suggestions')
  async suggestions(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: rollWhere(schoolId, yearId),
      include: { student: { include: { guardians: true } }, section: { include: { standard: true } } },
    });
    const byKey = new Map<string, Set<number>>();
    const info = new Map(enrollments.map((e) => [e.studentId, e]));
    for (const e of enrollments) {
      for (const g of e.student.guardians) {
        const keys = [
          g.mobile && digits(g.mobile).length >= 10 ? `c:${digits(g.mobile)}` : '',
          g.email ? `c:${g.email.trim().toLowerCase()}` : '',
          g.name.trim() ? `n:${g.name.trim().toLowerCase().replace(/\s+/g, ' ')}` : '',
        ].filter(Boolean);
        for (const k of keys) byKey.set(k, (byKey.get(k) ?? new Set()).add(e.studentId));
      }
    }
    // ponytail: a key shared by more than 8 students is a placeholder (e.g. 9999999999), not a family.
    const pairs = new Map<string, { a: number; b: number; contacts: number; names: number }>();
    for (const [k, ids] of byKey) {
      if (ids.size < 2 || ids.size > 8) continue;
      const list = [...ids].sort((x, y) => x - y);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const p = pairs.get(`${list[i]}-${list[j]}`) ?? { a: list[i], b: list[j], contacts: 0, names: 0 };
          if (k.startsWith('c:')) p.contacts++;
          else p.names++;
          pairs.set(`${list[i]}-${list[j]}`, p);
        }
      }
    }
    const who = (id: number, p: string) => {
      const e = info.get(id)!;
      return { [`${p}AdmissionNo`]: e.student.admissionNo, [`${p}Name`]: e.student.name, [`${p}Class`]: classOf(e) };
    };
    const rows = [...pairs.values()]
      .filter((p) => p.contacts >= 2 || p.names >= 2)
      .filter((p) => {
        const fa = info.get(p.a)!.student.familyId, fb = info.get(p.b)!.student.familyId;
        return fa === null || fa !== fb;
      })
      .map((p) => ({ ...who(p.a, 'a'), ...who(p.b, 'b'), sharedContacts: p.contacts, sharedNames: p.names }));
    return respond(rows, format, 'sibling-suggestions');
  }

  // Students whose parent works at the school, with the concession they get.
  @Get('staff-wards')
  async staffWards(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const guardians = await this.prisma.guardian.findMany({
      where: { isStaff: true, student: { schoolId, active: true, enrollments: { some: rollWhere(schoolId, yearId) } } },
      include: {
        student: { include: { enrollments: { where: { yearId }, include: { section: { include: { standard: true } }, concessions: true } } } },
      },
      orderBy: [{ student: { admissionNo: 'asc' } }, { id: 'asc' }],
    });
    const rows = guardians.map((g, i) => {
      const e = g.student.enrollments[0];
      return {
        sNo: i + 1, admissionNo: g.student.admissionNo, student: g.student.name, className: classOf(e),
        staffName: g.name, relation: g.relation, branch: g.staffBranch ?? '',
        category: join([...new Set(e.concessions.map((c) => c.category))]), concession: join(e.concessions.map((c) => c.reason)),
      };
    });
    return respond(rows, format, 'staff-wards');
  }

  // Students of one religion (default CHRISTIAN) and whether they pay full fees (no concession at all).
  @Get('minority')
  async minority(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('religion') religion = 'CHRISTIAN',
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { ...rollWhere(schoolId, yearId), student: { schoolId, active: true, religion: { equals: religion, mode: 'insensitive' } } },
      include: { student: true, section: { include: { standard: true } }, concessions: true },
      orderBy: { student: { admissionNo: 'asc' } },
    });
    const rows = enrollments.map((e) => ({
      name: e.student.name, admissionNo: e.student.admissionNo, className: classOf(e),
      concessionName: join(e.concessions.map((c) => c.category ?? c.reason)), fullPaying: e.concessions.length ? 'NO' : 'YES',
    }));
    return respond(rows, format, 'minority');
  }

  @Get('non-indian')
  async nonIndian(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { ...rollWhere(schoolId, yearId), student: { schoolId, active: true, nationality: { not: null } } },
      include: { student: true, section: { include: { standard: true } } },
      orderBy: { student: { admissionNo: 'asc' } },
    });
    const rows = enrollments
      .filter((e) => e.student.nationality!.trim().toUpperCase() !== 'INDIAN')
      .map((e) => ({ admissionNo: e.student.admissionNo, name: e.student.name, className: classOf(e), nationality: e.student.nationality }));
    return respond(rows, format, 'non-indian');
  }

  // Parents by occupation. occupationId = a category (matches its sub-categories too); subId = one sub-category.
  @Get('occupation')
  async occupation(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('occupationId', opt) occupationId?: number,
    @Query('subId', opt) subId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const guardians = await this.prisma.guardian.findMany({
      where: { student: { schoolId, active: true, enrollments: { some: rollWhere(schoolId, yearId) } } },
      include: {
        occupation: { include: { parent: true } },
        student: { include: { enrollments: { where: { yearId }, include: { section: { include: { standard: true } } } } } },
      },
      orderBy: [{ student: { admissionNo: 'asc' } }, { id: 'asc' }],
    });
    const rows = guardians
      .filter((g) => !occupationId || g.occupation?.id === occupationId || g.occupation?.parentId === occupationId)
      .filter((g) => !subId || g.occupationId === subId)
      .map((g, i) => ({
        slNo: i + 1, admissionNo: g.student.admissionNo, student: g.student.name, className: classOf(g.student.enrollments[0]),
        relation: g.relation, guardian: g.name, designation: g.designation ?? '', mobile: g.mobile ?? '',
        organization: g.organization ?? '', officeAddress: g.officeAddress ?? '', officePhone: g.officePhone ?? '',
        occupation: g.occupation ? (g.occupation.parent?.name ?? g.occupation.name) : '', subCategory: g.occupation?.parent ? g.occupation.name : '',
      }));
    return respond(rows, format, 'occupation');
  }

  // Language (or additional) subject lists: one row per student with their subjects of that kind.
  @Get('subjects')
  async subjects(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('kind') kind = 'LANGUAGE',
    @Query('subjectId', opt) subjectId?: number,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    if (kind !== 'LANGUAGE' && kind !== 'ADDITIONAL') throw new BadRequestException('kind must be LANGUAGE or ADDITIONAL');
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        ...rollWhere(schoolId, yearId, standardId, sectionId),
        subjects: { some: { subject: { kind, schoolId }, ...(subjectId ? { subjectId } : {}) } },
      },
      include: { student: true, section: { include: { standard: true } }, subjects: { include: { subject: true } } },
      orderBy: [{ section: { standard: { sortOrder: 'asc' } } }, { section: { name: 'asc' } }, { student: { admissionNo: 'asc' } }],
    });
    const rows = enrollments.map((e, i) => ({
      slNo: i + 1, admissionNo: e.student.admissionNo, name: e.student.name, className: e.section.standard.name,
      section: e.section.name, gender: e.student.gender ?? '', subjects: join(e.subjects.filter((s) => s.subject.kind === kind).map((s) => s.subject.name)),
    }));
    return respond(rows, format, `subjects-${kind.toLowerCase()}`);
  }

  // Students who opted into an OPTIONAL fee head and what it costs them for the year.
  @Get('fee-head-optin')
  async feeHeadOptin(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('feeHeadId', ParseIntPipe) feeHeadId: number,
    @Query('standardId', opt) standardId?: number,
    @Query('sectionId', opt) sectionId?: number,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const head = await this.prisma.feeHead.findFirst({ where: { id: feeHeadId, schoolId, type: 'OPTIONAL' } });
    if (!head) throw new BadRequestException('Not an optional fee head of this school');
    const [enrollments, structure] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { ...rollWhere(schoolId, yearId, standardId, sectionId), optionalHeads: { some: { id: feeHeadId } } },
        include: { student: true, section: { include: { standard: true } } },
        orderBy: { student: { admissionNo: 'asc' } },
      }),
      this.prisma.feeStructure.groupBy({ by: ['standardId'], where: { yearId, feeHeadId }, _sum: { amount: true } }),
    ]);
    const cost = new Map(structure.map((s) => [s.standardId, toPaise(s._sum.amount?.toFixed(2) ?? '0')]));
    const rows = enrollments.map((e, i) => ({
      slNo: i + 1, admissionNo: e.student.admissionNo, name: e.student.name, className: e.section.standard.name,
      section: e.section.name, amount: fromPaise(cost.get(e.section.standardId) ?? 0),
    }));
    const total = fromPaise(enrollments.reduce((s, e) => s + (cost.get(e.section.standardId) ?? 0), 0));
    if (format === 'csv') {
      const csv = toCsv([...rows, { slNo: '', admissionNo: '', name: `TOTAL (${rows.length})`, className: '', section: '', amount: total }]);
      return new StreamableFile(Buffer.from(BOM + csv), { type: 'text/csv; charset=utf-8', disposition: 'attachment; filename="fee-head-optin.csv"' });
    }
    return { feeHead: head.name, count: rows.length, total, rows };
  }
}
