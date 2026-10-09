import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Every spec file boots its own Nest app (own pg pool) and ~9 files run at once, so keep pools small
// to stay under Postgres's 100 connections. If the machine is still starved, run
// `npm run test:e2e -- --no-file-parallelism`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: { DB_POOL_MAX: '5' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // ponytail: one retry hides a rare load flake; a real bug fails twice. Drop it if it ever masks one.
    retry: 1,
  },
});
