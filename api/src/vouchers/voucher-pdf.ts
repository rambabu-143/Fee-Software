import PDFDocument from 'pdfkit';
import { inWords } from '../billing/pdf.js';

const inr = (v: string | number) => `Rs. ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const label = (s: string) => s.replace(/_/g, ' ');

function render(size: 'A5' | 'A4', draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size, margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  draw(doc);
  doc.end();
  return done;
}

export type VoucherPdf = {
  voucherNo: number; date: Date; kind: string; amount: string; mode: string; reference: string | null; remarks: string | null
  createdBy: string; cancelledAt: Date | null; cancelReason: string | null
  student: { admissionNo: string; name: string }; className: string; year: string
};

export function voucherPdf(school: string, v: VoucherPdf) {
  return render('A5', (doc) => {
    doc.font('Helvetica-Bold').fontSize(14).text(school, { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`Payment Voucher · ${v.year}`, { align: 'center' }).fillColor('black').moveDown();
    for (const [k, val] of [
      ['Voucher No.', String(v.voucherNo)], ['Date', ymd(v.date)], ['Student', `${v.student.name} (${v.student.admissionNo})`],
      ['Class', v.className], ['Purpose', label(v.kind)],
      ['Mode', v.reference ? `${label(v.mode)} · ${v.reference}` : label(v.mode)], ...(v.remarks ? [['Remarks', v.remarks]] : []),
    ] as [string, string][]) {
      const y = doc.y;
      doc.font('Helvetica-Bold').text(k, doc.page.margins.left, y, { width: 90 });
      doc.font('Helvetica').text(val, doc.page.margins.left + 95, y);
    }
    doc.moveDown().font('Helvetica-Bold').fontSize(12).text(`Amount paid: ${inr(v.amount)}`);
    doc.font('Helvetica-Oblique').fontSize(10).text(inWords(Math.round(Number(v.amount) * 100))).moveDown(3);
    doc.font('Helvetica').fontSize(9).text(`Issued by ${v.createdBy}`, { align: 'right' });
    if (v.cancelledAt) {
      doc.fillColor('red').text(`Cancelled: ${v.cancelReason}`, { align: 'right' });
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .fontSize(48).fillColor('red', 0.25).text('CANCELLED', 60, doc.page.height / 2 - 30, { align: 'center' }).restore();
    }
  });
}

export type VoucherReportRow = { voucherNo: number; date: Date; admissionNo: string; name: string; className: string; kind: string; mode: string; amount: string; cancelled: boolean };

// Register of vouchers (the legacy "Withdrawal Voucher Report"); cancelled rows are listed but not totalled.
export function voucherReportPdf(school: string, title: string, rows: VoucherReportRow[], total: string) {
  return render('A4', (doc) => {
    doc.font('Helvetica-Bold').fontSize(14).text(school, { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(title, { align: 'center' }).fillColor('black').moveDown();
    const cols = [[40, 'No.'], [62, 'Date'], [70, 'Adm. No.'], [120, 'Student'], [70, 'Class'], [80, 'Purpose'], [60, 'Amount']] as const;
    const row = (cells: string[], bold = false) => {
      if (doc.y > doc.page.height - 70) doc.addPage();
      const y = doc.y;
      let x = doc.page.margins.left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cells.forEach((c, i) => { doc.text(c, x + 2, y, { width: cols[i][0] - 4, align: i === 6 ? 'right' : 'left' }); x += cols[i][0]; });
      doc.y = y + 14;
    };
    row(cols.map((c) => c[1]), true);
    for (const r of rows) {
      row([String(r.voucherNo), ymd(r.date), r.admissionNo, r.name, r.className, label(r.kind), r.cancelled ? 'cancelled' : inr(r.amount)]);
    }
    row(['', '', '', '', '', 'Total', inr(total)], true);
  });
}
