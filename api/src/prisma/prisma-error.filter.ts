import { ArgumentsHost, Catch, ConflictException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client.js';

// Turns DB constraint errors into 409/404 instead of a 500.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaErrorFilter extends BaseExceptionFilter {
  catch(e: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const mapped = {
      P2002: new ConflictException('A record with these values already exists'),
      P2003: new ConflictException('This record is in use by other records'),
      P2025: new NotFoundException(),
    }[e.code];
    super.catch(mapped ?? e, host);
  }
}
