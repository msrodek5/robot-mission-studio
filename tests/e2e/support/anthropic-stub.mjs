/**
 * A stand-in for `api.anthropic.com`, for the E2E suite only.
 *
 * ## Why this exists rather than `page.route`
 *
 * Both AI features call the model from *server* code: `/api/missions/generate`
 * and `/api/runs/:id/postmortem` construct the SDK client inside the request
 * handler. `page.route` can only intercept requests the browser makes, so it
 * cannot see those calls at all — and stubbing our own endpoints instead would
 * mean the mission row is never written, so the very next navigation
 * (`/app/missions/:id`) would 404, and the postmortem cache test would have
 * nothing cached to reload.
 *
 * So the seam is where the plan already puts it: `ANTHROPIC_BASE_URL`, which the
 * SDK reads when no `baseURL` is passed. Playwright points it here. Everything
 * downstream of the model — the Zod gate, the repair loop, `validateMission`,
 * persistence, the RLS-scoped read back — runs for real, and no test can reach
 * the real API even by accident, because there is nothing listening on the real
 * hostname from CI.
 *
 * ## What it answers with
 *
 * Deterministically, and derived from the request rather than hardcoded:
 *
 * - `emit_mission` → the canonical four-step pick-and-place, using the first
 *   shelf and first dock **from the station list in the prompt**. Station ids are
 *   `crypto.randomUUID()` values created by the editor, so a fixed fixture would
 *   name stations that do not exist and the repair loop would spin three times
 *   and fail. The item is the first double-quoted word in the brief.
 * - `emit_postmortem` → the diagnosis in `tests/fixtures/e2e/llm-stub.json`,
 *   anchored to step 0 so the index is inside every plan that can fail.
 *
 * Run standalone: `node tests/e2e/support/anthropic-stub.mjs` (PORT optional).
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../fixtures/e2e/llm-stub.json', import.meta.url), 'utf8'),
);

const PORT = Number.parseInt(process.env.PORT ?? '4399', 10);

/** Matches the `id | name | kind` lines built by `buildLayoutContext`. */
const STATION_LINE = /^([0-9a-fA-F-]{36})\s\|\s(.*)\s\|\s(dock|shelf|charger)$/;

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/__health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }

  if (request.method !== 'POST' || !request.url.startsWith('/v1/messages')) {
    reply(response, 404, { type: 'error', error: { type: 'not_found_error', message: request.url } });
    return;
  }

  readBody(request)
    .then((body) => {
      const toolName = body?.tools?.[0]?.name;

      if (toolName === 'emit_mission') {
        reply(response, 200, missionMessage(body));
        return;
      }

      if (toolName === 'emit_postmortem') {
        reply(response, 200, postmortemMessage());
        return;
      }

      // Loud rather than silent: an unrecognised tool means the prompt changed
      // and the stub was not updated, and a 400 says so in the test output.
      reply(response, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `stub has no answer for tool ${toolName}` },
      });
    })
    .catch((error) => {
      reply(response, 500, {
        type: 'error',
        error: { type: 'api_error', message: String(error) },
      });
    });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`anthropic stub listening on http://127.0.0.1:${PORT}\n`);
});

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function missionMessage(body) {
  const prompt = firstUserText(body);
  const stations = parseStations(prompt);
  const item = quotedItem(prompt) ?? FIXTURE.planner.defaultItem;

  return message('toolu_stub_mission', 'emit_mission', { steps: buildSteps(stations, item) });
}

/**
 * The four-step errand, or the shortest valid plan the station list allows.
 *
 * A plan naming a station that is not in the list would be rejected by
 * `validateMission` and sent back through the repair loop — which the stub would
 * answer identically, so the generation would fail after three calls. Degrading
 * to whatever the layout can actually support keeps the failure mode "the test
 * layout was wrong", visible in one assertion, instead of "the planner is
 * broken".
 */
function buildSteps(stations, item) {
  const shelf = stations.find((station) => station.kind === 'shelf');
  const dock = stations.find((station) => station.kind === 'dock');

  if (shelf === undefined || dock === undefined) {
    const fallback = stations[0];

    return fallback === undefined ? [] : [{ op: 'MOVE_TO', stationId: fallback.id }];
  }

  return [
    { op: 'MOVE_TO', stationId: shelf.id },
    { op: 'PICK', stationId: shelf.id, item },
    { op: 'MOVE_TO', stationId: dock.id },
    { op: 'PLACE', stationId: dock.id, item },
  ];
}

function postmortemMessage() {
  return message('toolu_stub_postmortem', 'emit_postmortem', FIXTURE.postmortem);
}

function message(toolUseId, toolName, input) {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: FIXTURE.model,
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 512, output_tokens: 96 },
  };
}

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

function firstUserText(body) {
  for (const entry of body?.messages ?? []) {
    if (entry.role !== 'user') continue;

    if (typeof entry.content === 'string') return entry.content;

    for (const block of entry.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }

  return '';
}

function parseStations(prompt) {
  const stations = [];

  for (const line of prompt.split('\n')) {
    const match = STATION_LINE.exec(line.trim());

    if (match !== null) stations.push({ id: match[1], name: match[2], kind: match[3] });
  }

  return stations;
}

/** `Pick the "demo-crate" from …` → `demo-crate`. */
function quotedItem(prompt) {
  const match = /"([^"\n]{1,60})"/.exec(prompt);

  return match === null ? null : match[1];
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function reply(response, status, payload) {
  const encoded = JSON.stringify(payload);

  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
    // The SDK retries 429s and 5xxs; there is nothing here worth retrying.
    'request-id': 'req_stub',
  });
  response.end(encoded);
}
