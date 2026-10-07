import { BadRequestException, Body, Controller, Get, Param, Patch, ParseIntPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { ClearStatus, PaymentMode } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertSchool, CurrentUser, Roles, type AuthUser } from '../auth/auth.guard.js';
import { fromPaise, toPaise } from '../billing/bill.js';
import { reportPdf } from './banking-pdf.js';
import { toCsv } from './csv.js';

class CreateBankDto {
  @IsInt() schoolId: number;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() accountNo?: string;
  @IsOptional() @IsString() ifsc?: string;
}

class UpdateBankDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() accountNo?: string;
  @IsOptional() @IsString() ifsc?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

const today = () => new Date(new Date().toISOString().slice(0, 10));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');
const day = (s: string | undefined, name: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(+d)) throw new BadRequestException(`Bad ${name} date`);
  return d;
};
const sum = (a: { toString(): string }[]) => a.reduce<number>((s, x) => s + toPaise(x.toString()), 0);

@Controller()
export class BanksController {
  constructor(private prisma: PrismaService) {}

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('banks')
  async list(@CurrentUser() u: AuthUser, @Query('schoolId', ParseIntPipe) schoolId: number) {
    assertSchool(u, schoolId);
    return this.prisma.bank.findMany({ where: { schoolId }, orderBy: { name: 'asc' } });
  }

  @Roles('ADMIN')
  @Post('banks')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateBankDto) {
    assertSchool(u, dto.schoolId);
    return this.prisma.bank.create({ data: { ...dto, name: dto.name.trim() } });
  }

  // No delete: receipts point at banks. Deactivate instead.
  @Roles('ADMIN')
  @Patch('banks/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBankDto) {
    const b = await this.prisma.bank.findUniqueOrThrow({ where: { id } });
    assertSchool(u, b.schoolId);
    return this.prisma.bank.update({ where: { id }, data: dto });
  }

  // Receipts by the date the bank credited them (falls back to the receipt date until then).
  // Valid receipts and bounced ones are listed; bounced rows are flagged and left out of the totals.
  @Get('reports/banking')
  async banking(
    @CurrentUser() u: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('mode') mode?: string,
    @Query('bankId', new ParseIntPipe({ optional: true })) bankId?: number,
    @Query('status') status?: string,
    @Query('pdf') pdf?: string,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    if (mode && !(mode in PaymentMode)) throw new BadRequestException('Bad mode');
    if (status && !(status in ClearStatus)) throw new BadRequestException('Bad status');
    const f = day(from, 'from'), t = day(to, 'to');
    const win = { ...(f && { gte: f }), ...(t && { lte: t }) };
    const payments = await this.prisma.payment.findMany({
      where: {
        schoolId, yearId, ...(mode ? { mode: mode as PaymentMode } : {}), ...(bankId ? { bankId } : {}),
        ...(status ? { clearStatus: status as ClearStatus } : {}),
        AND: [
          { OR: [{ cancelledAt: null }, { clearStatus: 'BOUNCED' }] },
          ...(f || t ? [{ OR: [{ bankDate: win }, { bankDate: null, date: win }] }] : []),
        ],
      },
      include: { student: { select: { admissionNo: true, name: true } }, bank: { select: { name: true } }, allocations: { select: { fine: true } } },
      orderBy: [{ date: 'asc' }, { receiptNo: 'asc' }],
      take: 5000, // ponytail: cap instead of pagination
    });
    const rows = payments.map((p) => ({
      receiptNo: p.receiptNo, studentName: p.student.name, admissionNo: p.student.admissionNo, mode: p.mode,
      bank: p.bank?.name ?? null, chequeNo: p.chequeNo, receiptDate: ymd(p.date), bankDate: p.bankDate ? ymd(p.bankDate) : null,
      amount: p.amount.toFixed(2), fine: fromPaise(sum(p.allocations.map((a) => a.fine))), status: p.clearStatus,
      // future-dated cheque or bounced: shown, but flagged
      flag: p.clearStatus === 'BOUNCED' ? 'BOUNCED' : p.chequeDate && p.chequeDate > today() ? 'FUTURE_CHEQUE' : null,
    }));
    const valid = rows.filter((r) => r.status !== 'BOUNCED');
    const totals = { count: valid.length, amount: fromPaise(sum(valid.map((r) => r.amount))), fine: fromPaise(sum(valid.map((r) => r.fine))) };

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return toCsv(
        ['Receipt No', 'Admission No', 'Student', 'Mode', 'Bank', 'Cheque No', 'Receipt Date', 'Bank Date', 'Amount', 'Fine', 'Status', 'Flag'],
        rows.map((r) => [r.receiptNo, r.admissionNo, r.studentName, r.mode, r.bank, r.chequeNo, r.receiptDate, r.bankDate ?? '', r.amount, r.fine, r.status, r.flag ?? '']),
      );
    }
    if (pdf) {
      const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
      const buf = await reportPdf(
        school.name, `Banking ${mode ? mode.replace('_', ' ') : 'All'} Receipt Report`, `${from ?? 'start'} to ${to ?? 'today'}`,
        [{ title: 'Rcpt', width: 40 }, { title: 'Adm. No.', width: 65 }, { title: 'Student', width: 140 }, { title: 'Mode', width: 70 }, { title: 'Bank', width: 100 },
          { title: 'Cheque', width: 65 }, { title: 'Received', width: 60 }, { title: 'Bank date', width: 60 }, { title: 'Amount', width: 70, align: 'right' },
          { title: 'Fine', width: 55, align: 'right' }, { title: 'Status', width: 60 }],
        rows.map((r) => [String(r.receiptNo), r.admissionNo, r.studentName, r.mode, r.bank ?? '-', r.chequeNo ?? '-', r.receiptDate, r.bankDate ?? '-', r.amount, r.fine, r.flag ?? r.status]),
        ['', '', '', '', '', '', '', 'Total', totals.amount, totals.fine, ''],
      );
      res.setHeader('Content-Type', 'application/pdf');
      return new StreamableFile(buf, { disposition: 'inline; filename="banking.pdf"' });
    }
    return { rows, totals };
  }

  // Fine collected per valid receipt (fine lives on each receipt's allocations; there is no separate fine receipt).
  @Get('reports/fines')
  async fines(
    @CurrentUser() u: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('schoolId', ParseIntPipe) schoolId: number,
    @Query('yearId', ParseIntPipe) yearId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: string,
  ) {
    assertSchool(u, schoolId);
    const f = day(from, 'from'), t = day(to, 'to');
    const payments = await this.prisma.payment.findMany({
      where: { schoolId, yearId, cancelledAt: null, clearStatus: { not: 'BOUNCED' }, ...(f || t ? { date: { ...(f && { gte: f }), ...(t && { lte: t }) } } : {}) },
      include: { student: { select: { admissionNo: true, name: true } }, allocations: { select: { fine: true } } },
      orderBy: [{ date: 'asc' }, { receiptNo: 'asc' }], take: 5000,
    });
    const rows = payments
      .map((p) => ({ receiptNo: p.receiptNo, date: ymd(p.date), admissionNo: p.student.admissionNo, studentName: p.student.name, mode: p.mode, fine: sum(p.allocations.map((a) => a.fine)) }))
      .filter((r) => r.fine > 0)
      .map((r) => ({ ...r, fine: fromPaise(r.fine) }));
    const totals = { count: rows.length, fine: fromPaise(sum(rows.map((r) => r.fine))) };
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return toCsv(['Receipt No', 'Date', 'Admission No', 'Student', 'Mode', 'Fine'], rows.map((r) => [r.receiptNo, r.date, r.admissionNo, r.studentName, r.mode, r.fine]));
    }
    return { rows, totals };
  }
}
