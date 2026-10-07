// RFC-4180 quoting; a leading = + - @ is prefixed with ' so spreadsheets don't run it as a formula.
const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Leading UTF-8 BOM so Excel reads non-Latin names correctly.
export const toCsv = (head: string[], rows: unknown[][]) => '\uFEFF' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
