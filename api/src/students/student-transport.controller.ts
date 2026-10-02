import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { IsInt, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

class SetTransportDto {
  @IsInt() yearId: number;
  // Either leg may be omitted/null (morning-only or afternoon-only). Both empty clears the assignment.
  @IsOptional() @IsInt() pickupStopId?: number | null;
  @IsOptional() @IsInt() dropStopId?: number | null;
}

const stopInfo = (s: { id: number; name: string; route: { name: string }; slab: { name: string } } | null) =>
  s && { id: s.id, name: s.name, route: s.route.name, slab: s.slab.name };

@Controller('students/:id/transport')
export class StudentTransportController {
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
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('yearId', ParseIntPipe) yearId: number) {
    const e = await this.enrollment(u, id, yearId);
    const t = await this.prisma.transportAssignment.findUnique({
      where: { enrollmentId: e.id },
      include: { pickupStop: { include: { route: true, slab: true } }, dropStop: { include: { route: true, slab: true } } },
    });
    return { pickup: stopInfo(t?.pickupStop ?? null), drop: stopInfo(t?.dropStop ?? null) };
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Put()
  async set(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetTransportDto) {
    const e = await this.enrollment(u, id, dto.yearId);
    const pickupStopId = dto.pickupStopId ?? null;
    const dropStopId = dto.dropStopId ?? null;

    const ids = [pickupStopId, dropStopId].filter((x): x is number => x !== null);
    const found = await this.prisma.stop.count({ where: { id: { in: ids }, route: { schoolId: e.student.schoolId } } });
    if (found !== new Set(ids).size) throw new BadRequestException('Unknown stop for this school');

    if (ids.length && (await this.prisma.facilityAssignment.count({ where: { enrollmentId: e.id, facility: { kind: 'TRANSPORT' } } }))) {
      throw new BadRequestException('Student is on a flat-fee route; remove it before assigning stops');
    }

    if (!ids.length) await this.prisma.transportAssignment.deleteMany({ where: { enrollmentId: e.id } });
    else {
      await this.prisma.transportAssignment.upsert({
        where: { enrollmentId: e.id },
        create: { enrollmentId: e.id, pickupStopId, dropStopId },
        update: { pickupStopId, dropStopId },
      });
    }
    return this.get(u, id, dto.yearId);
  }
}
