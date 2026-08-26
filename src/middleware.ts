/**
 * Attaches a request-scoped Supabase client and the verified user to
 * `context.locals`, then gates `/app/*` behind a login redirect.
 *
 * This is the only place a Supabase client is constructed for page rendering,
 * which keeps session refresh in exactly one spot. Astro's
 * `security.checkOrigin` defaults to true, so same-origin form POSTs pass and
 * cross-origin ones are rejected before reaching a route — no hand-rolled CSRF
 * token is needed.
 */

import { defineMiddleware } from 'astro:middleware';

import { applyCookieWriteback, createSupabaseServerClient } from './db/supabase-server';

/** Routes requiring a session. Prefix match on the path segment boundary. */
const PROTECTED_PREFIX = '/app';

/** Routes that make no sense once signed in. */
const AUTH_ROUTES = new Set(['/login', '/signup']);

export const onRequest = defineMiddleware(async (context, next) => {
  // Prerendered routes (src/pages/index.astro) are built with no request
  // cookies. Without this guard the build would attempt an auth round-trip per
  // page and slow the deploy down for nothing.
  if (context.isPrerendered) return next();

  const { supabase, writeback } = createSupabaseServerClient(context.request, context.cookies);

  // `getUser()` validates the token against the auth server. `getSession()`
  // would trust whatever the cookie claims, which is exactly the mistake this
  // milestone is meant to avoid.
  const { data } = await supabase.auth.getUser();
  const user = data.user ?? null;

  context.locals.supabase = supabase;
  context.locals.user = user;

  const { pathname } = context.url;

  if (!user && isProtected(pathname)) {
    const target = `/login?redirect=${encodeURIComponent(pathname + context.url.search)}`;
    return applyCookieWriteback(context.redirect(target, 302), writeback);
  }

  if (user && AUTH_ROUTES.has(pathname)) {
    return applyCookieWriteback(context.redirect(PROTECTED_PREFIX, 302), writeback);
  }

  // A session refresh mid-request writes a Set-Cookie header; the accompanying
  // no-store headers stop a CDN caching one user's token for everyone.
  return applyCookieWriteback(await next(), writeback);
});

function isProtected(pathname: string): boolean {
  return pathname === PROTECTED_PREFIX || pathname.startsWith(`${PROTECTED_PREFIX}/`);
}
