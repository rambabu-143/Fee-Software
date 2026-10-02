import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class ConcessionDto {
  @IsInt() feeHeadId: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100) percent?: number;
  // Off each installment of the head.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount?: number;
  @IsString() @MinLength(2) reason: string;
}

class SaveConcessionsDto {
  @IsInt() yearId: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConcessionDto) items: ConcessionDto[];
}

@Controller('students/:id/concessions')
export class ConcessionsController {
  constructor(private prisma: PrismaService) {}

  private async enrollment(u: AuthUser, studentId: number, yearId: number) {
    const e = await this.prisma.enrollment.findUniqueOrThrow({
      where: { studentId_yearId: { studentId, yearId } },
      include: { student: { select: { schoolId: true } } },
    });
    assertSchool(u, e.student.schoolId);
    return e;
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number) {
    const e = await this.enrollment(u, id, yearId);
    const rows = await this.prisma.concession.findMany({ where: { enrollmentId: e.id }, orderBy: { id: 'asc' } });
    return rows.map((c) => ({ feeHeadId: c.feeHeadId, percent: c.percent?.toFixed(2) ?? null, amount: c.amount?.toFixed(2) ?? null, reason: c.reason }));
  }

  // Replaces the student's whole concession list for the year.
  @Roles('ADMIN')
  @Put()
  async save(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SaveConcessionsDto) {
    const e = await this.enrollment(u, id, dto.yearId);
    const heads = new Set(dto.items.map((i) => i.feeHeadId));
    if (heads.size !== dto.items.length) throw new BadRequestException('One concession per fee head');
    if (dto.items.some((i) => (i.percent == null) === (i.amount == null))) {
      throw new BadRequestException('Give either a percent or an amount for each concession');
    }
    const valid = await this.prisma.feeHead.count({ where: { id: { in: [...heads] }, schoolId: e.student.schoolId } });
    if (valid !== heads.size) throw new BadRequestException('Unknown fee head for this school');

    await this.prisma.$transaction([
      this.prisma.concession.deleteMany({ where: { enrollmentId: e.id } }),
      this.prisma.concession.createMany({
        data: dto.items.map((i) => ({ enrollmentId: e.id, feeHeadId: i.feeHeadId, percent: i.percent ?? null, amount: i.amount ?? null, reason: i.reason })),
      }),
    ]);
    return this.list(u, id, dto.yearId);
  }
}
