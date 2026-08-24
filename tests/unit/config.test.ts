import { describe, expect, it } from 'vitest';

import config from '../../astro.config.mjs';

// M0 guard: the deploy is the one thing that must never silently break.
// Dropping the adapter or flipping to a fully static build would take the
// server endpoints (/api/*) down without any other test noticing.
describe('astro config', () => {
  it('renders on demand so /api/* endpoints exist', () => {
    expect(config.output).toBe('server');
  });

  it('keeps a deploy adapter configured', () => {
    expect(config.adapter).toBeDefined();
  });

  it('keeps the react integration for islands', () => {
    const names = (config.integrations ?? [])
      .flat()
      .flatMap((integration) => (integration ? [integration.name] : []));

    expect(names).toContain('@astrojs/react');
  });
});
