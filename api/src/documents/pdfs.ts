import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';
import { inWords } from '../billing/pdf.js';

export type SchoolHead = { name: string; address?: string | null; affiliationNo?: string | null; schoolNo?: string | null; kind?: 'SENIOR' | 'JUNIOR' };
type KV = [string, string | null | undefined];

const dash = (v?: string | null) => (v && v.trim() ? v : '-');
export const dmy = (iso?: string | Date | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(+d) ? '-' : `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
};
const inr = (v: string | number) => `Rs. ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// "Fifth March Two Thousand Ten". "-" when missing.
const w = (n: number) => (n === 0 ? 'Zero' : inWords(n * 100).replace(/ Rupees Only$/, ''));
const ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth',
  'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth', 'Twentieth', 'Twenty First',
  'Twenty Second', 'Twenty Third', 'Twenty Fourth', 'Twenty Fifth', 'Twenty Sixth', 'Twenty Seventh', 'Twenty Eighth',
  'Twenty Ninth', 'Thirtieth', 'Thirty First'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function dobWords(iso?: string | Date | null) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(+d)) return '-';
  const y = d.getUTCFullYear(), r = y % 100;
  // ponytail: 1905 reads "Nineteen Five"; fine for school-age DOBs (2000s).
  const year = y >= 2000 ? `Two Thousand${r ? ' ' + w(r) : ''}` : `${w(Math.floor(y / 100))} ${r ? w(r) : 'Hundred'}`;
  return `${ORD[d.getUTCDate()]} ${MONTHS[d.getUTCMonth()]} ${year}`;
}

function a4(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  draw(doc);
  doc.end();
  return done;
}

function head(doc: PDFKit.PDFDocument, s: SchoolHead, title: string) {
  doc.font('Helvetica-Bold').fontSize(16).text(s.name, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#555');
  if (s.address) doc.text(s.address, { align: 'center' });
  const ids = [s.affiliationNo && `Affiliation No. ${s.affiliationNo}`, s.schoolNo && `School No. ${s.schoolNo}`].filter(Boolean).join('   ');
  if (ids) doc.text(ids, { align: 'center' });
  doc.fillColor('black').moveDown().font('Helvetica-Bold').fontSize(13).text(title, { align: 'center', underline: true }).moveDown();
  doc.font('Helvetica').fontSize(10.5);
}

// Label / value rows; numbered=true prefixes "1." like the paper TC.
function rows(doc: PDFKit.PDFDocument, list: KV[], numbered = false, labelW = 230) {
  const left = doc.page.margins.left;
  list.forEach(([k, v], i) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(`${numbered ? `${i + 1}. ` : ''}${k}`, left, y, { width: labelW });
    const afterLabel = doc.y;
    doc.font('Helvetica').text(dash(v), left + labelW + 10, y, { width: doc.page.width - left - doc.page.margins.right - labelW - 10 });
    doc.y = Math.max(afterLabel, doc.y) + 4;
  });
  doc.x = left;
}

const sign = (doc: PDFKit.PDFDocument, labels: string[]) => {
  doc.moveDown(3);
  const y = doc.y, left = doc.page.margins.left, span = (doc.page.width - left * 2) / labels.length;
  labels.forEach((l, i) => doc.text(l, left + span * i, y, { width: span, align: i === labels.length - 1 ? 'right' : i ? 'center' : 'left' }));
};

// ---- Transfer certificate -------------------------------------------------

export type TcData = {
  school: SchoolHead; serialNo: number; duplicate: boolean; year: string
  p: Record<string, string | number | null | undefined> // issue-time fields + student snapshot, see controller
};

export function tcPdf({ school, serialNo, duplicate, year, p }: TcData) {
  const junior = school.kind === 'JUNIOR';
  const s = (k: string) => (p[k] == null ? null : String(p[k]));
  return a4((doc) => {
    head(doc, school, duplicate ? 'TRANSFER CERTIFICATE (DUPLICATE)' : 'TRANSFER CERTIFICATE');
    doc.text(`Sl. No. ${serialNo}`, { align: 'left' }).text(`Admission No. ${dash(s('admissionNo'))}`, { align: 'left' }).moveDown(0.5);
    rows(doc, [
      ['Name of the pupil', s('name')],
      ["Mother's name", s('motherName')],
      ["Father's / Guardian's name", s('fatherName')],
      ['Nationality', s('nationality')],
      ['Date of birth (in figures)', dmy(s('dob'))],
      ['Date of birth (in words)', dobWords(s('dob'))],
      ['Date of admission', dmy(s('admissionDate'))],
      ['Class in which last studied', s('class')],
      ...(junior ? [] : ([
        ['Board / last examination', s('board')],
        ['Whether qualified for promotion to higher class', s('higherClass')],
        ['Subjects studied', s('combo')],
        ['Month up to which fees are paid', s('monthDuePaid')],
        ['Total working days', s('totalWorkDays')],
        ['Total days present', s('totalWorkPresent')],
      ] as KV[])),
      ['General conduct', s('generalConduct')],
      ['Date of leaving the school', dmy(s('dateOfWithdrawal'))],
      ['Reason for leaving', s('leavingReason')],
      ['PEN', s('penNo')],
      ...(junior ? [] : ([['CBSE registration no.', s('cbseRegNo')]] as KV[])),
      ['Academic session', year],
      ['Date of issue', dmy(s('dateOfIssue'))],
    ], true);
    sign(doc, ['Prepared by', `Checked by: ${dash(s('staffName'))}`, 'Principal']);
  });
}

// ---- Fee-paid (income-tax) certificate --------------------------------------

export type FeeCertData = {
  school: SchoolHead; year: string
  student: { admissionNo: string; name: string; fatherName: string | null; motherName: string | null; className: string }
  lines: { date: string; receiptNo: number; mode: string; installments: string; charges: string; fine: string; amount: string }[]
  total: string
}

export function feeCertPdf(d: FeeCertData) {
  return a4((doc) => {
    head(doc, d.school, `FEE CERTIFICATE · ${d.year}`);
    doc.text(`This is to certify that ${d.student.name} (Admission No. ${d.student.admissionNo}), ${d.student.className}, ` +
      `ward of ${dash(d.student.fatherName ?? d.student.motherName)}, has paid the following fees to the school during the academic session ${d.year}.`, { align: 'justify' }).moveDown();
    const left = doc.page.margins.left;
    const widths = [62, 48, 62, 115, 70, 55, 83]; // 495pt = A4 usable width
    const line = (cells: string[], bold = false) => {
      if (doc.y > doc.page.height - 120) doc.addPage();
      const y = doc.y;
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      cells.forEach((c, i) => { doc.text(c, x + 2, y, { width: widths[i] - 4, align: i >= 4 ? 'right' : 'left' }); x += widths[i]; });
      doc.y = y + (cells[3].length > 22 ? 24 : 15);
      doc.x = left;
    };
    line(['Date', 'Receipt', 'Mode', 'Installments', 'Charges', 'Fine', 'Total'], true);
    d.lines.forEach((l) => line([dmy(l.date), String(l.receiptNo), l.mode.replace('_', ' '), l.installments, inr(l.charges).slice(4), inr(l.fine).slice(4), inr(l.amount).slice(4)]));
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).text(`Total fees paid: ${inr(d.total)}`);
    doc.font('Helvetica-Oblique').fontSize(10).text(inWords(Math.round(Number(d.total) * 100)));
    sign(doc, ['Date: ' + dmy(new Date()), 'Accountant', 'Principal']);
  });
}

// ---- Admission forms / certificate -----------------------------------------

export type StudentForm = {
  school: SchoolHead; year: string; className: string
  s: { admissionNo: string; name: string; gender?: string | null; nationality?: string | null; dob?: Date | null; address?: string | null
    fatherName?: string | null; motherName?: string | null; phone?: string | null; email?: string | null; aadhaar?: string | null; admissionDate?: Date | null }
}

const title = (v?: string | null) => (v ? v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : null);

export function admissionFormPdf({ school, year, className, s }: StudentForm) {
  return a4((doc) => {
    head(doc, school, `ADMISSION FORM · ${year}`);
    rows(doc, [
      ['Admission No.', s.admissionNo], ['Name of the pupil', title(s.name)], ['Class', className], ['Gender', s.gender],
      ['Nationality', s.nationality], ['Date of birth (figures)', dmy(s.dob)], ['Date of birth (words)', dobWords(s.dob)],
      ['Address', s.address],
    ], false, 170);
    doc.moveDown().font('Helvetica-Bold').text('To be filled in by the parent').font('Helvetica');
    const blank = (l: string, v?: string | null) => rows(doc, [[l, v ?? '______________________________']], false, 170);
    blank("Father's name", title(s.fatherName)); blank("Mother's name", title(s.motherName));
    blank('Mother tongue'); blank('Religion'); blank('Occupation / designation'); blank('Contact number', s.phone); blank('E-mail', s.email);
    sign(doc, ["Parent's signature", 'Date', 'Principal']);
  });
}

export function admissionCertPdf({ school, year, className, s }: StudentForm) {
  return a4((doc) => {
    head(doc, school, 'ADMISSION CERTIFICATE');
    doc.text(`This is to certify that ${title(s.name)} has been admitted to ${className} of this school for the academic session ${year}.`, { align: 'justify' }).moveDown();
    rows(doc, [['Admission No.', s.admissionNo], ['Class', className], ['Date of admission', dmy(s.admissionDate)], ['Session', year]], false, 170);
    doc.moveDown().font('Helvetica-Oblique').text('Issued by Fee Office');
    sign(doc, ['Date: ' + dmy(new Date()), '', 'Principal']);
  });
}

export type ConcessionForm = StudentForm & {
  nextSession: string; officeSession: string; classTeacher: string | null; lastDate: string
  concessions: { head: string; text: string; category: string | null }[]
}

export function concessionFormPdf(f: ConcessionForm) {
  return a4((doc) => {
    head(doc, f.school, `CONCESSION RE-APPLICATION · session ${f.nextSession}`);
    rows(doc, [
      ['Name of the pupil', title(f.s.name)], ['Admission No.', f.s.admissionNo], ['Date of birth', dmy(f.s.dob)],
      ['Aadhaar', f.s.aadhaar], ['Present class', f.className], ['Class teacher', f.classTeacher],
      ["Father's name", title(f.s.fatherName)], ["Mother's name", title(f.s.motherName)],
      ['Mobile', f.s.phone], ['Address', f.s.address],
      ['Current concession', f.concessions.map((c) => `${c.head}: ${c.text}${c.category ? ` (${c.category})` : ''}`).join('; ')],
    ], false, 150);
    doc.moveDown().text(`Please submit this form to the office on or before ${dmy(f.lastDate)} if you wish to continue the concession in session ${f.nextSession}.`, { align: 'justify' });
    sign(doc, ["Parent's signature", `Office session: ${f.officeSession}`, 'Principal']);
  });
}

// ---- zip ---------------------------------------------------------------------

export function zip(files: { name: string; buf: Buffer | string }[]): Promise<Buffer> {
  return new Promise((res, rej) => {
    const z = new ZipArchive();
    const chunks: Buffer[] = [];
    z.on('data', (c: Buffer) => chunks.push(c)).on('end', () => res(Buffer.concat(chunks))).on('error', rej);
    files.forEach((f) => z.append(f.buf, { name: f.name }));
    void z.finalize();
  });
}
