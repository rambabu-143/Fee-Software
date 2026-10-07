import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { SubjectKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class OccupationDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) name: string;
  @IsOptional() @IsInt() parentId?: number;
}
class UpdateOccupationDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsInt() parentId?: number;
}
class SubjectDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) name: string;
  @IsEnum(SubjectKind) kind: SubjectKind;
}
class UpdateSubjectDto extends PartialType(SubjectDto) {}

// Occupation categories (one level of sub-categories) and the subject catalogue, per school.
@Controller()
export class CatalogController {
  constructor(private prisma: PrismaService) {}

  private async occupation(u: AuthUser, id: number) {
    const o = await this.prisma.occupation.findUniqueOrThrow({ where: { id } });
    assertSchool(u, o.schoolId);
    return o;
  }
  private async subject(u: AuthUser, id: number) {
    const s = await this.prisma.subject.findUniqueOrThrow({ where: { id } });
    assertSchool(u, s.schoolId);
    return s;
  }
  // Parent must be a top-level occupation of the same school (one level only).
  private async checkParent(schoolId: number, parentId?: number, selfId?: number) {
    if (parentId === undefined) return;
    const p = await this.prisma.occupation.findUnique({ where: { id: parentId } });
    if (!p || p.schoolId !== schoolId || p.parentId !== null || p.id === selfId) {
      throw new BadRequestException('Invalid parent occupation');
    }
  }

  @Get('occupations')
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.occupation.findMany({ where: { schoolId }, orderBy: { name: 'asc' } });
  }

  @Roles('ADMIN')
  @Post('occupations')
  async createOccupation(@CurrentUser() u: AuthUser, @Body() dto: OccupationDto) {
    assertSchool(u, dto.schoolId);
    await this.checkParent(dto.schoolId, dto.parentId);
    return this.prisma.occupation.create({ data: dto });
  }

  @Roles('ADMIN')
  @Patch('occupations/:id')
  async updateOccupation(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOccupationDto) {
    const o = await this.occupation(u, id);
    await this.checkParent(o.schoolId, dto.parentId, id);
    return this.prisma.occupation.update({ where: { id }, data: dto });
  }

  // The FK would silently null out guardians/sub-categories, so refuse in-use occupations explicitly.
  @Roles('ADMIN')
  @Delete('occupations/:id')
  async removeOccupation(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.occupation(u, id);
    if ((await this.prisma.guardian.count({ where: { occupationId: id } })) || (await this.prisma.occupation.count({ where: { parentId: id } }))) {
      throw new ConflictException('This occupation is in use');
    }
    await this.prisma.occupation.delete({ where: { id } });
    return { ok: true };
  }

  @Get('subjects')
  listSubjects(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('kind') kind?: SubjectKind) {
    assertSchool(u, schoolId);
    if (kind && !(kind in SubjectKind)) throw new BadRequestException('Bad kind');
    return this.prisma.subject.findMany({ where: { schoolId, ...(kind ? { kind } : {}) }, orderBy: { name: 'asc' } });
  }

  @Roles('ADMIN')
  @Post('subjects')
  createSubject(@CurrentUser() u: AuthUser, @Body() dto: SubjectDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.subject.create({ data: dto });
  }

  @Roles('ADMIN')
  @Patch('subjects/:id')
  async updateSubject(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSubjectDto) {
    await this.subject(u, id);
    const { schoolId: _ignored, ...data } = dto;
    return this.prisma.subject.update({ where: { id }, data });
  }

  @Roles('ADMIN')
  @Delete('subjects/:id')
  async removeSubject(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.subject(u, id);
    await this.prisma.subject.delete({ where: { id } });
    return { ok: true };
  }
}
