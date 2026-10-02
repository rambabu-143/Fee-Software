import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

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

// All demo values below are invented round numbers.
const classes = ['Nursery', 'KG', 'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5'];
const heads = [
  ['Admission Fee', 'ADMISSION'],
  ['Annual Charges', 'ANNUAL'],
  ['Tuition Fee', 'MONTHLY'],
  ['Caution Deposit', 'REFUNDABLE'],
  ['Computer Fee', 'OPTIONAL'],
] as const;
const installments = [
  [1, 'First (Apr-Jun)', '2026-04-10', '2026-04-20'],
  [2, 'Second (Jul-Sep)', '2026-07-10', '2026-07-20'],
  [3, 'Third (Oct-Dec)', '2026-10-10', '2026-10-20'],
  [4, 'Fourth (Jan-Mar)', '2027-01-10', '2027-01-20'],
] as const;

for (const [code, name] of schools) {
  const school = await prisma.school.upsert({ where: { code }, update: {}, create: { code, name } });
  const schoolId = school.id;

  const headIds: Record<string, number> = {};
  for (const [name, type] of heads) {
    const h = await prisma.feeHead.upsert({
      where: { schoolId_name: { schoolId, name } },
      update: {},
      create: { schoolId, name, type },
    });
    headIds[name] = h.id;
  }

  let studentNo = 0;
  const instIds: number[] = [];
  const enrollmentIds: number[] = [];
  for (const [number, label, due, fine] of installments) {
    const i = await prisma.installment.upsert({
      where: { schoolId_yearId_number: { schoolId, yearId: year.id, number } },
      update: { finePerDay: 10 },
      create: { schoolId, yearId: year.id, number, label, dueDate: new Date(due), fineStartDate: new Date(fine), finePerDay: 10 },
    });
    instIds.push(i.id);
  }

  for (const [sortOrder, name] of classes.entries()) {
    const std = await prisma.standard.upsert({
      where: { schoolId_name: { schoolId, name } },
      update: {},
      create: { schoolId, name, sortOrder },
    });
    for (const section of ['A', 'B']) {
      const sec = await prisma.section.upsert({
        where: { standardId_name: { standardId: std.id, name: section } },
        update: {},
        create: { standardId: std.id, name: section },
      });

      // 3 fictional students per section. Nursery = new admissions; every 2nd student from Class 1 takes Computer.
      for (let roll = 1; roll <= 3; roll++) {
        studentNo++;
        const admissionNo = `${code}-${String(studentNo).padStart(4, '0')}`;
        const optIn = sortOrder >= 2 && studentNo % 2 === 0;
        const st = await prisma.student.upsert({
          where: { schoolId_admissionNo: { schoolId, admissionNo } },
          update: {},
          create: { schoolId, admissionNo, name: `Demo Student ${String(studentNo).padStart(3, '0')}` },
        });
        const enr = await prisma.enrollment.upsert({
          where: { studentId_yearId: { studentId: st.id, yearId: year.id } },
          update: {},
          create: {
            studentId: st.id,
            yearId: year.id,
            sectionId: sec.id,
            rollNo: roll,
            isNewAdmission: sortOrder === 0,
            optionalHeads: { connect: optIn ? [{ id: headIds['Computer Fee'] }] : [] },
          },
        });
        enrollmentIds.push(enr.id);
      }
    }

    // Tuition every installment, annual charges once, computer fee from Class 1 up.
    const grid: [string, number, number][] = [];
    instIds.forEach((instId, n) => {
      grid.push(['Tuition Fee', instId, 5000 + sortOrder * 500]);
      if (n === 0) grid.push(['Annual Charges', instId, 8000]);
      if (sortOrder >= 2) grid.push(['Computer Fee', instId, 1000]);
    });
    for (const [head, installmentId, amount] of grid) {
      const key = { yearId: year.id, standardId: std.id, feeHeadId: headIds[head], installmentId };
      await prisma.feeStructure.upsert({
        where: { yearId_standardId_feeHeadId_installmentId: key },
        update: {},
        create: { ...key, amount },
      });
    }
  }

  // Transport routes and a hostel, each billed a flat amount every installment.
  // Every 5th student takes a route, every 11th boards.
  const facilities = [
    ['TRANSPORT', 'Route A', 600] as const,
    ['TRANSPORT', 'Route B', 900] as const,
    ['HOSTEL', 'Boys Hostel', 4000] as const,
  ];
  for (const [kind, name, amount] of facilities) {
    const f = await prisma.facility.upsert({
      where: { schoolId_kind_name: { schoolId, kind, name } },
      update: {},
      create: { schoolId, kind, name },
    });
    for (const installmentId of instIds) {
      const key = { yearId: year.id, facilityId: f.id, installmentId };
      await prisma.facilityFeeStructure.upsert({
        where: { yearId_facilityId_installmentId: key },
        update: {},
        create: { ...key, amount },
      });
    }
    if (kind === 'TRANSPORT') {
      const routeEnrollments = enrollmentIds.filter((_, n) => n % 5 === (name === 'Route A' ? 0 : 2));
      for (const enrollmentId of routeEnrollments) {
        await prisma.facilityAssignment.upsert({
          where: { enrollmentId_facilityId: { enrollmentId, facilityId: f.id } },
          update: {},
          create: { enrollmentId, facilityId: f.id },
        });
      }
    } else {
      for (const enrollmentId of enrollmentIds.filter((_, n) => n % 11 === 0)) {
        await prisma.facilityAssignment.upsert({
          where: { enrollmentId_facilityId: { enrollmentId, facilityId: f.id } },
          update: {},
          create: { enrollmentId, facilityId: f.id },
        });
      }
    }
  }
}

const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123';
await prisma.user.upsert({
  where: { username: 'admin' },
  update: {},
  create: { username: 'admin', passwordHash: await bcrypt.hash(password, 10), role: 'SUPERADMIN' },
});

console.log('Seeded demo schools, 2026-27 year, classes, fee heads, installments, fee grid, students, admin user');
await prisma.$disconnect();
