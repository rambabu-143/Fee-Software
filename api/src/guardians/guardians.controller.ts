import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class GuardianDto {
  @IsString() @MinLength(1) name: string;
  @IsIn(['FATHER', 'MOTHER', 'GUARDIAN']) relation: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsString() organization?: string;
  @IsOptional() @IsString() officeAddress?: string;
  @IsOptional() @IsString() officePhone?: string;
  @IsOptional() @IsInt() occupationId?: number;
  @IsOptional() @IsBoolean() isStaff?: boolean;
  @IsOptional() @IsString() staffBranch?: string;
}
class UpdateGuardianDto extends PartialType(GuardianDto) {}

class SubjectsDto {
  @IsInt() yearId: number;
  @IsArray() @IsInt({ each: true }) subjectIds: number[];
}

@Controller()
export class GuardiansController {
  constructor(private prisma: PrismaService) {}

  private async student(u: AuthUser, id: number) {
    const s = await this.prisma.student.findUniqueOrThrow({ where: { id } });
    assertSchool(u, s.schoolId);
    return s;
  }

  // Occupation must belong to the student's school.
  private async checkOccupation(schoolId: number, occupationId?: number) {
    if (occupationId === undefined) return;
    if (!(await this.prisma.occupation.count({ where: { id: occupationId, schoolId } }))) {
      throw new BadRequestException('Occupation does not belong to this school');
    }
  }

  @Get('students/:id/guardians')
  async list(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.student(u, id);
    return this.prisma.guardian.findMany({ where: { studentId: id }, orderBy: { id: 'asc' } });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('students/:id/guardians')
  async add(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: GuardianDto) {
    const s = await this.student(u, id);
    await this.checkOccupation(s.schoolId, dto.occupationId);
    return this.prisma.guardian.create({ data: { ...dto, studentId: id } });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Patch('guardians/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGuardianDto) {
    const g = await this.prisma.guardian.findUniqueOrThrow({ where: { id }, include: { student: true } });
    assertSchool(u, g.student.schoolId);
    await this.checkOccupation(g.student.schoolId, dto.occupationId);
    return this.prisma.guardian.update({ where: { id }, data: dto });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Delete('guardians/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const g = await this.prisma.guardian.findUniqueOrThrow({ where: { id }, include: { student: true } });
    assertSchool(u, g.student.schoolId);
    await this.prisma.guardian.delete({ where: { id } });
    return { ok: true };
  }

  @Get('students/:id/subjects')
  async subjects(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number) {
    await this.student(u, id);
    const rows = await this.prisma.studentSubject.findMany({
      where: { enrollment: { studentId: id, yearId } },
      include: { subject: true },
    });
    return rows.map((r) => r.subject);
  }

  // Replaces the student's subject set for the year.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Put('students/:id/subjects')
  async setSubjects(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SubjectsDto) {
    const s = await this.student(u, id);
    const e = await this.prisma.enrollment.findUnique({ where: { studentId_yearId: { studentId: id, yearId: dto.yearId } } });
    if (!e) throw new BadRequestException('Student is not enrolled in this year');
    const ids = [...new Set(dto.subjectIds)];
    if ((await this.prisma.subject.count({ where: { id: { in: ids }, schoolId: s.schoolId } })) !== ids.length) {
      throw new BadRequestException('Invalid subject');
    }
    await this.prisma.$transaction([
      this.prisma.studentSubject.deleteMany({ where: { enrollmentId: e.id } }),
      this.prisma.studentSubject.createMany({ data: ids.map((subjectId) => ({ enrollmentId: e.id, subjectId })) }),
    ]);
    return this.subjects(u, id, dto.yearId);
  }
}
