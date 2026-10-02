import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import bcrypt from 'bcryptjs';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentUser, Roles, type AuthUser } from './auth.guard.js';

class CreateUserDto {
  @IsString() @Matches(/^[a-z0-9._-]{3,32}$/, { message: 'username: 3-32 lowercase letters, digits, . _ -' }) username: string;
  @IsString() @MinLength(8) password: string;
  @IsEnum(Role) role: Role;
  @IsOptional() @IsInt() schoolId?: number | null;
}

class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

const select = { id: true, username: true, role: true, schoolId: true, active: true, school: { select: { name: true } } };

// Staff logins. SUPERADMIN manages everyone; a school ADMIN manages only their own school's users.
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  // Resolves the role/school a change would produce and checks the actor may make it.
  private check(actor: AuthUser, role: Role, schoolId: number | null | undefined) {
    if (actor.role !== 'SUPERADMIN') {
      if (!actor.schoolId) throw new ForbiddenException();
      if (role === 'SUPERADMIN') throw new ForbiddenException('Only a superadmin can grant superadmin');
      if (schoolId !== undefined && schoolId !== actor.schoolId) throw new ForbiddenException('You can only manage your own school');
      schoolId = actor.schoolId;
    }
    if (role === 'SUPERADMIN') return null;
    if (!schoolId) throw new BadRequestException('A school is required for this role');
    return schoolId;
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.prisma.user.findMany({
      where: u.role === 'SUPERADMIN' ? {} : { schoolId: u.schoolId ?? -1 },
      select,
      orderBy: { username: 'asc' },
    });
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto) {
    const schoolId = this.check(u, dto.role, dto.schoolId);
    return this.prisma.user.create({
      data: { username: dto.username, role: dto.role, schoolId, passwordHash: await bcrypt.hash(dto.password, 10) },
      select,
    });
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    // The target must already be manageable by the actor, and so must the result.
    this.check(u, target.role, target.schoolId);
    if (id === u.sub && (dto.active === false || (dto.role && dto.role !== target.role))) {
      throw new BadRequestException("You can't deactivate yourself or change your own role");
    }
    const role = dto.role ?? target.role;
    const schoolId = this.check(u, role, dto.schoolId !== undefined ? dto.schoolId : target.schoolId);
    return this.prisma.user.update({
      where: { id },
      data: {
        username: dto.username, role, schoolId, active: dto.active,
        ...(dto.password ? { passwordHash: await bcrypt.hash(dto.password, 10) } : {}),
      },
      select,
    });
  }
}
