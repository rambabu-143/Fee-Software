import { Controller, Get, ParseDatePipe, ParseIntPipe, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';

// Read-only on purpose: there is no way to edit or delete an audit entry through the API.
@Controller('audit')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Roles('ADMIN')
  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', new ParseIntPipe({ optional: true })) schoolId?: number,
    @Query('entity') entity?: string,
    @Query('entityId', new ParseIntPipe({ optional: true })) entityId?: number,
    @Query('from', new ParseDatePipe({ optional: true })) from?: Date,
    @Query('to', new ParseDatePipe({ optional: true })) to?: Date,
    @Query('take', new ParseIntPipe({ optional: true })) take = 50,
    @Query('skip', new ParseIntPipe({ optional: true })) skip = 0,
  ) {
    if (schoolId) assertSchool(u, schoolId);
    const where = {
      schoolId: u.schoolId ?? schoolId, // a school admin only ever sees their own school
      ...(entity ? { entity } : {}), ...(entityId ? { entityId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(+to + 864e5) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: Math.min(Math.max(take, 1), 200), skip: Math.max(skip, 0) }),
    ]);
    return { total, rows };
  }
}
