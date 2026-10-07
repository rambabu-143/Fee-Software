import { Logger } from '@nestjs/common';

export interface SmsProvider {
  send(number: string, body: string): Promise<string>; // returns the provider's response text
}

const log = new Logger('SMS');
const stub: SmsProvider = { send: async (n, b) => { log.debug(`[stub] to ${n}: ${b}`); return 'stub'; } };

// SMS_PROVIDER unset or "stub" = log only, nothing leaves the machine.
// ponytail: no real gateway yet (needs Textlocal/MSG91 credentials + India DLT sender/template ids);
// any other value fails each row loudly instead of pretending to send. Add a class here when credentials exist.
export function smsProvider(): SmsProvider {
  const name = process.env.SMS_PROVIDER ?? 'stub';
  return name === 'stub' ? stub : { send: async () => { throw new Error(`SMS provider "${name}" is not implemented`); } };
}

// 10-digit Indian mobile; tolerates spaces/dashes and a 91 / 0 prefix. null = unusable.
export function normalizeMobile(raw: string | null | undefined) {
  const d = (raw ?? '').replace(/\D/g, '');
  const n = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^\d{10}$/.test(n) ? n : null;
}
