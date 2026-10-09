import { BadRequestException } from '@nestjs/common';

// Optional ?limit&offset. Without them callers get `dflt` rows from the start, exactly as before.
export function page(limit: number | undefined, offset: number | undefined, dflt: number) {
  if (limit !== undefined && (limit < 1 || limit > 5000)) throw new BadRequestException('limit must be 1..5000');
  if (offset !== undefined && offset < 0) throw new BadRequestException('offset must be 0 or more');
  return { take: limit ?? dflt, skip: offset ?? 0 };
}
