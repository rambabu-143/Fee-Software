import { Body, Controller, Get, HttpException, Post, Req, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public, type AuthUser } from './auth.guard.js';

// Compared against when the username doesn't exist, so response time doesn't reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ponytail: per-process memory; use a shared store (redis/throttler) if the API runs on several instances.
// Behind a reverse proxy, set Express 'trust proxy' so req.ip is the client, not the proxy.
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60_000;
const fails = new Map<string, { n: number; until: number }>();

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
  async login(@Body() dto: LoginDto, @Req() req: { ip?: string }) {
    const key = `${req.ip}|${dto.username}`;
    const f = fails.get(key);
    if (f && f.until > Date.now() && f.n >= MAX_FAILS) throw new HttpException('Too many failed logins, try again later', 429);
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    const match = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user?.active || !match) {
      if (fails.size > 10_000) fails.clear(); // random usernames must not grow the map without bound
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
      cur.n++;
      fails.set(key, cur);
      throw new UnauthorizedException('Invalid username or password');
    }
    fails.delete(key);
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
