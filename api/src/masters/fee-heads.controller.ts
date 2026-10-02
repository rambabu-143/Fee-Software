import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsInt, IsString, MinLength } from 'class-validator';
import { FeeHeadType } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class FeeHeadDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) name: string;
  @IsEnum(FeeHeadType) type: FeeHeadType;
}
class UpdateFeeHeadDto extends PartialType(FeeHeadDto) {}

@Controller('fee-heads')
export class FeeHeadsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.feeHead.findMany({ where: { schoolId }, orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  }

  @Roles('ADMIN')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: FeeHeadDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.feeHead.create({ data: dto });
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFeeHeadDto) {
    assertSchool(u, (await this.prisma.feeHead.findUniqueOrThrow({ where: { id } })).schoolId);
    const { schoolId: _, ...data } = dto;
    return this.prisma.feeHead.update({ where: { id }, data });
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    assertSchool(u, (await this.prisma.feeHead.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.feeHead.delete({ where: { id } });
  }
}
