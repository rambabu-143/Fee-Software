import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseDatePipe, ParseIntPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { page } from '../common/paging.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { loadTargets, MAX_BATCH, render } from '../notify/notify.js';
import { getSetting } from '../settings/settings.js';
import { normalizeMobile, smsProvider } from './sms.provider.js';

const TYPES = ['defaulter', 'receipt', 'general'];

class SmsTemplateDto {
  @IsInt() schoolId: number;
  @IsIn(TYPES) forType: string;
  @IsOptional() @IsString() starting?: string;
  @Matches(/\S/, { message: 'content must not be empty' }) content: string;
  @IsOptional() @IsString() ending?: string;
}
class UpdateSmsTemplateDto extends PartialType(OmitType(SmsTemplateDto, ['schoolId'] as const)) {}

class SendSmsDto {
  @IsInt() schoolId: number;
  @IsInt() templateId: number;
  @IsInt() yearId: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BATCH) @IsInt({ each: true }) enrollmentIds: number[];
}

type Row = { enrollmentId: number; status: 'SENT' | 'FAILED' | 'SKIPPED'; reason?: string };

@Controller()
export class SmsController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('sms-templates')
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number, @Query('type') type?: string) {
    assertSchool(u, schoolId);
    return this.prisma.smsTemplate.findMany({ where: { schoolId, active: true, ...(type ? { forType: type } : {}) }, orderBy: { id: 'asc' } });
  }

  @Roles('ADMIN')
  @Post('sms-templates')
  create(@CurrentUser() u: AuthUser, @Body() dto: SmsTemplateDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.smsTemplate.create({ data: dto });
  }

  private async owned(u: AuthUser, id: number) {
    const t = await this.prisma.smsTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    assertSchool(u, t.schoolId);
    return t;
  }

  @Roles('ADMIN')
  @Patch('sms-templates/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSmsTemplateDto) {
    await this.owned(u, id);
    return this.prisma.smsTemplate.update({ where: { id }, data: dto });
  }

  // Soft delete: logs keep pointing at what was sent.
  @Roles('ADMIN')
  @Delete('sms-templates/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.owned(u, id);
    return this.prisma.smsTemplate.update({ where: { id }, data: { active: false } });
  }

  // One failing row (bad number, provider error) never aborts the batch.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('sms/send')
  async send(@CurrentUser() u: AuthUser, @Body() dto: SendSmsDto) {
    assertSchool(u, dto.schoolId);
    const tpl = await this.prisma.smsTemplate.findFirst({ where: { id: dto.templateId, schoolId: dto.schoolId, active: true } });
    if (!tpl) throw new BadRequestException('Unknown or inactive template');
    if (!(await getSetting(this.prisma, dto.schoolId, 'smsEnabled'))) throw new BadRequestException('SMS is switched off for this school');

    const provider = smsProvider();
    const results: Row[] = [];
    const logs: Prisma.SmsLogCreateManyInput[] = [];
    const seen = new Set<string>();
    for (const t of await loadTargets(this.prisma, this.billing, dto.schoolId, dto.yearId, [...new Set(dto.enrollmentIds)])) {
      if (!t.e) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: 'Not enrolled in this school/year' }); continue; }
      const number = normalizeMobile(t.e.student.phone);
      if (!number) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: t.e.student.phone ? 'Invalid mobile number' : 'No mobile number' }); continue; }
      const body = render(`${tpl.starting}${tpl.content}${tpl.ending}`, t.vars).trim();
      if (!body) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: 'Empty message' }); continue; }
      if (seen.has(`${number}|${body}`)) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: 'Duplicate message to this number' }); continue; }
      seen.add(`${number}|${body}`);
      let status: 'SENT' | 'FAILED' = 'SENT', providerResponse: string;
      try { providerResponse = await provider.send(number, body); }
      catch (err) { status = 'FAILED'; providerResponse = err instanceof Error ? err.message : String(err); }
      logs.push({ schoolId: dto.schoolId, enrollmentId: t.id, number, type: tpl.forType, body, status, providerResponse });
      results.push({ enrollmentId: t.id, status, ...(status === 'FAILED' ? { reason: providerResponse } : {}) });
    }
    if (logs.length) await this.prisma.smsLog.createMany({ data: logs });
    return { sent: results.filter((r) => r.status === 'SENT').length, results };
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('sms/log')
  async log(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('from', new ParseDatePipe({ optional: true })) from?: Date,
    @Query('to', new ParseDatePipe({ optional: true })) to?: Date,
    @Query('type') type?: string,
    @Query('number') number?: string,
    @Query('status') status?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
    @Res({ passthrough: true }) res?: Response,
  ) {
    assertSchool(u, schoolId);
    if (status && !['QUEUED', 'SENT', 'FAILED'].includes(status)) throw new BadRequestException('Bad status');
    const where = {
      schoolId, ...(type ? { type } : {}), ...(number ? { number } : {}), ...(status ? { status: status as 'SENT' } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(+to + 864e5) } : {}) } } : {}),
    };
    // No limit = newest 500, as before; with limit/offset page through, X-Total-Count has the full match count.
    const [rows, total] = await Promise.all([
      this.prisma.smsLog.findMany({ where, orderBy: { id: 'desc' }, ...page(limit, offset, 500) }),
      this.prisma.smsLog.count({ where }),
    ]);
    res?.setHeader('X-Total-Count', total);
    return rows;
  }
}
