import { defaulterLetterPdf, hasGreeting } from './letter-pdf.js';

describe('defaulter letter greeting', () => {
  it('detects a greeting the template already has', () => {
    for (const b of ['Dear Parent,\nPay now', '  dear Sir/Madam,', 'DEAR {parent},']) expect(hasGreeting(b)).toBe(true);
  });
  it('does not mistake other openings for a greeting', () => {
    for (const b of ['Your ward has dues', 'We, dear parents, remind you', 'Dearborn Street fees', '']) expect(hasGreeting(b)).toBe(false);
  });
  it('still renders a PDF for both kinds of body', async () => {
    const l = { parent: 'R. Rao', date: '01-01-2027', student: 'Asha', admissionNo: 'A-1' };
    const pdf = await defaulterLetterPdf('Demo School', [{ ...l, body: 'Dear Parent,\nPlease pay.' }, { ...l, body: 'Please pay.' }]);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
