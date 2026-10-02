import { BadRequestException, Body, Controller, Post, Query, Get, ParseIntPipe } from '@nestjs/common';
import { IsArray, IsInt, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class UndoDto {
  @IsInt() yearId: number;
  @IsInt() sectionId: number;
  @IsArray() @IsInt({ each: true }) studentIds: number[];
}

class PromoteDto {
  @IsInt() fromYearId: number;
  @IsInt() toYearId: number;
  @IsInt() fromSectionId: number;
  @IsInt() toSectionId: number;
  // Students to hold back instead of promoting (e.g. failed the year).
  @IsOptional() @IsArray() @IsInt({ each: true }) excludeStudentIds?: number[];
}

// Bulk year-end promotion: move every active student of one section into
// another section for the next year, in one action instead of per-student edits.
@Controller('promotions')
export class PromotionsController {
  constructor(private prisma: PrismaService) {}

  private async section(schoolId: number, id: number) {
    const sec = await this.prisma.section.findUnique({ where: { id }, include: { standard: true } });
    if (sec?.standard.schoolId !== schoolId) throw new BadRequestException('Section does not belong to this school');
    return sec;
  }

  // Students currently in fromSectionId/fromYearId, for the UI to list and let the admin uncheck holdbacks.
  @Get('candidates')
  async candidates(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('fromYearId', ParseIntPipe) fromYearId: number,
    @Query('fromSectionId', ParseIntPipe) fromSectionId: number,
  ) {
    assertSchool(u, schoolId);
    await this.section(schoolId, fromSectionId);
    return this.prisma.student.findMany({
      where: { schoolId, active: true, enrollments: { some: { yearId: fromYearId, sectionId: fromSectionId } } },
      select: { id: true, admissionNo: true, name: true },
      orderBy: { admissionNo: 'asc' },
    });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  async promote(@CurrentUser() u: AuthUser, @Body() dto: PromoteDto) {
    const from = await this.prisma.section.findUniqueOrThrow({ where: { id: dto.fromSectionId }, include: { standard: true } });
    const schoolId = from.standard.schoolId;
    assertSchool(u, schoolId);
    await this.section(schoolId, dto.toSectionId);

    const students = await this.prisma.student.findMany({
      where: {
        schoolId, active: true,
        enrollments: { some: { yearId: dto.fromYearId, sectionId: dto.fromSectionId } },
        id: { notIn: dto.excludeStudentIds ?? [] },
      },
      include: { enrollments: { where: { yearId: dto.toYearId } } },
    });

    const toPromote = students.filter((s) => s.enrollments.length === 0);
    const alreadyEnrolled = students.filter((s) => s.enrollments.length > 0).map((s) => s.admissionNo);

    // ponytail: optional-head opt-ins and roll numbers aren't carried over; the class
    // teacher re-sets roll numbers each year, and re-opts optional heads via student edit.
    await this.prisma.$transaction(
      toPromote.map((s) =>
        this.prisma.enrollment.create({
          data: { studentId: s.id, yearId: dto.toYearId, sectionId: dto.toSectionId, isNewAdmission: false },
        }),
      ),
    );
    return { promoted: toPromote.length, alreadyEnrolled };
  }

  // Downgrade: take students out of a section they were promoted into by mistake. Only the
  // enrollment goes (with its concessions/fines/facilities); a student with any payment in that
  // year, a withdrawal, a new admission, or no earlier year to fall back to is skipped, never deleted.
  @Roles('ADMIN')
  @Post('undo')
  async undo(@CurrentUser() u: AuthUser, @Body() dto: UndoDto) {
    const sec = await this.prisma.section.findUniqueOrThrow({ where: { id: dto.sectionId }, include: { standard: true } });
    assertSchool(u, sec.standard.schoolId);
    const year = await this.prisma.academicYear.findUniqueOrThrow({ where: { id: dto.yearId } });

    const enrollments = await this.prisma.enrollment.findMany({
      where: { yearId: dto.yearId, sectionId: dto.sectionId, studentId: { in: dto.studentIds } },
      include: { student: { select: { admissionNo: true } }, withdrawal: true },
    });
    const found = new Set(enrollments.map((e) => e.studentId));
    const skipped = dto.studentIds.filter((id) => !found.has(id)).map((id) => ({ studentId: id, reason: 'Not enrolled in this section for this year' }));

    const undone: number[] = [];
    for (const e of enrollments) {
      const [payments, earlier] = await Promise.all([
        this.prisma.payment.count({ where: { studentId: e.studentId, yearId: dto.yearId } }),
        this.prisma.enrollment.count({ where: { studentId: e.studentId, year: { startDate: { lt: year.startDate } } } }),
      ]);
      const reason = e.isNewAdmission ? 'New admission, not a promotion'
        : e.withdrawal ? 'Student is withdrawn'
        : payments ? 'Has payments in this year'
        : !earlier ? 'No earlier year to return to'
        : null;
      if (reason) skipped.push({ studentId: e.studentId, reason });
      else {
        await this.prisma.enrollment.delete({ where: { id: e.id } });
        undone.push(e.studentId);
      }
    }
    return { undone: undone.length, undoneStudentIds: undone, skipped };
  }
}
