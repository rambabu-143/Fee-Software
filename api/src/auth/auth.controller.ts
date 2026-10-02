import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public, type AuthUser } from './auth.guard.js';

class LoginDto {
  @IsString() username: string;
  @IsString() password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (!user?.active || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid username or password');
    }
    const payload: AuthUser = {
      sub: user.id,
      username: user.username,
      role: user.role,
      schoolId: user.schoolId,
    };
    return { token: await this.jwt.signAsync(payload), user: payload };
  }

  @Get('me')
  me(@Req() req: { user: AuthUser }) {
    return req.user;
  }
}
