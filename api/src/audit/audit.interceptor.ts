import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { mergeMap } from 'rxjs';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth.guard.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET = /^(password|passwordHash|token)$/i;
const MAX_JSON = 20_000;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : redact(x)]));
  return v;
}

// Register as APP_INTERCEPTOR. Logs every successful mutating request by a signed-in user (login is never logged).
// ponytail: written after the response is built, not in the change's own transaction, and `before` is not captured;
// per-controller audit calls inside the transaction are the upgrade if exact before/after is ever needed.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private log = new Logger('Audit');
  constructor(private prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user || !MUTATING.has(req.method)) return next.handle();

    const segs: string[] = String(req.originalUrl).split('?')[0].split('/').filter(Boolean);
    if (segs[0] === 'api') segs.shift();
    const entity = segs[0];
    if (!entity || entity === 'auth' || entity === 'audit') return next.handle();

    return next.handle().pipe(
      mergeMap(async (res) => {
        try {
          const idSeg = segs.slice(1).find((s) => /^\d+$/.test(s));
          const entityId = idSeg ? Number(idSeg) : typeof res?.id === 'number' ? res.id : null;
          const sid = Number(req.body?.schoolId ?? req.query?.schoolId);
          let after: unknown = req.body && Object.keys(req.body).length ? redact(req.body) : undefined;
          const bytes = after === undefined ? 0 : JSON.stringify(after).length;
          if (bytes > MAX_JSON) after = { truncated: true, bytes };
          await this.prisma.auditLog.create({
            data: {
              schoolId: user.schoolId ?? (sid > 0 ? sid : null),
              username: user.username, entity, entityId,
              action: req.method === 'DELETE' ? 'DELETE' : req.method === 'POST' ? (segs.includes('cancel') ? 'CANCEL' : 'CREATE') : 'UPDATE',
              after: after as Prisma.InputJsonValue | undefined,
            },
          });
        } catch (e) {
          this.log.error(`audit write failed: ${e instanceof Error ? e.message : e}`); // never fail the request over its log
        }
        return res;
      }),
    );
  }
}
