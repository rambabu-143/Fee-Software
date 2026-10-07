import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import { overduePaise } from '../notify/notify.js';

export const SCOPES = ['FEE', 'TRANSPORT', 'HOSTEL'] as const;
export type Scope = (typeof SCOPES)[number];

export type Filter = { schoolId: number; yearId: number; asOf?: Date; standardId?: number; sectionId?: number; minDue?: number; scope?: Scope; studentIds?: number[] };

@Injectable()
export class DefaultersService {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  // Active students owing something on installments already due as of `asOf`.
  // scope picks the population (FEE = everyone, TRANSPORT / HOSTEL = students using that facility);
  // the amount is always their total overdue, as v2 folds facilities into the installments.
  async find(f: Filter) {
    const at = f.asOf ?? new Date();
    const min = toPaise(String(f.minDue ?? 0.01));
    let inScope: Set<number> | null = null;
    if (f.scope && f.scope !== 'FEE') {
      const kind = f.scope;
      const rows = await this.prisma.enrollment.findMany({
        where: {
          yearId: f.yearId, student: { schoolId: f.schoolId },
          OR: kind === 'TRANSPORT'
            ? [{ transport: { isNot: null } }, { facilityAssignments: { some: { facility: { kind: 'TRANSPORT' } } } }]
            : [{ facilityAssignments: { some: { facility: { kind: 'HOSTEL' } } } }],
        },
        select: { id: true },
      });
      inScope = new Set(rows.map((r) => r.id));
    }
    // ponytail: whole-school bills in memory, like /reports/dues.
    const bills = await this.billing.buildMany(f.yearId, at, { schoolId: f.schoolId, standardId: f.standardId, sectionId: f.sectionId });
    const wanted = f.studentIds && new Set(f.studentIds);
    return bills
      .filter((b) => b.student.active && (!wanted || wanted.has(b.student.id)) && (!inScope || inScope.has(b.student.enrollmentId)))
      .map((b) => ({ b, overdue: overduePaise(b, at) }))
      .filter((x) => x.overdue > 0 && x.overdue >= min)
      .map(({ b, overdue }) => ({
        studentId: b.student.id, enrollmentId: b.student.enrollmentId, admissionNo: b.student.admissionNo, name: b.student.name,
        className: b.student.className, sortOrder: b.student.sortOrder,
        overdue: fromPaise(overdue), totalDue: fromPaise(b.totals.due),
        overduePaise: overdue,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.className.localeCompare(b.className) || a.admissionNo.localeCompare(b.admissionNo));
  }

  contacts(studentIds: number[]) {
    return this.prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fatherName: true, motherName: true, phone: true, email: true, fatherEmail: true, motherEmail: true, address: true },
    });
  }

  static parseScope(s?: string): Scope {
    if (!s) return 'FEE';
    if (!(SCOPES as readonly string[]).includes(s)) throw new BadRequestException(`scope must be one of ${SCOPES.join(', ')}`);
    return s as Scope;
  }
}
