# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# ponytail: devDependencies stay in the image because `prisma migrate deploy` and the seed (tsx) need the CLI at runtime.
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3100}/api/health" || exit 1
# Applies pending migrations, then starts. Seeding is a one-off: see README "Deploy".
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
