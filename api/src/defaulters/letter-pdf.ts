import PDFDocument from 'pdfkit';

export type Letter = { parent: string; body: string; date: string; student: string; admissionNo: string };

// One A4 page per student: letterhead, address block, subject, body, signature lines.
export function defaulterLetterPdf(school: string, letters: Letter[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  letters.forEach((l, i) => {
    if (i) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(16).text(school, { align: 'center' });
    doc.moveTo(56, doc.y + 4).lineTo(doc.page.width - 56, doc.y + 4).lineWidth(0.5).stroke();
    doc.moveDown(2).font('Helvetica').fontSize(11);
    doc.text(`Date: ${l.date}`, { align: 'right' }).moveDown();
    doc.text('To,').text(l.parent).text(`Parent of ${l.student} (Adm. No. ${l.admissionNo})`).moveDown();
    doc.font('Helvetica-Bold').text('Subject: Reminder for payment of school fees').moveDown().font('Helvetica');
    doc.text(`Dear ${l.parent},`).moveDown();
    doc.text(l.body, { align: 'justify', lineGap: 3 }).moveDown(4);
    doc.text('Principal / Fee Office', { align: 'right' }).moveDown(2);
    doc.text('Signature of parent: ______________________      Date: ______________');
  });
  doc.end();
  return done;
}
