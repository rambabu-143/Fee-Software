import { PrismaClient } from './src/generated/prisma/client.js';
const p = new PrismaClient();
const year = await p.academicYear.findUnique({ where: { label: '2027-28' } });
if (year) {
  await p.enrollment.deleteMany({ where: { yearId: year.id } });
  await p.academicYear.delete({ where: { id: year.id } });
  console.log('cleaned up test year', year.id);
}
await p.$disconnect();
