-- M2 follow-up — strip the privileges the previous migration assumed were absent.
--
-- 20260826181052 granted `select, insert, update, delete` to `authenticated` and
-- deliberately granted nothing to `anon`, on the assumption that a table starts
-- with no Data API privileges. That assumption is wrong on this project: it
-- carries the legacy `alter default privileges` grants for the `public` schema,
-- so both `anon` and `authenticated` came out holding the full set —
-- select, insert, update, delete, references, trigger **and truncate**.
--
-- Two problems with that:
--
-- 1. `anon` could reach the tables at all. Nothing leaked, because RLS is on and
--    every policy is `to authenticated`, so an anonymous request matches no
--    policy and reads zero rows. But that left RLS as the only lock, which is
--    exactly the single point of failure this milestone is trying to remove.
--
-- 2. More seriously, `authenticated` held TRUNCATE. **TRUNCATE is not row-level
--    filtered** — the privilege check is the only thing standing in front of it,
--    so a policy of `using (user_id = auth.uid())` does nothing to contain it.
--    The Data API does not expose TRUNCATE today, which is the only reason this
--    was not already exploitable.
--
-- So: revoke everything from both roles, then grant back exactly the four verbs
-- the app uses. `revoke` is idempotent, and a database built from scratch runs
-- this immediately after the migration above, ending in the same state either
-- way.

revoke all on table public.layouts from anon, authenticated;
revoke all on table public.missions from anon, authenticated;
revoke all on table public.runs from anon, authenticated;

-- `anon` is intentionally absent here. Every path to these tables goes through
-- an authenticated session; login and signup touch none of them.
grant select, insert, update, delete on table public.layouts to authenticated;
grant select, insert, update, delete on table public.missions to authenticated;
grant select, insert, update, delete on table public.runs to authenticated;

-- Note for whoever adds the next table: it will inherit the same over-broad
-- default privileges and needs the same revoke. Fixing that once, at the source,
-- means `alter default privileges in schema public revoke all on tables from
-- anon` — a schema-wide change that reaches past this milestone's three tables,
-- so it is deliberately not done here.
