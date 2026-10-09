import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        // Pool per process. Postgres allows 100 connections in total, so the e2e config sets a
        // small DB_POOL_MAX: every spec file boots its own app and 9+ run at once.
        max: Number(process.env.DB_POOL_MAX ?? 10),
        // How long a plain query waits for a free connection; longer than the transaction maxWait below so that fires first.
        connectionTimeoutMillis: 30_000,
      }),
      // Prisma's defaults (2s wait, 5s run) are too tight for the row-locked payment transactions under load; maxWait stays below typical 30s client timeouts.
      transactionOptions: { maxWait: 20_000, timeout: 20_000 },
    });
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
