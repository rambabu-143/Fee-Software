import { dobWords, dmy } from './pdfs.js';

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
