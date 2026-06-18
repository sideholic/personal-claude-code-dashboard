import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror tsconfig's `@/*` path alias so server routes (which import via `@/`)
  // can be unit-tested.
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    // `.next` holds build artifacts (incl. a standalone copy of source +
    // tests) — never collect tests from there.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});
