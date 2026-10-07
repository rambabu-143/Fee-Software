import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { IsDefined, IsInt, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { SETTING_DEFAULTS, type SettingKey } from './settings.js';

class SettingDto {
  @IsOptional() @IsInt() schoolId?: number;
  @IsDefined() value: unknown;
}

const scope = (u: AuthUser, schoolId?: number) => {
  const id = schoolId ?? u.schoolId;
  if (!id) throw new BadRequestException('schoolId is required');
  assertSchool(u, id);
  return id;
};

@Controller('settings')
export class SettingsController {
  constructor(private prisma: PrismaService) {}

  // Every whitelisted key: stored value or default. Any logged-in role may read.
  @Get()
  async all(@CurrentUser() u: AuthUser, @Query('schoolId', new ParseIntPipe({ optional: true })) schoolId?: number) {
    const rows = await this.prisma.setting.findMany({ where: { schoolId: scope(u, schoolId) } });
    return { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.filter((r) => r.key in SETTING_DEFAULTS).map((r) => [r.key, r.value])) };
  }

  @Roles('ADMIN')
  @Put(':key')
  async set(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: SettingDto) {
    if (!(key in SETTING_DEFAULTS)) throw new BadRequestException(`Unknown setting "${key}"`);
    const schoolId = scope(u, dto.schoolId);
    const def = SETTING_DEFAULTS[key as SettingKey];
    if (typeof dto.value !== typeof def) throw new BadRequestException(`${key} must be a ${typeof def}`);
    if (key === 'receiptFooter' && String(dto.value).length > 200) throw new BadRequestException('receiptFooter is at most 200 characters');
    await this.prisma.setting.upsert({
      where: { schoolId_key: { schoolId, key } },
      create: { schoolId, key, value: dto.value as never },
      update: { value: dto.value as never },
    });
    return { key, value: dto.value };
  }
}
