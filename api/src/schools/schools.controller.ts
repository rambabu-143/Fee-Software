import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Roles, type AuthUser } from '../auth/auth.guard.js';

class CreateSchoolDto {
  @Matches(/^[A-Z]{2,10}$/) code: string;
  @IsString() name: string;
}

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
}
