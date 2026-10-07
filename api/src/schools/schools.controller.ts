import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class CreateSchoolDto {
  @Matches(/^[A-Z]{2,10}$/) code: string;
  @IsString() name: string;
  @IsOptional() @IsString() affiliationNo?: string;
  @IsOptional() @IsString() schoolNo?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsIn(['SENIOR', 'JUNIOR']) kind?: 'SENIOR' | 'JUNIOR';
}
class UpdateSchoolDto extends PartialType(OmitType(CreateSchoolDto, ['code'] as const)) {}

// ponytail: no service layer yet, controller talks to Prisma directly. Split when logic appears.
@Controller('schools')
export class SchoolsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(@Req() req: { user: AuthUser }) {
    const { schoolId } = req.user;
    return this.prisma.school.findMany({
      where: schoolId ? { id: schoolId } : {},
      orderBy: { code: 'asc' },
    });
  }

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateSchoolDto) {
    return this.prisma.school.create({ data: dto });
  }

  // Letterhead details printed on TCs and certificates.
  @Roles('ADMIN')
  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSchoolDto) {
    assertSchool(u, id);
    return this.prisma.school.update({ where: { id }, data: dto });
  }
}
