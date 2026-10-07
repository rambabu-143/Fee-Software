import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseDatePipe, ParseIntPipe, Post, Put,
  Query, Res, StreamableFile,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { fmtDate, render } from '../notify/notify.js';
import { DefaultersService, SCOPES } from './defaulters.service.js';
import { defaulterLetterPdf } from './letter-pdf.js';

const MAX_LETTERS = 500;

class TemplateDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  // Placeholders: {parent} {student} {admissionNo} {class} {due} {since} {date}
  @IsString() @MinLength(10) @MaxLength(4000) body: string;
}
class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(4000) body?: string;
}

class LettersDto {
  @IsInt() schoolId: number;
  @IsInt() yearId: number;
  @IsInt() templateId: number;
  @IsOptional() @IsDateString() asOf?: string;
  @IsOptional() @IsString() @MaxLength(50) since?: string;
  @IsOptional() @IsIn([...SCOPES]) scope?: (typeof SCOPES)[number];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_LETTERS) @IsInt({ each: true }) studentIds: number[];
}

@Controller('defaulters')
export class DefaultersController {
  constructor(
    private prisma: PrismaService,
    private svc: DefaultersService,
  ) {}

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('asOf', new ParseDatePipe({ optional: true })) asOf?: Date,
    @Query('standardId', new ParseIntPipe({ optional: true })) standardId?: number,
    @Query('sectionId', new ParseIntPipe({ optional: true })) sectionId?: number,
    @Query('minDue') minDue?: string,
    @Query('scope') scope?: string,
    @Query('contacts') contacts?: string,
  ) {
    assertSchool(u, schoolId);
    if (minDue !== undefined && !(Number(minDue) >= 0)) throw new BadRequestException('minDue must be a number >= 0');
    const rows = await this.svc.find({ schoolId, yearId, asOf, standardId, sectionId, minDue: minDue === undefined ? undefined : Number(minDue), scope: DefaultersService.parseScope(scope) });
    const extra = contacts === 'true' ? new Map((await this.svc.contacts(rows.map((r) => r.studentId))).map((c) => [c.id, c])) : null;
    return rows.map(({ sortOrder: _s, overduePaise: _p, ...r }) => (extra ? { ...r, contacts: extra.get(r.studentId) } : r));
  }

  // One page per student. Dues are recomputed now, so anyone who has paid since the list was built is skipped.
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('letters')
  async letters(@CurrentUser() u: AuthUser, @Body() dto: LettersDto, @Res({ passthrough: true }) res: Response) {
    assertSchool(u, dto.schoolId);
    const [tpl, school] = await Promise.all([
      this.prisma.defaulterLetterTemplate.findFirst({ where: { id: dto.templateId, schoolId: dto.schoolId } }),
      this.prisma.school.findUniqueOrThrow({ where: { id: dto.schoolId } }),
    ]);
    if (!tpl) throw new BadRequestException('Unknown template');
    const asOf = dto.asOf ? new Date(dto.asOf) : new Date();
    const ids = [...new Set(dto.studentIds)];
    const rows = await this.svc.find({ schoolId: dto.schoolId, yearId: dto.yearId, asOf, studentIds: ids, scope: dto.scope });
    if (!rows.length) throw new BadRequestException('None of the selected students owes anything now');
    const contacts = new Map((await this.svc.contacts(rows.map((r) => r.studentId))).map((c) => [c.id, c]));

    const date = fmtDate(new Date());
    const pdf = await defaulterLetterPdf(school.name, rows.map((r) => {
      const c = contacts.get(r.studentId);
      const parent = c?.fatherName || c?.motherName || 'Parent / Guardian';
      return {
        parent, date, student: r.name, admissionNo: r.admissionNo,
        body: render(tpl.body, { parent, student: r.name, admissionNo: r.admissionNo, class: r.className, due: r.overdue, since: dto.since || '____', date }),
      };
    }));
    await this.prisma.defaulterNotice.createMany({
      data: rows.map((r) => ({
        schoolId: dto.schoolId, enrollmentId: r.enrollmentId, kind: 'LETTER', scope: dto.scope ?? 'FEE',
        dueAmount: r.overdue, asOf, createdBy: u.username,
      })),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="defaulter-letters.pdf"');
    res.setHeader('X-Letters', String(rows.length));
    res.setHeader('X-Skipped', String(ids.length - rows.length));
    return new StreamableFile(pdf);
  }

  @Get('notices')
  async notices(
    @CurrentUser() u: AuthUser,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('enrollmentId', new ParseIntPipe({ optional: true })) enrollmentId?: number,
  ) {
    assertSchool(u, schoolId);
    const rows = await this.prisma.defaulterNotice.findMany({
      where: { schoolId, ...(enrollmentId ? { enrollmentId } : {}) },
      orderBy: { id: 'desc' },
      take: 500, // ponytail: cap instead of pagination
    });
    return rows.map((n) => ({ ...n, dueAmount: n.dueAmount.toFixed(2) }));
  }
}

@Controller('defaulter-templates')
export class DefaulterTemplatesController {
  constructor(private prisma: PrismaService) {}

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.defaulterLetterTemplate.findMany({ where: { schoolId }, orderBy: { id: 'asc' } });
  }

  @Roles('ADMIN')
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: TemplateDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.defaulterLetterTemplate.create({ data: dto });
  }

  private async owned(u: AuthUser, id: number) {
    const t = await this.prisma.defaulterLetterTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    assertSchool(u, t.schoolId);
  }

  @Roles('ADMIN')
  @Put(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTemplateDto) {
    await this.owned(u, id);
    return this.prisma.defaulterLetterTemplate.update({ where: { id }, data: dto });
  }

  @Roles('ADMIN')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.owned(u, id);
    return this.prisma.defaulterLetterTemplate.delete({ where: { id } });
  }
}
