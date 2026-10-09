import {
  BadRequestException, Body, Controller, Get, ParseIntPipe, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, Min, ValidateNested } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class FeeStructureItemDto {
  @IsInt() feeHeadId: number;
  @IsInt() installmentId: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount: number;
}

class SaveFeeStructureDto {
  @IsInt() yearId: number;
  @IsInt() standardId: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FeeStructureItemDto) items: FeeStructureItemDto[];
}

// The fee grid for one class in one year: fee head x installment -> amount.
@Controller('fee-structure')
export class FeeStructureController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async get(
    @CurrentUser() u: AuthUser,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('standardId', ParseIntPipe) standardId: number,
  ) {
    assertSchool(u, (await this.prisma.standard.findUniqueOrThrow({ where: { id: standardId } })).schoolId);
    const rows = await this.prisma.feeStructure.findMany({ where: { yearId, standardId } });
    return rows.map((r) => ({ feeHeadId: r.feeHeadId, installmentId: r.installmentId, amount: r.amount.toFixed(2) }));
  }

  // Replaces the whole grid. Zero amounts are simply not stored.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Put()
  async save(@CurrentUser() u: AuthUser, @Body() dto: SaveFeeStructureDto) {
    const { yearId, standardId, items } = dto;
    const { schoolId } = await this.prisma.standard.findUniqueOrThrow({ where: { id: standardId } });
    assertSchool(u, schoolId);

    const cells = new Set(items.map((i) => `${i.feeHeadId}:${i.installmentId}`));
    if (cells.size !== items.length) throw new BadRequestException('Duplicate fee head / installment cell');

    // Every head and installment must belong to this class's school (and installments to this year).
    const headIds = [...new Set(items.map((i) => i.feeHeadId))];
    const instIds = [...new Set(items.map((i) => i.installmentId))];
    const [heads, insts] = await Promise.all([
      this.prisma.feeHead.count({ where: { id: { in: headIds }, schoolId } }),
      this.prisma.installment.count({ where: { id: { in: instIds }, schoolId, yearId } }),
    ]);
    if (heads !== headIds.length || insts !== instIds.length) {
      throw new BadRequestException('Fee head or installment does not belong to this school/year');
    }

    const data = items
      .filter((i) => i.amount > 0)
      .map((i) => ({ yearId, standardId, feeHeadId: i.feeHeadId, installmentId: i.installmentId, amount: i.amount.toFixed(2) }));
    await this.prisma.$transaction([
      this.prisma.feeStructure.deleteMany({ where: { yearId, standardId } }),
      this.prisma.feeStructure.createMany({ data }),
    ]);
    return this.get(u, yearId, standardId);
  }
}
