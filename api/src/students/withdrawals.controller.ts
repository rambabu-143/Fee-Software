import {
  BadRequestException, Body, Controller, Delete, Get, Header, Param, ParseIntPipe, Post, Query, StreamableFile,
} from '@nestjs/common';
import { IsDateString, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { fromPaise } from '../billing/bill.js';
import { withdrawalPdf } from '../billing/pdf.js';

class WithdrawDto {
  @IsInt() yearId: number;
  @IsDateString() date: string;
  @IsString() @MinLength(2) reason: string;
  @IsOptional() @IsString() remarks?: string;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));
const present = (w: { balanceDue: unknown; excessPaid: unknown } & Record<string, unknown>) => ({
  ...w, balanceDue: (w.balanceDue as { toFixed(n: number): string }).toFixed(2), excessPaid: (w.excessPaid as { toFixed(n: number): string }).toFixed(2),
});

@Controller()
export class WithdrawalsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  private async enrollment(u: AuthUser, studentId: number, yearId: number) {
    const e = await this.prisma.enrollment.findUniqueOrThrow({
      where: { studentId_yearId: { studentId, yearId } },
      include: { student: true, withdrawal: true },
    });
    assertSchool(u, e.student.schoolId);
    return e;
  }

  // Withdrawal register for a year.
  @Get('withdrawals')
  async list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('yearId', ParseIntPipe) yearId: number) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.withdrawal.findMany({
      where: { enrollment: { yearId, student: { schoolId } } },
      include: { enrollment: { include: { student: { select: { id: true, admissionNo: true, name: true } }, section: { include: { standard: true } } } } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
    });
    return rows.map(({ enrollment: e, ...w }) => ({
      ...present(w), student: e.student, className: `${e.section.standard.name} ${e.section.name}`,
    }));
  }

  // Records the withdrawal, deactivates the student and snapshots the settlement figures.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('students/:id/withdrawal')
  async withdraw(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: WithdrawDto) {
    const date = new Date(dto.date);
    if (date > today()) throw new BadRequestException('Withdrawal date cannot be in the future');
    const e = await this.enrollment(u, id, dto.yearId);
    if (e.withdrawal) throw new BadRequestException('Student is already withdrawn for this year');
    if (!e.student.active) throw new BadRequestException('Student is inactive');

    const w = await this.prisma.$transaction(async (tx) => {
      const created = await tx.withdrawal.create({
        data: { enrollmentId: e.id, date, reason: dto.reason, remarks: dto.remarks, balanceDue: 0, excessPaid: 0, createdBy: u.username },
      });
      await tx.student.update({ where: { id }, data: { active: false } });
      const bill = await this.billing.build(id, dto.yearId, today(), tx);
      return tx.withdrawal.update({
        where: { id: created.id },
        data: {
          balanceDue: fromPaise(bill.totals.due),
          excessPaid: fromPaise(bill.installments.reduce((s, i) => s + i.excess, 0) + bill.arrear.excess),
        },
      });
    });
    return present(w);
  }

  // Re-admit: undo the withdrawal; the cut-off on charges disappears with it.
  @Roles('ADMIN')
  @Delete('students/:id/withdrawal')
  async readmit(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number) {
    const e = await this.enrollment(u, id, yearId);
    if (!e.withdrawal) throw new BadRequestException('Student is not withdrawn for this year');
    await this.prisma.$transaction([
      this.prisma.withdrawal.delete({ where: { id: e.withdrawal.id } }),
      this.prisma.student.update({ where: { id }, data: { active: true } }),
    ]);
    return { readmitted: true };
  }

  @Get('students/:id/withdrawal/pdf')
  @Header('Content-Type', 'application/pdf')
  async slip(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number) {
    const e = await this.enrollment(u, id, yearId);
    if (!e.withdrawal) throw new BadRequestException('Student is not withdrawn for this year');
    const [bill, school, year] = await Promise.all([
      this.billing.build(id, yearId, today()),
      this.prisma.school.findUniqueOrThrow({ where: { id: e.student.schoolId } }),
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: yearId } }),
    ]);
    const b = BillingService.present(bill);
    const buf = await withdrawalPdf(school.name, {
      ...b, year: year.label, date: e.withdrawal.date, reason: e.withdrawal.reason, remarks: e.withdrawal.remarks,
      excess: fromPaise(bill.installments.reduce((s, i) => s + i.excess, 0) + bill.arrear.excess), recordedBy: e.withdrawal.createdBy,
    });
    return new StreamableFile(buf, { disposition: `inline; filename="withdrawal-${bill.student.admissionNo}.pdf"` });
  }
}
