import PDFDocument from 'pdfkit';

const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ones[r] : `${tens[Math.floor(r / 10)]} ${ones[r % 10]}`.trim();
  return [h ? `${ones[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}

// Indian numbering: 1,23,45,678 -> One Crore Twenty Three Lakh ...
export function inWords(paise: number): string {
  let n = Math.floor(paise / 100);
  const p = paise % 100;
  const parts: string[] = [];
  for (const [unit, size] of [['Crore', 1e7], ['Lakh', 1e5], ['Thousand', 1e3]] as const) {
    const q = Math.floor(n / size);
    // ponytail: crores above 999 read oddly ("One Thousand Crore"); fine for school fees.
    if (q) parts.push(`${unit === 'Crore' && q >= 1000 ? inWords(q * 100).replace(/ Rupees Only$/, '') : below1000(q)} ${unit}`);
    n %= size;
  }
  if (n) parts.push(below1000(n));
  const rupees = parts.join(' ') || 'Zero';
  return `${rupees} Rupees${p ? ` and ${below1000(p)} Paise` : ''} Only`;
}

const inr = (v: string | number) => `Rs. ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

type Col = { title: string; width: number; align?: 'left' | 'right' };

function toBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  draw(doc);
  doc.end();
  return done;
}

function header(doc: PDFKit.PDFDocument, school: string, title: string) {
  doc.font('Helvetica-Bold').fontSize(14).text(school, { align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#555').text(title, { align: 'center' }).fillColor('black').moveDown();
}

function fields(doc: PDFKit.PDFDocument, rows: [string, string][]) {
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(k, doc.page.margins.left, y, { width: 90 });
    doc.font('Helvetica').text(v, doc.page.margins.left + 95, y);
  }
  doc.moveDown(0.5);
}

function table(doc: PDFKit.PDFDocument, cols: Col[], rows: string[][], boldLast = false) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const line = (y: number) => doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke();
  const row = (cells: string[], bold: boolean) => {
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    cells.forEach((c, i) => {
      doc.text(c, x + 2, y, { width: cols[i].width - 4, align: cols[i].align ?? 'left' });
      x += cols[i].width;
    });
    doc.y = y + 16;
    doc.x = left;
  };
  line(doc.y);
  doc.moveDown(0.3);
  row(cols.map((c) => c.title), true);
  line(doc.y - 3);
  rows.forEach((r, i) => {
    if (boldLast && i === rows.length - 1) line(doc.y - 3);
    row(r, boldLast && i === rows.length - 1);
  });
  line(doc.y - 3);
  doc.moveDown(0.5);
}

export type ReceiptPdf = {
  receiptNo: number; date: Date; mode: string; reference: string | null; remarks: string | null; amount: string
  createdBy: string; cancelledAt: Date | null; cancelReason: string | null; clearStatus?: string
  student: { admissionNo: string; name: string }; year: string
  allocations: { installment: string; charges: string; fine: string }[]
};

export function receiptPdf(school: string, r: ReceiptPdf) {
  return toBuffer((doc) => {
    header(doc, school, `Fee Receipt · ${r.year}`);
    fields(doc, [
      ['Receipt No.', String(r.receiptNo)],
      ['Date', r.date.toISOString().slice(0, 10)],
      ['Student', `${r.student.name} (${r.student.admissionNo})`],
      ['Mode', r.reference ? `${r.mode.replace('_', ' ')} · ${r.reference}` : r.mode.replace('_', ' ')],
      ...(r.remarks ? [['Remarks', r.remarks] as [string, string]] : []),
    ]);
    table(doc, [{ title: 'Installment', width: 170 }, { title: 'Charges', width: 90, align: 'right' }, { title: 'Fine', width: 90, align: 'right' }],
      [...r.allocations.map((a) => [a.installment, inr(a.charges), inr(a.fine)]), ['Total', inr(r.amount), '']], true);
    doc.font('Helvetica-Oblique').text(inWords(Math.round(Number(r.amount) * 100))).moveDown(2);
    doc.font('Helvetica').fontSize(9).text(`Collected by ${r.createdBy}`, { align: 'right' });
    if (r.cancelledAt) {
      doc.fillColor('red').text(`Cancelled: ${r.cancelReason}`, { align: 'right' });
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .fontSize(48).fillColor('red', 0.25).text('CANCELLED', 60, doc.page.height / 2 - 30, { align: 'center' }).restore();
    } else if (r.clearStatus === 'BOUNCED') {
      // A bounced cheque no longer counts as paid, so its receipt must not look valid.
      doc.fillColor('red').text('Payment bounced: this receipt is not valid', { align: 'right' });
      doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .fontSize(48).fillColor('red', 0.25).text('BOUNCED', 60, doc.page.height / 2 - 30, { align: 'center' }).restore();
    }
  });
}

export type BillPdf = {
  student: { admissionNo: string; name: string; className: string }; year: string; asOf: string
  installments: { label: string; dueDate: Date; charges: string; fine: string; fineDays: number; paid: string; due: string }[]
  totals: { charges: string; fine: string; paid: string; due: string }
  arrear?: { amount: string; paid: string; due: string }
  bounce?: { amount: string; paid: string; due: string }
};

// Previous-year arrear shows as its own row so the installment rows still add up to the totals.
const arrearRow = (a: BillPdf['arrear'], n: (v: string) => string) =>
  a && Number(a.amount) > 0 ? [['Prev. arrear', '', n(a.amount), n('0'), n(a.paid), n(a.due)]] : [];
const bounceRow = (a: BillPdf['bounce'], n: (v: string) => string) =>
  a && Number(a.amount) > 0 ? [['Bounce charge', '', n(a.amount), n('0'), n(a.paid), n(a.due)]] : [];

export function billPdf(school: string, b: BillPdf) {
  return toBuffer((doc) => {
    header(doc, school, `Fee Statement · ${b.year} · as of ${b.asOf}`);
    fields(doc, [['Student', `${b.student.name} (${b.student.admissionNo})`], ['Class', b.student.className]]);
    const n = (v: string) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    table(doc, [
      // A5 usable width is 348pt.
      { title: 'Installment', width: 84 }, { title: 'Due', width: 54 }, { title: 'Charges', width: 56, align: 'right' },
      { title: 'Fine', width: 46, align: 'right' }, { title: 'Paid', width: 54, align: 'right' }, { title: 'Balance', width: 54, align: 'right' },
    ], [
      ...b.installments.map((i) => [i.label, i.dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }), n(i.charges), n(i.fine), n(i.paid), n(i.due)]),
      ...arrearRow(b.arrear, n),
      ...bounceRow(b.bounce, n),
      ['Total', '', n(b.totals.charges), n(b.totals.fine), n(b.totals.paid), n(b.totals.due)],
    ], true);
    doc.font('Helvetica-Bold').text(`Balance due: ${inr(b.totals.due)}`);
    doc.font('Helvetica-Oblique').fontSize(9).text(inWords(Math.round(Number(b.totals.due) * 100)));
  });
}

export type WithdrawalPdf = Omit<BillPdf, 'asOf'> & {
  date: Date; reason: string; remarks: string | null; excess: string; recordedBy: string
};

export function withdrawalPdf(school: string, w: WithdrawalPdf) {
  return toBuffer((doc) => {
    header(doc, school, `Withdrawal Settlement · ${w.year}`);
    fields(doc, [
      ['Student', `${w.student.name} (${w.student.admissionNo})`],
      ['Class', w.student.className],
      ['Withdrawn on', w.date.toISOString().slice(0, 10)],
      ['Reason', w.reason + (w.remarks ? ` - ${w.remarks}` : '')],
    ]);
    const n = (v: string) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    table(doc, [
      { title: 'Installment', width: 84 }, { title: 'Due', width: 54 }, { title: 'Charges', width: 56, align: 'right' },
      { title: 'Fine', width: 46, align: 'right' }, { title: 'Paid', width: 54, align: 'right' }, { title: 'Balance', width: 54, align: 'right' },
    ], [
      ...w.installments.map((i) => [i.label, i.dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }), n(i.charges), n(i.fine), n(i.paid), n(i.due)]),
      ...arrearRow(w.arrear, n),
      ...bounceRow(w.bounce, n),
      ['Total', '', n(w.totals.charges), n(w.totals.fine), n(w.totals.paid), n(w.totals.due)],
    ], true);
    doc.font('Helvetica-Bold').text(Number(w.totals.due) > 0 ? `Payable by family: ${inr(w.totals.due)}` : 'No dues payable.');
    if (Number(w.excess) > 0) doc.text(`Refundable to family (paid in advance): ${inr(w.excess)}`);
    doc.moveDown(2).font('Helvetica').fontSize(9).text(`Recorded by ${w.recordedBy}`, { align: 'right' });
  });
}
