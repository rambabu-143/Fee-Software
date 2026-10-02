import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { IsBoolean, IsDateString, IsOptional, Matches } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Roles } from '../auth/auth.guard.js';

class CreateYearDto {
  @Matches(/^\d{4}-\d{2}$/) label: string;
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
  @IsOptional() @IsBoolean() isCurrent?: boolean;
}

@Controller('years')
export class YearsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  }

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateYearDto) {
    const data = { ...dto, startDate: new Date(dto.startDate), endDate: new Date(dto.endDate) };
    if (data.endDate <= data.startDate) throw new BadRequestException('endDate must be after startDate');
    // Only one year can be current.
    return this.prisma.$transaction(async (tx) => {
      if (dto.isCurrent) await tx.academicYear.updateMany({ data: { isCurrent: false } });
      return tx.academicYear.create({ data });
    });
  }
}
