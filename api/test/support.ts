import type { PrismaClient } from '../src/generated/prisma/client.js';
import { seedSchool } from '../prisma/seed-school.js';

// Throwaway schools for e2e specs: same shape as the DEMO seed, but private to one spec,
// so specs can mutate freely, run in parallel, and be re-run on the same DB.

export async function makeSchool(prisma: PrismaClient, code: string, name = `Throwaway ${code}`) {
  const year = await prisma.academicYear.findUniqueOrThrow({ where: { label: '2026-27' } });
  await seedSchool(prisma, year, code, name);
  return prisma.school.findUniqueOrThrow({ where: { code } });
}

// Removes a school and everything that hangs off it. No-op if it doesn't exist.
export async function dropSchool(prisma: PrismaClient, code: string) {
  const school = await prisma.school.findUnique({ where: { code } });
  if (!school) return;
  const schoolId = school.id;
  const byStudent = { student: { schoolId } };
  await prisma.$transaction([
    prisma.voucher.deleteMany({ where: { schoolId } }),
    prisma.deposit.deleteMany({ where: byStudent }),
    prisma.issuedDocument.deleteMany({ where: { schoolId } }),
    prisma.paymentAllocation.deleteMany({ where: { payment: { schoolId } } }),
    prisma.payment.deleteMany({ where: { schoolId } }),
    prisma.enrollment.deleteMany({ where: byStudent }), // cascades concessions, withdrawals, transport, ...
    prisma.student.deleteMany({ where: { schoolId } }), // cascades guardians
    prisma.stop.deleteMany({ where: { route: { schoolId } } }),
    prisma.facilityFeeStructure.deleteMany({ where: { facility: { schoolId } } }),
    prisma.facility.deleteMany({ where: { schoolId } }),
    prisma.feeStructure.deleteMany({ where: { standard: { schoolId } } }),
    prisma.section.deleteMany({ where: { standard: { schoolId } } }),
    prisma.standard.deleteMany({ where: { schoolId } }),
    prisma.installment.deleteMany({ where: { schoolId } }),
    prisma.feeHead.deleteMany({ where: { schoolId } }),
    prisma.bank.deleteMany({ where: { schoolId } }),
    prisma.occupation.deleteMany({ where: { schoolId, parentId: { not: null } } }),
    prisma.occupation.deleteMany({ where: { schoolId } }),
    prisma.subject.deleteMany({ where: { schoolId } }),
    prisma.receiptCounter.deleteMany({ where: { schoolId } }),
    prisma.voucherCounter.deleteMany({ where: { schoolId } }),
    prisma.defaulterLetterTemplate.deleteMany({ where: { schoolId } }),
    prisma.defaulterNotice.deleteMany({ where: { schoolId } }),
    prisma.smsTemplate.deleteMany({ where: { schoolId } }),
    prisma.smsLog.deleteMany({ where: { schoolId } }),
    prisma.emailTemplate.deleteMany({ where: { schoolId } }),
    prisma.emailLog.deleteMany({ where: { schoolId } }),
    prisma.auditLog.deleteMany({ where: { schoolId } }),
    prisma.setting.deleteMany({ where: { schoolId } }),
    prisma.user.deleteMany({ where: { schoolId } }),
    prisma.school.delete({ where: { id: schoolId } }),
  ]);
}

// Listen once on a fixed local port and return its URL. supertest's default (listen(0) + close around
// every request) churns ephemeral ports; under overlapping requests a call can land on whatever other
// local process grabbed the freed port (seen: foreign 401 bodies, random failures). Pass the URL to supertest.
export async function listen(app: { listen(port: number, host: string): Promise<unknown>; getHttpServer(): { address(): unknown } }) {
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
}
