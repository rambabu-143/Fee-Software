import {
  BadRequestException, Body, Controller, Get, Header, Param, ParseDatePipe, ParseIntPipe, Patch, Post, Query, StreamableFile,
} from '@nestjs/common';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsArray, IsBoolean, IsDateString, IsEmail, IsInt, IsOptional, IsString, MinLength,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { billPdf } from '../billing/pdf.js';

class StudentDto {
  @IsInt() schoolId: number;
  @IsInt() yearId: number;
  @IsString() @MinLength(1) admissionNo: string;
  @IsString() @MinLength(1) name: string;
  @IsOptional() @IsDateString() dob?: string;
  @IsOptional() @IsString() fatherName?: string;
  @IsOptional() @IsString() motherName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsInt() sectionId: number;
  @IsOptional() @IsInt() rollNo?: number;
  @IsBoolean() isNewAdmission: boolean;
  @IsArray() @IsInt({ each: true }) optionalHeadIds: number[];
}
// yearId says which year's enrollment the section/roll/opt-ins apply to.
class UpdateStudentDto extends PartialType(OmitType(StudentDto, ['schoolId', 'yearId'])) {
  @IsInt() yearId: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

const enrollmentInclude = (yearId: number) => ({
  enrollments: {
    where: { yearId },
    include: { section: { include: { standard: true } }, optionalHeads: { select: { id: true } } },
  },
});

@Controller('students')
export class StudentsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('standardId', new ParseIntPipe({ optional: true })) standardId?: number,
    @Query('q') q?: string,
  ) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.student.findMany({
      where: {
        schoolId,
        enrollments: {
          some: { yearId, ...(standardId ? { section: { standardId } } : {}) },
        },
        ...(q
          ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { admissionNo: { contains: q, mode: 'insensitive' } }] }
          : {}),
      },
      include: enrollmentInclude(yearId),
      orderBy: { admissionNo: 'asc' },
      take: 500, // ponytail: hard cap instead of pagination; paginate when a school passes this
    });
    return rows.map(({ enrollments: [e], ...s }) => ({
      ...s,
      enrollment: {
        sectionId: e.sectionId,
        standardId: e.section.standardId,
        className: `${e.section.standard.name} ${e.section.name}`,
        rollNo: e.rollNo,
        isNewAdmission: e.isNewAdmission,
        optionalHeadIds: e.optionalHeads.map((h) => h.id),
      },
    }));
  }

  // Section and optional heads must belong to the student's school.
  private async checkRefs(schoolId: number, sectionId?: number, optionalHeadIds?: number[]) {
    if (sectionId !== undefined) {
      const sec = await this.prisma.section.findUnique({ where: { id: sectionId }, include: { standard: true } });
      if (sec?.standard.schoolId !== schoolId) throw new BadRequestException('Section does not belong to this school');
    }
    if (optionalHeadIds?.length) {
      const n = await this.prisma.feeHead.count({ where: { id: { in: optionalHeadIds }, schoolId, type: 'OPTIONAL' } });
      if (n !== new Set(optionalHeadIds).size) throw new BadRequestException('Invalid optional fee head');
    }
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: StudentDto) {
    const { yearId, sectionId, rollNo, isNewAdmission, optionalHeadIds, dob, ...student } = dto;
    assertSchool(u, dto.schoolId);
    await this.checkRefs(dto.schoolId, sectionId, optionalHeadIds);
    return this.prisma.student.create({
      data: {
        ...student,
        dob: dob ? new Date(dob) : undefined,
        enrollments: {
          create: {
            yearId, sectionId, rollNo, isNewAdmission,
            optionalHeads: { connect: optionalHeadIds.map((id) => ({ id })) },
          },
        },
      },
    });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStudentDto) {
    const existing = await this.prisma.student.findUniqueOrThrow({ where: { id } });
    assertSchool(u, existing.schoolId);
    const { yearId, sectionId, rollNo, isNewAdmission, optionalHeadIds, dob, ...student } = dto;
    await this.checkRefs(existing.schoolId, sectionId, optionalHeadIds);
    if (dto.active === true && (await this.prisma.withdrawal.count({ where: { enrollment: { studentId: id, yearId } } }))) {
      throw new BadRequestException('Student is withdrawn for this year; re-admit them instead');
    }

    const enrollment = {
      sectionId, rollNo, isNewAdmission,
      ...(optionalHeadIds ? { optionalHeads: { set: optionalHeadIds.map((hid) => ({ id: hid })) } } : {}),
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id }, data: { ...student, ...(dob ? { dob: new Date(dob) } : {}) } });
      const current = await tx.enrollment.findUnique({ where: { studentId_yearId: { studentId: id, yearId } } });
      if (current) {
        await tx.enrollment.update({ where: { id: current.id }, data: enrollment });
      } else {
        // Promotion into a new year: section is required.
        if (!sectionId) throw new BadRequestException('sectionId is required to enroll in a new year');
        await tx.enrollment.create({
          data: { ...enrollment, sectionId, studentId: id, yearId, optionalHeads: { connect: (optionalHeadIds ?? []).map((hid) => ({ id: hid })) } },
        });
      }
      return tx.student.findUniqueOrThrow({ where: { id } });
    });
  }

  @Get(':id/bill')
  async bill(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf', new ParseDatePipe({ optional: true })) asOf?: Date,
  ) {
    const bill = await this.billing.build(id, yearId, asOf ?? new Date());
    assertSchool(u, bill.student.schoolId);
    return BillingService.present(bill);
  }

  @Get(':id/bill.pdf')
  @Header('Content-Type', 'application/pdf')
  async billPdf(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf', new ParseDatePipe({ optional: true })) asOf?: Date,
  ) {
    const at = asOf ?? new Date();
    const bill = await this.billing.build(id, yearId, at);
    assertSchool(u, bill.student.schoolId);
    const [school, year] = await Promise.all([
      this.prisma.school.findUniqueOrThrow({ where: { id: bill.student.schoolId } }),
      this.prisma.academicYear.findUniqueOrThrow({ where: { id: yearId } }),
    ]);
    const buf = await billPdf(school.name, { ...BillingService.present(bill), year: year.label, asOf: at.toISOString().slice(0, 10) });
    return new StreamableFile(buf, { disposition: `inline; filename="bill-${bill.student.admissionNo}.pdf"` });
  }
}
