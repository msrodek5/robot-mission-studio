import type { APIRoute } from 'astro';
import { VERCEL_GIT_COMMIT_SHA } from 'astro:env/server';

export const prerender = false;

export const GET: APIRoute = () =>
  Response.json({
    status: 'ok',
    // Set by Vercel on every deployment; absent in local dev.
    commit: VERCEL_GIT_COMMIT_SHA ?? 'local',
  });
