import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class FineDto {
  @IsInt() installmentId: number;
  // Fixed fine for this installment instead of the calculated one; 0 waives it.
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount: number;
  @IsString() @MinLength(2) remarks: string;
}

class SaveFinesDto {
  @IsInt() yearId: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FineDto) items: FineDto[];
}

@Controller('students/:id/fines')
export class FinesController {
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
    const rows = await this.prisma.fineAdjustment.findMany({ where: { enrollmentId: e.id }, orderBy: { installmentId: 'asc' } });
    return rows.map((f) => ({ installmentId: f.installmentId, amount: f.amount.toFixed(2), remarks: f.remarks }));
  }

  // Replaces the student's whole fine-override list for the year.
  @Roles('ADMIN')
  @Put()
  async save(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SaveFinesDto) {
    const e = await this.enrollment(u, id, dto.yearId);
    const ids = new Set(dto.items.map((i) => i.installmentId));
    if (ids.size !== dto.items.length) throw new BadRequestException('One fine override per installment');
    const valid = await this.prisma.installment.count({
      where: { id: { in: [...ids] }, schoolId: e.student.schoolId, yearId: dto.yearId },
    });
    if (valid !== ids.size) throw new BadRequestException('Unknown installment for this school/year');

    await this.prisma.$transaction([
      this.prisma.fineAdjustment.deleteMany({ where: { enrollmentId: e.id } }),
      this.prisma.fineAdjustment.createMany({
        data: dto.items.map((i) => ({ enrollmentId: e.id, installmentId: i.installmentId, amount: i.amount.toFixed(2), remarks: i.remarks })),
      }),
    ]);
    return this.list(u, id, dto.yearId);
  }
}
