import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseDatePipe, ParseIntPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Matches, MinLength } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { page } from '../common/paging.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { loadTargets, MAX_BATCH, render } from '../notify/notify.js';
import { emailProvider, validEmail } from './email.provider.js';

class EmailTemplateDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) name: string;
  @IsString() @MinLength(1) subject: string;
  @Matches(/\S/, { message: 'body must not be empty' }) body: string;
}
class UpdateEmailTemplateDto extends PartialType(OmitType(EmailTemplateDto, ['schoolId'] as const)) {}

class SendEmailDto {
  @IsInt() schoolId: number;
  @IsInt() templateId: number;
  @IsInt() yearId: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_BATCH) @IsInt({ each: true }) enrollmentIds: number[];
}

type Row = { enrollmentId: number; status: 'SENT' | 'FAILED' | 'SKIPPED'; sent?: number; reason?: string };

@Controller()
export class EmailController {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  @Roles('ADMIN')
  @Get('email-templates')
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.emailTemplate.findMany({ where: { schoolId, active: true }, orderBy: { id: 'asc' } });
  }

  @Roles('ADMIN')
  @Post('email-templates')
  create(@CurrentUser() u: AuthUser, @Body() dto: EmailTemplateDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.emailTemplate.create({ data: dto });
  }

  private async owned(u: AuthUser, id: number) {
    const t = await this.prisma.emailTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    assertSchool(u, t.schoolId);
    return t;
  }

  @Roles('ADMIN')
  @Patch('email-templates/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmailTemplateDto) {
    await this.owned(u, id);
    return this.prisma.emailTemplate.update({ where: { id }, data: dto });
  }

  @Roles('ADMIN')
  @Delete('email-templates/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.owned(u, id);
    return this.prisma.emailTemplate.update({ where: { id }, data: { active: false } });
  }

  // Goes to the student's own, father's and mother's addresses (valid + distinct only). A failure never aborts the batch.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('email/send')
  async send(@CurrentUser() u: AuthUser, @Body() dto: SendEmailDto) {
    assertSchool(u, dto.schoolId);
    const tpl = await this.prisma.emailTemplate.findFirst({ where: { id: dto.templateId, schoolId: dto.schoolId, active: true } });
    if (!tpl) throw new BadRequestException('Unknown or inactive template');

    const provider = emailProvider();
    const results: Row[] = [];
    const logs: Prisma.EmailLogCreateManyInput[] = [];
    for (const t of await loadTargets(this.prisma, this.billing, dto.schoolId, dto.yearId, [...new Set(dto.enrollmentIds)])) {
      if (!t.e) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: 'Not enrolled in this school/year' }); continue; }
      const s = t.e.student;
      const to = [...new Set([s.email, s.fatherEmail, s.motherEmail].filter(validEmail).map((a) => a.trim().toLowerCase()))];
      if (!to.length) { results.push({ enrollmentId: t.id, status: 'SKIPPED', reason: 'No valid email address' }); continue; }
      const subject = render(tpl.subject, t.vars), text = render(tpl.body, t.vars);
      let ok = 0, lastErr = '';
      for (const address of to) {
        let status: 'SENT' | 'FAILED' = 'SENT', providerResponse: string;
        try { providerResponse = await provider.send(address, subject, text); ok++; }
        catch (err) { status = 'FAILED'; providerResponse = lastErr = err instanceof Error ? err.message : String(err); }
        logs.push({ schoolId: dto.schoolId, enrollmentId: t.id, address, subject, status, providerResponse });
      }
      results.push({ enrollmentId: t.id, status: ok ? 'SENT' : 'FAILED', sent: ok, ...(ok ? {} : { reason: lastErr }) });
    }
    if (logs.length) await this.prisma.emailLog.createMany({ data: logs });
    return { sent: results.filter((r) => r.status === 'SENT').length, results };
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('email/log')
  async log(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('from', new ParseDatePipe({ optional: true })) from?: Date,
    @Query('to', new ParseDatePipe({ optional: true })) to?: Date,
    @Query('status') status?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
    @Res({ passthrough: true }) res?: Response,
  ) {
    assertSchool(u, schoolId);
    if (status && !['QUEUED', 'SENT', 'FAILED'].includes(status)) throw new BadRequestException('Bad status');
    const where = {
      schoolId, ...(status ? { status: status as 'SENT' } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(+to + 864e5) } : {}) } } : {}),
    };
    // No limit = newest 500, as before; with limit/offset page through, X-Total-Count has the full match count.
    const [rows, total] = await Promise.all([
      this.prisma.emailLog.findMany({ where, orderBy: { id: 'desc' }, ...page(limit, offset, 500) }),
      this.prisma.emailLog.count({ where }),
    ]);
    res?.setHeader('X-Total-Count', total);
    return rows;
  }
}
