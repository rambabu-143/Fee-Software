// One-off, idempotent: gives receipts made before per-head allocation their PaymentAllocationHead rows.
//   DATABASE_URL=... npx tsx prisma/backfill-heads.ts
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { backfillHeads, headGaps } from '../src/billing/backfill-heads.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const { filled, rows } = await backfillHeads(prisma);
const gaps = await headGaps(prisma);
console.log(`backfill-heads: ${filled} allocations filled (${rows} head rows); still missing ${gaps.missing}, mismatched ${gaps.wrong}`);
await prisma.$disconnect();
if (gaps.missing || gaps.wrong) process.exit(1);
