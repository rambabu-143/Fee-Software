import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { IsInt, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class StandardDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) name: string;
  @IsInt() sortOrder: number;
}
class UpdateStandardDto extends PartialType(StandardDto) {}

class SectionDto {
  @IsInt() standardId: number;
  @IsString() @MinLength(1) name: string;
}

// Classes and their sections.
@Controller()
export class StandardsController {
  constructor(private prisma: PrismaService) {}

  @Get('standards')
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.standard.findMany({
      where: { schoolId },
      orderBy: { sortOrder: 'asc' },
      include: { sections: { orderBy: { name: 'asc' } } },
    });
  }

  @Roles('ADMIN')
  @Post('standards')
  create(@CurrentUser() u: AuthUser, @Body() dto: StandardDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.standard.create({ data: dto });
  }

  @Roles('ADMIN')
  @Patch('standards/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStandardDto) {
    assertSchool(u, (await this.prisma.standard.findUniqueOrThrow({ where: { id } })).schoolId);
    const { schoolId: _, ...data } = dto; // a class never moves between schools
    return this.prisma.standard.update({ where: { id }, data });
  }

  @Roles('ADMIN')
  @Delete('standards/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    assertSchool(u, (await this.prisma.standard.findUniqueOrThrow({ where: { id } })).schoolId);
    return this.prisma.standard.delete({ where: { id } });
  }

  @Roles('ADMIN')
  @Post('sections')
  async createSection(@CurrentUser() u: AuthUser, @Body() dto: SectionDto) {
    assertSchool(u, (await this.prisma.standard.findUniqueOrThrow({ where: { id: dto.standardId } })).schoolId);
    return this.prisma.section.create({ data: dto });
  }

  @Roles('ADMIN')
  @Delete('sections/:id')
  async removeSection(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const s = await this.prisma.section.findUniqueOrThrow({ where: { id }, include: { standard: true } });
    assertSchool(u, s.standard.schoolId);
    return this.prisma.section.delete({ where: { id } });
  }
}
