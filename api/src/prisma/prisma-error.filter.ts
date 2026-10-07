import { ArgumentsHost, BadRequestException, Catch, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client.js';

// Postgres input errors that mean "the client sent a bad value", not "the server broke":
// 22003 number out of range, 22021 NUL byte in text, 22P02 malformed text for the column type.
const BAD_INPUT = ['22003', '22021', '22P02'];

// Turns DB constraint and bad-input errors into 409/404/400 instead of a 500.
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaErrorFilter extends BaseExceptionFilter {
  private log = new Logger('PrismaErrorFilter');

  catch(e: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError, host: ArgumentsHost) {
    if (e instanceof Prisma.PrismaClientValidationError) return this.badInput(e, host); // e.g. an id of 1e20
    const pg = (e.meta as { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined)?.driverAdapterError?.cause?.originalCode;
    if (e.code === 'P2020' || (pg && BAD_INPUT.includes(pg))) return this.badInput(e, host);
    const mapped = {
      P2002: new ConflictException('A record with these values already exists'),
      P2003: new ConflictException('This record is in use by other records'),
      P2025: new NotFoundException(),
    }[e.code];
    super.catch(mapped ?? e, host);
  }

  // ponytail: ValidationError can also be a real code bug; the warn line keeps it visible instead of a silent 400.
  private badInput(e: Error, host: ArgumentsHost) {
    this.log.warn(e.message.trim().split('\n').pop());
    super.catch(new BadRequestException('Invalid value in request'), host);
  }
}
