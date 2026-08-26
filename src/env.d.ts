/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /**
     * Request-scoped Supabase client built by `src/middleware.ts`. Always
     * present on server-rendered routes.
     */
    supabase: import('@supabase/supabase-js').SupabaseClient;
    /**
     * The signed-in user, verified against the auth server — not decoded from
     * the cookie. `null` when the request is anonymous.
     */
    user: import('@supabase/supabase-js').User | null;
  }
}
