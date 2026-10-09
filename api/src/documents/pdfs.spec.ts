import { dobWords, dmy, nextClassName, concessionFormPdf } from './pdfs.js';

describe('dobWords', () => {
  it('spells dates in words', () => {
    expect(dobWords('2010-03-05')).toBe('Fifth March Two Thousand Ten');
    expect(dobWords(new Date('1999-12-31'))).toBe('Thirty First December Nineteen Ninety Nine');
    expect(dobWords('2000-01-01')).toBe('First January Two Thousand');
  });
  it('does not crash on missing or bad dates', () => {
    expect(dobWords(null)).toBe('-');
    expect(dobWords('nonsense')).toBe('-');
    expect(dmy(undefined)).toBe('-');
    expect(dmy('2010-03-05')).toBe('05-03-2010');
  });
});

describe('nextClassName (legacy Nursery -> Prep -> I ... XII -> XII ladder, from the school\'s own order)', () => {
  const ladder = ['Nursery', 'Prep', 'I', 'II', 'XII'].map((name, sortOrder) => ({ name, sortOrder }));
  it('moves to the next class', () => {
    expect(nextClassName(ladder, 'Nursery')).toBe('Prep');
    expect(nextClassName(ladder, 'II')).toBe('XII');
  });
  it('keeps the last class, matches case-insensitively, ignores insertion order', () => {
    expect(nextClassName(ladder, 'XII')).toBe('XII');
    expect(nextClassName([...ladder].reverse(), ' nursery ')).toBe('Prep');
  });
  it('returns null for an unknown class', () => {
    expect(nextClassName(ladder, 'Class 99')).toBeNull();
    expect(nextClassName([], 'Nursery')).toBeNull();
  });
});

describe('concessionFormPdf', () => {
  const base = {
    school: { name: 'S', address: null, affiliationNo: null, schoolNo: null, kind: 'SENIOR' }, year: '2026-27', className: 'Nursery A',
    s: { admissionNo: 'A1', name: 'kid', dob: null, fatherName: null, motherName: null, phone: null, address: null, aadhaar: null },
    nextSession: '2027-28', officeSession: '2026-27', classTeacher: null, lastDate: '2027-01-31', concessions: [],
  };
  it('renders with and without a next class', async () => {
    for (const nextClass of ['Prep', null]) {
      const buf = await concessionFormPdf({ ...base, nextClass } as never);
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});
