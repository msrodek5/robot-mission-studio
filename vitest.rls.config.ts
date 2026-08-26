import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Deliberately a separate project from vitest.config.ts. `npm test` must stay
// fast and offline — it gates every commit — and these tests need a live
// Supabase project. Run them with `npm run test:rls`.
export default defineConfig({
  test: {
    include: ['tests/rls/**/*.test.ts'],
    environment: 'node',
    // Creating users and round-tripping the Data API is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The two users and their rows are shared state; parallel files would race.
    fileParallelism: false,
    // Vite only exposes prefixed vars to import.meta.env, so hand the whole
    // .env through to process.env instead of adding a dotenv dependency.
    env: loadEnv('', process.cwd(), ''),
  },
});
