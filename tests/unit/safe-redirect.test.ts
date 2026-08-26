import { describe, expect, it } from 'vitest';

import { safeRedirectTarget } from '../../src/lib/safe-redirect';

// The login page feeds `?redirect=` straight into a redirect after a successful
// sign-in. Anything that escapes the site here hands an attacker a credible
// phishing hop: the victim really did just log in to the real app.
describe('safeRedirectTarget', () => {
  it('keeps a same-site absolute path', () => {
    expect(safeRedirectTarget('/app/layouts', '/app')).toBe('/app/layouts');
  });

  it('keeps a query string on the target', () => {
    expect(safeRedirectTarget('/app?tab=runs', '/app')).toBe('/app?tab=runs');
  });

  it('falls back when the parameter is absent', () => {
    expect(safeRedirectTarget(null, '/app')).toBe('/app');
    expect(safeRedirectTarget('', '/app')).toBe('/app');
  });

  it('rejects an absolute URL', () => {
    expect(safeRedirectTarget('https://evil.example/steal', '/app')).toBe('/app');
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeRedirectTarget('//evil.example/steal', '/app')).toBe('/app');
  });

  it('rejects a backslash-smuggled host', () => {
    // Some browsers normalise `/\` to `//`, making this off-site too.
    expect(safeRedirectTarget('/\\evil.example', '/app')).toBe('/app');
  });

  it('rejects a relative path', () => {
    expect(safeRedirectTarget('app/layouts', '/app')).toBe('/app');
  });

  it('rejects control characters', () => {
    expect(safeRedirectTarget('/app\nLocation: https://evil.example', '/app')).toBe('/app');
    expect(safeRedirectTarget('/app\r\nSet-Cookie: x=1', '/app')).toBe('/app');
  });
});
