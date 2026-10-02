import {
  BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsInt, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

class StopDto {
  @IsInt() routeId: number;
  @IsInt() slabId: number;
  @IsString() @MinLength(1) name: string;
  @IsInt() @Min(1) sequence: number;
  @IsOptional() @Matches(HHMM, { message: 'pickupTime must be HH:MM (24h)' }) pickupTime?: string;
  @IsOptional() @Matches(HHMM, { message: 'dropTime must be HH:MM (24h)' }) dropTime?: string;
}
class UpdateStopDto extends PartialType(OmitType(StopDto, ['routeId'])) {}

const include = { route: { select: { name: true } }, slab: { select: { name: true } } };
const present = ({ route, slab, ...s }: { route: { name: string }; slab: { name: string } } & Record<string, unknown>) =>
  ({ ...s, route: route.name, slab: slab.name });

// Stops of the bus routes. A route is a TRANSPORT facility; a stop's slab (a SLAB facility) sets its fare.
@Controller('stops')
export class StopsController {
  constructor(private prisma: PrismaService) {}

  private async check(u: AuthUser, routeId: number | undefined, slabId: number | undefined, schoolId?: number) {
    const [route, slab] = await Promise.all([
      routeId === undefined ? null : this.prisma.facility.findUnique({ where: { id: routeId } }),
      slabId === undefined ? null : this.prisma.facility.findUnique({ where: { id: slabId } }),
    ]);
    if (routeId !== undefined) {
      if (route?.kind !== 'TRANSPORT') throw new BadRequestException('routeId must be a transport route');
      assertSchool(u, route.schoolId);
      schoolId = route.schoolId;
    }
    if (slabId !== undefined && (slab?.kind !== 'SLAB' || slab.schoolId !== schoolId)) {
      throw new BadRequestException('slabId must be a slab of the same school');
    }
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('routeId', new ParseIntPipe({ optional: true })) routeId?: number) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.stop.findMany({
      where: { route: { schoolId }, ...(routeId ? { routeId } : {}) },
      include, orderBy: [{ route: { name: 'asc' } }, { sequence: 'asc' }],
    });
    return rows.map(present);
  }

  @Roles('ADMIN')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: StopDto) {
    await this.check(u, dto.routeId, dto.slabId);
    return present(await this.prisma.stop.create({ data: dto, include }));
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStopDto) {
    const stop = await this.prisma.stop.findUniqueOrThrow({ where: { id }, include: { route: true } });
    assertSchool(u, stop.route.schoolId);
    await this.check(u, undefined, dto.slabId, stop.route.schoolId);
    return present(await this.prisma.stop.update({ where: { id }, data: dto, include }));
  }

  // Refused (409) while any student uses the stop.
  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const stop = await this.prisma.stop.findUniqueOrThrow({ where: { id }, include: { route: true } });
    assertSchool(u, stop.route.schoolId);
    await this.prisma.stop.delete({ where: { id } });
    return { deleted: true };
  }
}
