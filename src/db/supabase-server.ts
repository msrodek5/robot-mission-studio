/**
 * Per-request Supabase client for server-rendered pages, endpoints, and
 * middleware.
 *
 * Sessions live in cookies, so a client must never be shared across requests —
 * build a fresh one per request and let `@supabase/ssr` read and refresh the
 * session through the cookie bridge below.
 *
 * Only the anon key is used here. The service-role key bypasses row-level
 * security and must never reach request-handling code.
 */

import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from 'astro:env/client';

/**
 * Cookies written during this request, alongside the response headers
 * `@supabase/ssr` wants set when it refreshes a session.
 *
 * The caller applies `headers` to the outgoing response: a response carrying a
 * refreshed auth cookie must not be cached by a CDN, or one user's token gets
 * served to another.
 */
export type CookieWriteback = {
  headers: Record<string, string>;
};

/**
 * `@supabase/ssr` needs to enumerate every cookie, and `AstroCookies` only
 * exposes lookup by name — so parse the request header directly.
 *
 * Values are URL-decoded to match how `AstroCookies.set` encodes them on the
 * way out. A malformed value is passed through rather than throwing: one bad
 * cookie from an unrelated source should not take down the request.
 */
function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];

  return header
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 1) return null;

      const name = pair.slice(0, eq).trim();
      const raw = pair.slice(eq + 1).trim();
      if (!name) return null;

      try {
        return { name, value: decodeURIComponent(raw) };
      } catch {
        return { name, value: raw };
      }
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

/**
 * Creates a request-scoped client and returns it with the writeback object the
 * caller must drain onto the response.
 */
export function createSupabaseServerClient(
  request: Request,
  cookies: AstroCookies,
): { supabase: SupabaseClient; writeback: CookieWriteback } {
  const writeback: CookieWriteback = { headers: {} };

  // Cookies set during this request, so a later `getAll` in the same request
  // sees a session that was just established rather than the stale header.
  const pending = new Map<string, string>();

  const supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        const fromRequest = parseCookieHeader(request.headers.get('cookie'));
        const merged = new Map(fromRequest.map(({ name, value }) => [name, value]));

        for (const [name, value] of pending) {
          merged.set(name, value);
        }

        return [...merged].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          pending.set(name, value);
          cookies.set(name, value, toAstroCookieOptions(options));
        }

        Object.assign(writeback.headers, headers);
      },
    },
  });

  return { supabase, writeback };
}

/**
 * Auth cookies are session state, so they get sensible defaults even when
 * `@supabase/ssr` leaves them unset: HTTP-only keeps them out of client JS, and
 * `lax` still survives the top-level redirect that follows a login POST.
 */
function toAstroCookieOptions(options: CookieOptions) {
  return {
    ...options,
    path: options.path ?? '/',
    httpOnly: options.httpOnly ?? true,
    sameSite: options.sameSite ?? ('lax' as const),
    secure: options.secure ?? import.meta.env.PROD,
  };
}

/** Copies the cache-suppressing headers from a writeback onto a response. */
export function applyCookieWriteback(response: Response, writeback: CookieWriteback): Response {
  for (const [name, value] of Object.entries(writeback.headers)) {
    response.headers.set(name, value);
  }

  return response;
}
