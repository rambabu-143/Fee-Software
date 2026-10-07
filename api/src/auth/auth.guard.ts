import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type AuthUser = { sub: number; username: string; role: Role; schoolId: number | null };

export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

// Registered globally: every route needs a valid JWT unless marked @Public().
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException();
    let sub: number;
    try {
      ({ sub } = await this.jwt.verifyAsync<AuthUser>(token));
    } catch {
      throw new UnauthorizedException();
    }
    // Re-read the user so deactivation and role/school changes apply immediately, not at token expiry.
    // ponytail: one PK lookup per request; cache briefly if it ever shows up in profiles.
    const u = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!u?.active) throw new UnauthorizedException();
    req.user = { sub: u.id, username: u.username, role: u.role, schoolId: u.schoolId } satisfies AuthUser;

    const roles = this.reflector.getAllAndOverride<Role[]>('roles', targets);
    if (roles && req.user.role !== 'SUPERADMIN' && !roles.includes(req.user.role)) {
      throw new ForbiddenException();
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

// A user tied to one school may only touch that school's data.
export function assertSchool(user: AuthUser, schoolId: number) {
  // 0 is falsy, so downstream `schoolId && {...}` filters would silently widen to every school.
  if (!Number.isInteger(schoolId) || schoolId < 1) throw new BadRequestException('Invalid schoolId');
  if (user.schoolId && user.schoolId !== schoolId) throw new ForbiddenException();
}
