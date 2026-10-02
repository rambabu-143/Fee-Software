import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional } from 'class-validator';
import { FacilityKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class SetFacilityDto {
  @IsInt() yearId: number;
  @IsEnum(FacilityKind) kind: FacilityKind;
  // null/omitted clears this kind's assignment (e.g. student stops taking the bus).
  @IsOptional() @IsInt() facilityId?: number;
}

// One route (transport) and one room (hostel) per student per year, at most.
@Controller('students/:id/facilities')
export class StudentFacilitiesController {
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
    const rows = await this.prisma.facilityAssignment.findMany({ where: { enrollmentId: e.id }, include: { facility: true } });
    return rows.map((a) => ({ kind: a.facility.kind, facilityId: a.facilityId, name: a.facility.name }));
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Put()
  async set(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetFacilityDto) {
    const e = await this.enrollment(u, id, dto.yearId);

    if (dto.facilityId !== undefined) {
      const f = await this.prisma.facility.findUnique({ where: { id: dto.facilityId } });
      if (f?.schoolId !== e.student.schoolId || f.kind !== dto.kind) {
        throw new BadRequestException('Invalid facility for this school/kind');
      }
    }

    await this.prisma.$transaction([
      this.prisma.facilityAssignment.deleteMany({ where: { enrollmentId: e.id, facility: { kind: dto.kind } } }),
      ...(dto.facilityId !== undefined
        ? [this.prisma.facilityAssignment.create({ data: { enrollmentId: e.id, facilityId: dto.facilityId } })]
        : []),
    ]);
    return this.list(u, id, dto.yearId);
  }
}
