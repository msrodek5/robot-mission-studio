/**
 * Serves the production build locally, for the E2E suite only.
 *
 * `astro preview` does not work with `@astrojs/vercel` — the adapter declares no
 * preview entrypoint, because in production the function is booted by Vercel's
 * own runtime rather than by Astro. So the choice was between running `astro dev`
 * (and never testing the artefact that actually ships) or booting the built
 * function directly. This does the latter: `.vercel/output/_functions/entry.mjs`
 * exports `{ fetch(request) }`, a plain web handler, so a 60-line `node:http`
 * bridge is all that stands between the build output and a real HTTP port.
 *
 * The routing is the two rules from `.vercel/output/config.json` that matter
 * here: static files first, then everything else to the function. Cache headers
 * and image optimisation are Vercel's job and are not reproduced.
 *
 * Run standalone: `npm run build && npm run e2e:serve`.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const PORT = Number.parseInt(process.env.PORT ?? '4321', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const OUTPUT = resolve(process.cwd(), '.vercel', 'output');
const STATIC_ROOT = join(OUTPUT, 'static');
const ENTRY = join(OUTPUT, '_functions', 'entry.mjs');

if (!existsSync(ENTRY)) {
  process.stderr.write(
    `No build found at ${ENTRY}. Run \`npm run build\` first — the E2E suite ` +
      'runs against the production output, not the dev server.\n',
  );
  process.exit(1);
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
]);

const { default: handler } = await import(`file://${ENTRY}`);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  const file = staticFileFor(url.pathname);

  if (file !== null && request.method === 'GET') {
    sendFile(response, file);
    return;
  }

  render(request, response, url).catch((error) => {
    process.stderr.write(`render failed for ${url.pathname}: ${String(error)}\n`);
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Internal error');
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`build served on http://${HOST}:${PORT}\n`);
});

// ---------------------------------------------------------------------------
// Static files — the `{ "handle": "filesystem" }` rule
// ---------------------------------------------------------------------------

function staticFileFor(pathname) {
  // `normalize` collapses `..` before the prefix check, so a crafted path cannot
  // escape the static root. Not a security boundary — this listens on loopback
  // and never ships — but a traversal here would read the developer's disk.
  const base = join(STATIC_ROOT, normalize(decodeURIComponent(pathname)));

  if (!base.startsWith(STATIC_ROOT + sep) && base !== STATIC_ROOT) return null;

  // Prerendered pages land on disk as `index.html`, so `/` and `/foo` have to
  // resolve to a file the same way Vercel's filesystem handler resolves them.
  // Without this, `src/pages/index.astro` — the one prerendered route — 404s.
  for (const candidate of [base, `${base}.html`, join(base, 'index.html')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  return null;
}

function sendFile(response, path) {
  response.writeHead(200, {
    'content-type': CONTENT_TYPES.get(extname(path)) ?? 'application/octet-stream',
  });

  createReadStream(path).pipe(response);
}

// ---------------------------------------------------------------------------
// Everything else — the function
// ---------------------------------------------------------------------------

async function render(nodeRequest, nodeResponse, url) {
  const method = nodeRequest.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const request = new Request(url, {
    method,
    headers: toHeaders(nodeRequest.headers),
    // `duplex: 'half'` is mandatory when a body is a stream, and the stream is
    // what keeps a large form POST from being buffered whole.
    ...(hasBody ? { body: Readable.toWeb(nodeRequest), duplex: 'half' } : {}),
  });

  const result = await handler.fetch(request);

  // `Set-Cookie` is the one header that legitimately repeats, so it is read
  // through `getSetCookie()` rather than being folded into one comma-joined
  // value — folding it would break every session the middleware writes.
  const headers = Object.fromEntries(result.headers);
  delete headers['set-cookie'];

  const cookies = result.headers.getSetCookie();

  nodeResponse.writeHead(result.status, {
    ...headers,
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });

  if (result.body === null) {
    nodeResponse.end();
    return;
  }

  await Readable.fromWeb(result.body).pipe(nodeResponse);
}

function toHeaders(nodeHeaders) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }

  return headers;
}
