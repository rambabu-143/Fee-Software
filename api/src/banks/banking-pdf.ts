import PDFDocument from 'pdfkit';

const inr = (v: string) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });

// Landscape A4 table shared by the banking and fine reports: pass the columns and rows you want.
export function reportPdf(
  school: string, title: string, sub: string,
  cols: { title: string; width: number; align?: 'left' | 'right' }[], rows: string[][], footer: string[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  doc.font('Helvetica-Bold').fontSize(14).text(school, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).text(title, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#555').text(sub, { align: 'center' }).fillColor('black').moveDown();
  const row = (cells: string[], bold = false) => {
    if (doc.y > doc.page.height - 50) doc.addPage();
    const y = doc.y;
    let x = doc.page.margins.left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    cells.forEach((c, i) => { doc.text(c, x + 2, y, { width: cols[i].width - 4, align: cols[i].align ?? 'left' }); x += cols[i].width; });
    doc.y = y + 14;
  };
  row(cols.map((c) => c.title), true);
  rows.forEach((r) => row(r));
  row(footer, true);
  doc.end();
  return done;
}

export { inr };
