import { billPdf, inWords } from './pdf.js';

describe('inWords', () => {
  it('uses Indian numbering', () => {
    expect(inWords(0)).toBe('Zero Rupees Only');
    expect(inWords(1510000)).toBe('Fifteen Thousand One Hundred Rupees Only');
    expect(inWords(1234567850)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees and Fifty Paise Only');
    expect(inWords(1900)).toBe('Nineteen Rupees Only');
  });
});

it('renders a PDF', async () => {
  const buf = await billPdf('Demo School 1', {
    student: { admissionNo: 'X-1', name: 'A', className: 'KG A' }, year: '2026-27', asOf: '2026-09-26',
    installments: [{ label: 'First', dueDate: new Date('2026-04-10'), charges: '100', fine: '0', fineDays: 0, paid: '0', due: '100' }],
    totals: { charges: '100', fine: '0', paid: '0', due: '100' },
  });
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
});
