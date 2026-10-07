import { toCsv } from './csv.js';

describe('toCsv', () => {
  it('quotes commas/quotes/newlines and neutralises formulas but keeps negative numbers', () => {
    const out = toCsv([{ a: 'x,y', b: 'say "hi"', c: '=1+1', d: -5, e: '-5.00', f: '@cmd', g: 'a\nb', h: null }]);
    expect(out).toBe('a,b,c,d,e,f,g,h\r\n"x,y","say ""hi""",\'=1+1,-5,-5.00,\'@cmd,"a\nb",\r\n');
  });
});
