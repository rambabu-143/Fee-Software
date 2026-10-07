import { StreamableFile } from '@nestjs/common';

// UTF-8 BOM: without it Excel opens Telugu/Hindi names as mojibake.
export const BOM = '\uFEFF';
const NUMERIC = /^-?\d+(\.\d+)?$/;

// One cell: quote when needed; neutralise spreadsheet formulas (=, +, -, @, tab, CR) in text with a leading '.
export function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ?format=csv -> a downloadable file; anything else -> the data untouched (JSON).
export function respond<T extends Record<string, unknown>>(rows: T[], format: string | undefined, name: string, columns?: string[]) {
  if (format !== 'csv') return rows;
  return new StreamableFile(Buffer.from(BOM + toCsv(rows, columns)), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}.csv"` });
}
