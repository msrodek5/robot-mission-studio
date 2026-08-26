/**
 * Validates a `?redirect=` parameter before it is handed to a redirect.
 *
 * Attacker-supplied redirect targets are an open-redirect vector: a link to
 * `/login?redirect=https://evil.example` would bounce a freshly authenticated
 * user off-site. Only same-site absolute paths are accepted; anything else
 * falls back to the caller's default.
 */

/** C0 controls plus DEL. A newline here could smuggle a header break. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function safeRedirectTarget(candidate: string | null, fallback: string): string {
  if (!candidate) return fallback;

  // Must be an absolute path. `//host` is protocol-relative and resolves
  // off-site, and a backslash is normalised to `/` by some browsers.
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;

  if (CONTROL_CHARS.test(candidate)) return fallback;

  return candidate;
}
