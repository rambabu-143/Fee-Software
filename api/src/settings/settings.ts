import { PrismaService } from '../prisma/prisma.service.js';

// Whitelist = the only keys that can be stored; the default doubles as the type check.
export const SETTING_DEFAULTS = { receiptFooter: '', smsEnabled: true, lateFeeEnabled: true } as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting<K extends SettingKey>(prisma: PrismaService, schoolId: number, key: K) {
  const row = await prisma.setting.findUnique({ where: { schoolId_key: { schoolId, key } } });
  return (row ? row.value : SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
}
