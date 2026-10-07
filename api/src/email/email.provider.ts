import { Logger } from '@nestjs/common';

export interface EmailProvider {
  send(to: string, subject: string, text: string): Promise<string>;
}

const log = new Logger('Email');
const stub: EmailProvider = { send: async (to, subject) => { log.debug(`[stub] to ${to}: ${subject}`); return 'stub'; } };

// Default = stub (log only). Real SMTP needs SMTP_HOST (+ SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM) AND the
// nodemailer package, which this project does NOT depend on yet: without it every row is FAILED with a clear reason.
// ponytail: `npm i nodemailer` + set SMTP_* to go live; plain-text bodies only (no HTML, so nothing to sanitise).
export function emailProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  if (!host) return stub;
  return {
    async send(to, subject, text) {
      const pkg = 'nodemailer'; // variable so TS/bundlers don't require the package
      const nm = await import(pkg).catch(() => { throw new Error('SMTP_HOST is set but nodemailer is not installed'); });
      const t = nm.createTransport({
        host, port: Number(process.env.SMTP_PORT ?? 587),
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      const r = await t.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, text });
      return String(r.messageId ?? 'sent');
    },
  };
}

// Rejects the legacy placeholders ("NA", "N/A") and anything not shaped like an address.
export const validEmail = (s: string | null | undefined): s is string => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
