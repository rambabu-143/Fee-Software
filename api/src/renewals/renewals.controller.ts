import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class CreateDto {
  @IsInt() enrollmentId: number;
  @IsIn(['RENEW', 'WITHDRAW']) type: 'RENEW' | 'WITHDRAW';
}

class ApplyDto {
  @IsInt() schoolId: number;
  @IsInt() fromYearId: number;
  @IsInt() toYearId: number;
}

const STATUSES = ['PENDING', 'APPLIED', 'SKIPPED'];
const include = { enrollment: { include: { student: { select: { id: true, admissionNo: true, name: true } }, section: { include: { standard: true } } } } };

@Roles('ADMIN', 'ACCOUNTANT')
@Controller('transport-renewals')
export class RenewalsController {
  constructor(private prisma: PrismaService) {}

  private flat<T extends { enrollment: { student: object; section: { name: string; standard: { name: string } } } }>(r: T) {
    const { enrollment: e, ...rest } = r;
    return { ...rest, student: e.student, className: `${e.section.standard.name} ${e.section.name}` };
  }

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('status') status?: string,
  ) {
    assertSchool(u, schoolId);
    if (status && !STATUSES.includes(status)) throw new BadRequestException('Bad status');
    const rows = await this.prisma.transportRenewal.findMany({
      where: { enrollment: { yearId, student: { schoolId } }, ...(status ? { status } : {}) }, include, orderBy: { id: 'asc' },
    });
    return rows.map((r) => this.flat(r));
  }

  // The family's decision for next year. One per enrollment.
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateDto) {
    const e = await this.prisma.enrollment.findUniqueOrThrow({ where: { id: dto.enrollmentId }, include: { student: true, transport: true } });
    assertSchool(u, e.student.schoolId);
    if (!e.transport) throw new BadRequestException('Student has no transport assignment this year');
    return this.flat(await this.prisma.transportRenewal.create({
      data: { enrollmentId: e.id, type: dto.type, filledBy: u.username }, include,
    }));
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const r = await this.prisma.transportRenewal.findUniqueOrThrow({ where: { id }, include: { enrollment: { include: { student: true } } } });
    assertSchool(u, r.enrollment.student.schoolId);
    if (r.status === 'APPLIED') throw new BadRequestException('Already applied; it cannot be removed');
    await this.prisma.transportRenewal.delete({ where: { id } });
    return { deleted: id };
  }

  // Year-end: carries each PENDING decision into next year's enrollment. Each row is its own transaction
  // (all-or-nothing per row); only PENDING rows are touched, so running it twice is a no-op.
  @Roles('ADMIN')
  @Post('apply')
  async apply(@CurrentUser() u: AuthUser, @Body() dto: ApplyDto) {
    assertSchool(u, dto.schoolId);
    if (dto.fromYearId === dto.toYearId) throw new BadRequestException('fromYearId and toYearId must differ');
    await Promise.all([dto.fromYearId, dto.toYearId].map((id) => this.prisma.academicYear.findUniqueOrThrow({ where: { id } })));
    const pending = await this.prisma.transportRenewal.findMany({
      where: { status: 'PENDING', enrollment: { yearId: dto.fromYearId, student: { schoolId: dto.schoolId } } },
      include: { enrollment: { include: { transport: true } } },
      orderBy: { id: 'asc' },
    });

    const out: { id: number; status: 'APPLIED' | 'SKIPPED'; note: string | null }[] = [];
    for (const r of pending) {
      const res = await this.prisma.$transaction(async (tx) => {
        const next = await tx.enrollment.findUnique({
          where: { studentId_yearId: { studentId: r.enrollment.studentId, yearId: dto.toYearId } },
          include: { transport: true, withdrawal: true, facilityAssignments: { where: { facility: { kind: 'TRANSPORT' } } } },
        });
        let status: 'APPLIED' | 'SKIPPED' = 'APPLIED';
        let note: string | null = null;
        if (r.type === 'RENEW') {
          const src = r.enrollment.transport;
          if (!next) [status, note] = ['SKIPPED', 'Student not promoted to the next year'];
          else if (next.withdrawal) [status, note] = ['SKIPPED', 'Student is withdrawn next year'];
          else if (next.transport) [status, note] = ['SKIPPED', 'Already has transport next year'];
          else if (next.facilityAssignments.length) [status, note] = ['SKIPPED', 'On a flat-fee route next year'];
          else if (!src) [status, note] = ['SKIPPED', 'No transport assignment to carry over'];
          else await tx.transportAssignment.create({ data: { enrollmentId: next.id, pickupStopId: src.pickupStopId, dropStopId: src.dropStopId } });
        } else if (next?.transport) {
          await tx.transportAssignment.delete({ where: { id: next.transport.id } });
        } else note = next ? 'No transport next year; nothing to stop' : 'No next-year enrollment; nothing to stop';
        if (r.type === 'WITHDRAW') {
          // Transport stopped: the security deposit is not refunded automatically; point staff at the refund.
          const held = await tx.deposit.findFirst({ where: { studentId: r.enrollment.studentId, kind: 'TRANSPORT', status: 'HELD' } });
          if (held) note = `${note ? `${note}. ` : ''}Transport security ₹${held.amount.toFixed(2)} is still held: refund it from Deposits`;
        }
        await tx.transportRenewal.update({ where: { id: r.id }, data: { status, note, appliedAt: new Date() } });
        return { id: r.id, status, note };
      });
      out.push(res);
    }
    return { applied: out.filter((x) => x.status === 'APPLIED').length, skipped: out.filter((x) => x.status === 'SKIPPED').length, rows: out };
  }
}
