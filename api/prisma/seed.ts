import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedSchool } from './seed-school.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const schools = [
  ['DEMO1', 'Demo School 1'],
  ['DEMO2', 'Demo School 2'],
];

const year = await prisma.academicYear.upsert({
  where: { label: '2026-27' },
  update: {},
  create: {
    label: '2026-27',
    startDate: new Date('2026-04-01'),
    endDate: new Date('2027-03-31'),
    isCurrent: true,
  },
});

for (const [code, name] of schools) await seedSchool(prisma, year, code, name);

const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123';
await prisma.user.upsert({
  where: { username: 'admin' },
  update: {},
  create: { username: 'admin', passwordHash: await bcrypt.hash(password, 10), role: 'SUPERADMIN' },
});

console.log('Seeded demo schools, 2026-27 year, classes, fee heads, installments, fee grid, students, admin user');
await prisma.$disconnect();
