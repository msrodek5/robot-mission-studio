// @ts-check
import { defineConfig, envField } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // Most routes are user-specific (layouts, missions, runs behind auth), so
  // on-demand rendering is the default. Static pages opt in with
  // `export const prerender = true`.
  output: 'server',

  // Typed, server-only env access. Secrets added here in later milestones
  // (Supabase, OpenRouter) cannot leak into a client bundle by accident.
  env: {
    schema: {
      VERCEL_GIT_COMMIT_SHA: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),
    },
  },

  integrations: [react()],

  vite: {
    plugins: [tailwindcss()],
  },

  adapter: vercel(),
});
