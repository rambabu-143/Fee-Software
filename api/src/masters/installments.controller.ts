import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class InstallmentDto {
  @IsInt() schoolId: number;
  @IsInt() yearId: number;
  @IsInt() @Min(1) number: number;
  @IsString() @MinLength(1) label: string;
  @IsDateString() dueDate: string;
  @IsOptional() @IsDateString() fineStartDate?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) finePerDay?: number;
}
class UpdateInstallmentDto extends PartialType(OmitType(InstallmentDto, ['schoolId', 'yearId'])) {}

const toDates = <T extends { dueDate?: string; fineStartDate?: string | null }>(d: T) => ({
  ...d,
  dueDate: d.dueDate ? new Date(d.dueDate) : undefined,
  fineStartDate: d.fineStartDate ? new Date(d.fineStartDate) : d.fineStartDate === undefined ? undefined : null,
});

@Controller('installments')
export class InstallmentsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
  ) {
    assertSchool(u, schoolId);
    return this.prisma.installment.findMany({ where: { schoolId, yearId }, orderBy: { number: 'asc' } });
  }

  @Roles('ADMIN')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: InstallmentDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.installment.create({ data: { ...toDates(dto), dueDate: new Date(dto.dueDate) } });
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInstallmentDto) {
    assertSchool(u, (await this.prisma.installment.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.installment.update({ where: { id }, data: toDates(dto) });
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    assertSchool(u, (await this.prisma.installment.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.installment.delete({ where: { id } });
  }
}
