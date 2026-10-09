# Fees v2

NestJS + Prisma + PostgreSQL (`api/`) and React + Vite + Ant Design (`web/`).

## Run locally

```sh
# Postgres: either Docker...
docker compose up -d
# ...or local: brew services run postgresql@16, then create role/db `fees` (password `fees`)

cd api
cp .env.example .env          # set a real JWT_SECRET
npm i --legacy-peer-deps      # npm peer-resolver bug with Nest 12
npx prisma migrate dev
npx prisma db seed            # demo data: 2 schools, 2026-27, 7 classes, fee heads, 4 installments, fee grid; admin / admin123
npm run start:dev             # http://localhost:3100/api

cd ../web
npm i --legacy-peer-deps
npm run dev                   # http://localhost:5173 (proxies /api -> 3100, override with API_URL)
```

- **API docs (Swagger UI):** http://localhost:3100/api/docs (raw OpenAPI at `/api/docs-json`). Log in with `POST /api/auth/login`, then **Authorize** with the token.
- **Health check:** `GET /api/health` returns `{"status":"ok"}` when the DB is reachable (public, no data).

## Environment variables (`api/.env`)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL, e.g. `postgresql://fees:fees@localhost:5432/fees?schema=public` |
| `JWT_SECRET` | **yes** | Signing key. The app refuses to start without it, and (with `NODE_ENV=production`) while it still starts with `change-me`. Use a long random string. |
| `PORT` | no | API port, default 3100 |
| `SEED_ADMIN_PASSWORD` | no | Password for the seeded `admin` (default `admin123`). Only used when `admin` does not exist yet; it never changes an existing password. |
| `DISABLE_DOCS` | no | `true` turns off `/api/docs`. Set it when the API is reachable by the public. |
| `DB_POOL_MAX` | no | pg pool size per process, default 10. The e2e config sets 5; see Tests. |
| `SMS_PROVIDER` | no | Unset or `stub` = SMS only logged, nothing sent. No real provider is built in yet. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Email is logged only. Real sending needs these **and** `npm i nodemailer`. |

## Tests

```sh
cd api
npm test                              # unit tests
npm run test:e2e                      # e2e, needs a migrated + seeded DB (see below)
npm run test:e2e -- --no-file-parallelism   # slower, steadier: use on a busy machine and in CI
```

Use a throwaway database, never your dev one: `createdb fees_e2e`, then
`DATABASE_URL=postgresql://fees:fees@localhost:5432/fees_e2e?schema=public npx prisma migrate deploy && npx prisma db seed`.
Specs create and remove their own schools, so repeated runs on the same DB are fine.

Every spec file boots its own app, and Postgres allows 100 connections in total, so the e2e config caps each pool
(`DB_POOL_MAX=5`) and retries a test once. If you still see `TooManyConnections` or transaction timeouts, close other
servers or use `--no-file-parallelism`.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit and e2e on a Postgres service, plus the web typecheck and build.

## Deploy

`docker-compose.prod.example.yml` runs db + api + web (nginx serves the UI and proxies `/api`):

```sh
cp docker-compose.prod.example.yml docker-compose.prod.yml
# create .env next to it: POSTGRES_PASSWORD, JWT_SECRET (long random), SEED_ADMIN_PASSWORD, optional DISABLE_DOCS
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.prod.yml run --rm api npx prisma db seed    # first run only
```

The api container applies pending migrations on every start. The seed creates demo schools and the `admin` login,
so run it once, then change the password and replace the demo schools with real ones. The Dockerfiles are written
but untested: nobody has built them yet.

Put TLS in front (a reverse proxy or load balancer); the compose file only exposes port 80.

## Backup and restore

```sh
DATABASE_URL=postgresql://... scripts/backup.sh          # writes backups/fees-YYYYMMDD-HHMMSS.dump, keeps 14 days
CONFIRM=yes DATABASE_URL=postgresql://.../target scripts/restore.sh backups/fees-....dump
```

`BACKUP_DIR` and `BACKUP_KEEP_DAYS` override the defaults. Restore **drops and replaces** what is in the target
database, so point it at an empty or disposable one first. Schedule the backup with cron, e.g. nightly:
`0 2 * * * cd /srv/fees && DATABASE_URL=... scripts/backup.sh >> backup.log 2>&1`, and copy the dumps off the machine.
Needs the `pg_dump`/`pg_restore` client tools (same major version as the server).

## Security notes

- Change the default `admin` / `admin123` login before anyone else can reach the app, and set a real `JWT_SECRET`.
- `/api/docs` has no login. Set `DISABLE_DOCS=true` on a public server.
- Login is rate limited per IP and username (in memory, per process). Behind a proxy, configure Express `trust proxy`
  or every client shares one IP.
- Tokens last 12 hours and cannot be revoked, except by deactivating the user.
- No security headers beyond disabling `X-Powered-By`; add them at the reverse proxy.

## Design

Fee rules are data, not code: `FeeStructure` = amount per (year, class, fee head, installment).
A new academic year means new rows, never a new source file.
Every API route requires a JWT unless marked `@Public()`; `@Roles(...)` restricts further.
