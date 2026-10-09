import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseEnumPipe, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsEnum, IsInt, IsNumber, IsString, Min, MinLength, ValidateNested,
} from 'class-validator';
import { FacilityKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class FacilityDto {
  @IsInt() schoolId: number;
  @IsEnum(FacilityKind) kind: FacilityKind;
  @IsString() @MinLength(1) name: string;
}
class RenameDto {
  @IsString() @MinLength(1) name: string;
}

class FacilityItemDto {
  @IsInt() facilityId: number;
  @IsInt() installmentId: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount: number;
}
class SaveFacilityStructureDto {
  @IsInt() yearId: number;
  @IsInt() schoolId: number;
  @IsEnum(FacilityKind) kind: FacilityKind;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FacilityItemDto) items: FacilityItemDto[];
}

// Transport routes and hostel rooms: same shape (a name + a fee-per-installment grid),
// so one controller serves both, told apart by `kind`.
@Controller('facilities')
export class FacilitiesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('kind', new ParseEnumPipe(FacilityKind)) kind: FacilityKind) {
    assertSchool(u, schoolId);
    return this.prisma.facility.findMany({ where: { schoolId, kind }, orderBy: { name: 'asc' } });
  }

  @Roles('ADMIN')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: FacilityDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.facility.create({ data: dto });
  }

  @Roles('ADMIN')
  @Patch(':id')
  async rename(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RenameDto) {
    assertSchool(u, (await this.prisma.facility.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.facility.update({ where: { id }, data: { name: dto.name } });
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    assertSchool(u, (await this.prisma.facility.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.facility.delete({ where: { id } });
  }

  // Fee grid: facility x installment -> amount. Same shape as /fee-structure.
  @Get('structure')
  async getStructure(
    @CurrentUser() u: AuthUser,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('kind', new ParseEnumPipe(FacilityKind)) kind: FacilityKind,
  ) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.facilityFeeStructure.findMany({
      where: { yearId, facility: { schoolId, kind } },
    });
    return rows.map((r) => ({ facilityId: r.facilityId, installmentId: r.installmentId, amount: r.amount.toFixed(2) }));
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Put('structure')
  async saveStructure(@CurrentUser() u: AuthUser, @Body() dto: SaveFacilityStructureDto) {
    const { yearId, schoolId, kind, items } = dto;
    assertSchool(u, schoolId);

    const cells = new Set(items.map((i) => `${i.facilityId}:${i.installmentId}`));
    if (cells.size !== items.length) throw new BadRequestException('Duplicate facility / installment cell');

    const facilityIds = [...new Set(items.map((i) => i.facilityId))];
    const instIds = [...new Set(items.map((i) => i.installmentId))];
    const [facilities, insts] = await Promise.all([
      this.prisma.facility.count({ where: { id: { in: facilityIds }, schoolId, kind } }),
      this.prisma.installment.count({ where: { id: { in: instIds }, schoolId, yearId } }),
    ]);
    if (facilities !== facilityIds.length || insts !== instIds.length) {
      throw new BadRequestException('Facility or installment does not belong to this school/year');
    }

    const data = items
      .filter((i) => i.amount > 0)
      .map((i) => ({ yearId, facilityId: i.facilityId, installmentId: i.installmentId, amount: i.amount.toFixed(2) }));
    await this.prisma.$transaction([
      this.prisma.facilityFeeStructure.deleteMany({ where: { yearId, facility: { schoolId, kind } } }),
      this.prisma.facilityFeeStructure.createMany({ data }),
    ]);
    return this.getStructure(u, yearId, schoolId, kind);
  }
}
