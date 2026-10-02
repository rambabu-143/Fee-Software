# Fees v2

NestJS + Prisma + PostgreSQL (`api/`) and React + Vite + Ant Design (`web/`).

## Run

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
npm i
npm run dev                   # http://localhost:5173 (proxies /api -> 3100)
```

Tests: `cd api && npm run test:e2e` (needs the seeded DB).

## Design

Fee rules are data, not code: `FeeStructure` = amount per (year, class, fee head, installment).
A new academic year means new rows, never a new source file.
Every API route requires a JWT unless marked `@Public()`; `@Roles(...)` restricts further.
