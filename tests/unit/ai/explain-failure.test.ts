import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  explainFailure,
  outOfRangeEdits,
} from '../../../src/lib/ai/explain-failure';
import { MAX_ATTEMPTS as PLANNER_MAX_ATTEMPTS } from '../../../src/lib/ai/plan-mission';
import {
  EMIT_POSTMORTEM_TOOL_NAME,
  PROMPT_VERSION,
} from '../../../src/lib/ai/prompts/postmortem';
import { simulate } from '../../../src/lib/sim';
import type { Failure, LogEntry, Mission } from '../../../src/lib/sim';
import { bench } from '../sim/layouts';
import { POSTMORTEM_FIXTURES, alwaysThrows, neverResolves, replay } from './llm-fixtures';

const LAYOUT = bench();

/**
 * Four steps, failing at index 2 because index 1 filled the gripper.
 *
 * Four is the number that matters: the out-of-range fixture points at step 9, so
 * a gate that silently accepted any index would show up as a passing test with a
 * useless suggestion in it.
 */
const MISSION: Mission = {
  steps: [
    { op: 'MOVE_TO', stationId: 'shelf-1' },
    { op: 'PICK', stationId: 'shelf-1', item: 'bolt' },
    { op: 'PICK', stationId: 'shelf-1', item: 'nut' },
    { op: 'PLACE', stationId: 'dock-1', item: 'bolt' },
  ],
};

/**
 * The failure and log come from `simulate()`, not from hand-written literals.
 *
 * A postmortem is only as good as the trace it is given, and a fabricated trace
 * would let the prompt drift away from what the simulator actually emits.
 */
function failedRun(): { failure: Failure; log: LogEntry[] } {
  const result = simulate(LAYOUT, MISSION, { seed: 0 });

  if (result.failure === undefined) throw new Error('fixture mission was supposed to fail');

  return { failure: result.failure, log: result.log };
}

const RUN = failedRun();

function explain(recorder: { create: ReturnType<typeof replay>['create'] }, timeoutMs = 50) {
  return explainFailure({
    layout: LAYOUT,
    mission: MISSION,
    failure: RUN.failure,
    log: RUN.log,
    create: recorder.create,
    model: 'test-model',
    timeoutMs,
  });
}

describe('the fixture run', () => {
  it('really does fail with GRIPPER_FULL at step 2', () => {
    // Everything below is about explaining this failure. If the simulator ever
    // stops producing it, the tests should say so here rather than somewhere
    // confusing three describes down.
    expect(RUN.failure).toMatchObject({ stepIndex: 2, code: 'GRIPPER_FULL' });
    expect(RUN.log.length).toBeGreaterThan(1);
  });
});

describe('explainFailure — the happy path', () => {
  it('accepts a clean tool_use response on the first call', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.clean);

    const result = await explain(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(recorder.calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.model).toBe('test-model');
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.postmortem.diagnosis).toContain('one thing at a time');
    expect(result.postmortem.suggestedEdits).toHaveLength(2);
    expect(result.postmortem.suggestedEdits[0]).toEqual({
      stepIndex: 2,
      change: 'Drop this second PICK, or move it after the bolt has been placed at Dock.',
    });
  });

  it('reports token usage from the response', async () => {
    const result = await explain(replay(POSTMORTEM_FIXTURES.clean));

    expect(result.usage).toEqual({ inputTokens: 640, outputTokens: 128 });
  });

  it('forces the emit_postmortem tool and pins temperature to 0', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.clean);

    await explain(recorder);

    const [params] = recorder.calls;

    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: EMIT_POSTMORTEM_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    // The same failed run must not reword itself between two requests.
    expect(params.temperature).toBe(0);
    expect(params.tools?.[0]).toMatchObject({ name: EMIT_POSTMORTEM_TOOL_NAME });
  });

  it('accepts an empty edit list rather than demanding an invented suggestion', async () => {
    // UNREACHABLE-because-walled-in has no step-level fix. A gate that required
    // at least one edit would buy a fabricated one.
    const result = await explain(replay(POSTMORTEM_FIXTURES.noEdits));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.postmortem.suggestedEdits).toEqual([]);
    expect(result.postmortem.diagnosis).toContain('walled off');
  });

  it('sends the model the trace and the plan, and nothing about obstacles', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.clean);

    await explainFailure({
      layout: bench({ obstacles: [{ x: 1, y: 0 }, { x: 3, y: 0 }] }),
      mission: MISSION,
      failure: RUN.failure,
      log: RUN.log,
      create: recorder.create,
      model: 'test-model',
      timeoutMs: 50,
    });

    const prompt = JSON.stringify(recorder.calls[0].messages);

    expect(prompt).toContain('GRIPPER_FULL');
    expect(prompt).toContain('2 | PICK');
    expect(prompt).toContain('battery');
    // A future edit that helpfully "gives the model more context" fails here.
    expect(prompt).not.toContain('obstacle');
  });
});

describe('explainFailure — the text fallback', () => {
  it('reads a fenced JSON postmortem when the model ignores tool_choice', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.textFallback);

    const result = await explain(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One call: a text answer that parses is accepted, not repaired.
    expect(recorder.calls).toHaveLength(1);
    expect(result.postmortem.suggestedEdits[0].stepIndex).toBe(2);
  });
});

describe('explainFailure — the repair loop', () => {
  it('repairs a schema failure and succeeds on the second call', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.schemaInvalid, POSTMORTEM_FIXTURES.clean);

    const result = await explain(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(recorder.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    // Usage is cumulative across the loop — the rejected call was billed too.
    expect(result.usage.outputTokens).toBe(40 + 128);
  });

  it('sends the rejected postmortem back inside a tool_result', async () => {
    const recorder = replay(POSTMORTEM_FIXTURES.schemaInvalid, POSTMORTEM_FIXTURES.clean);

    await explain(recorder);

    const repair = recorder.calls[1].messages;

    // user turn, the assistant's rejected answer, then the correction.
    expect(repair).toHaveLength(3);
    expect(repair[1].role).toBe('assistant');

    // An echoed tool_use block must be answered by a tool_result with the
    // matching id, or the API rejects the whole request.
    const correction = repair[2];
    expect(correction.role).toBe('user');
    expect(Array.isArray(correction.content)).toBe(true);
    expect(correction.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_pm',
      is_error: true,
    });
  });

  it('repairs a schema-valid postmortem whose edit points off the end of the plan', async () => {
    // "Change step 9" on a four-step plan parses perfectly and is useless. This
    // is the case a Zod-only gate would wave through.
    const recorder = replay(POSTMORTEM_FIXTURES.outOfRange, POSTMORTEM_FIXTURES.clean);

    const result = await explain(recorder);

    expect(result.ok).toBe(true);
    expect(recorder.calls).toHaveLength(2);

    const correction = JSON.stringify(recorder.calls[1].messages[2]);
    expect(correction).toContain('step 9');
    // The repair turn names the valid range, not just the offence.
    expect(correction).toContain('0 to 3');
  });

  it('sends a plain user turn when the model answered in prose', async () => {
    // No tool_use block means no tool_use_id, so a tool_result would be rejected
    // by the API. The correction has to be an ordinary user message.
    const recorder = replay(POSTMORTEM_FIXTURES.noTool, POSTMORTEM_FIXTURES.clean);

    const result = await explain(recorder);

    expect(result.ok).toBe(true);
    expect(recorder.calls[1].messages[2]).toMatchObject({ role: 'user' });
    expect(typeof recorder.calls[1].messages[2].content).toBe('string');
  });

  it('gives up with INVALID_OUTPUT after exactly three calls', async () => {
    const recorder = replay(
      POSTMORTEM_FIXTURES.schemaInvalid,
      POSTMORTEM_FIXTURES.schemaInvalid,
      POSTMORTEM_FIXTURES.schemaInvalid,
    );

    const result = await explain(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // One initial call plus two repairs. Not four, and not a silent retry loop.
    expect(recorder.calls).toHaveLength(MAX_ATTEMPTS);
    expect(recorder.calls).toHaveLength(3);
    expect(result.code).toBe('INVALID_OUTPUT');
    expect(result.attempts).toBe(3);
    expect(result.message).toContain('could not be generated');
  });

  it('counts schema and semantic failures against the same budget', async () => {
    const recorder = replay(
      POSTMORTEM_FIXTURES.schemaInvalid,
      POSTMORTEM_FIXTURES.outOfRange,
      POSTMORTEM_FIXTURES.noTool,
    );

    const result = await explain(recorder);

    expect(result.ok).toBe(false);
    expect(recorder.calls).toHaveLength(3);
  });

  it('spends the same budget as the planner', () => {
    // The two are stated separately — a repair budget is a policy choice per
    // feature, not a shared constant — so this pins them rather than an import.
    expect(MAX_ATTEMPTS).toBe(PLANNER_MAX_ATTEMPTS);
  });
});

describe('outOfRangeEdits — the semantic gate', () => {
  it('passes every index the plan actually has, including the last', () => {
    const problems = outOfRangeEdits(MISSION, {
      diagnosis: 'x',
      suggestedEdits: [
        { stepIndex: 0, change: 'a' },
        { stepIndex: 3, change: 'b' },
      ],
    });

    expect(problems).toEqual([]);
  });

  it('rejects one past the end', () => {
    const problems = outOfRangeEdits(MISSION, {
      diagnosis: 'x',
      suggestedEdits: [{ stepIndex: 4, change: 'a' }],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0 to 3');
  });

  it('reports one problem per offending edit and leaves the valid ones alone', () => {
    const problems = outOfRangeEdits(MISSION, {
      diagnosis: 'x',
      suggestedEdits: [
        { stepIndex: 1, change: 'fine' },
        { stepIndex: 7, change: 'nope' },
        { stepIndex: 99, change: 'also nope' },
      ],
    });

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('step 7');
    expect(problems[1]).toContain('step 99');
  });

  it('rejects every edit on an empty plan and asks for none', () => {
    const problems = outOfRangeEdits(
      { steps: [] },
      { diagnosis: 'x', suggestedEdits: [{ stepIndex: 0, change: 'a' }] },
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no steps at all');
  });
});

describe('explainFailure — provider failures', () => {
  it('maps a stalled request to TIMEOUT and stops', async () => {
    const recorder = neverResolves();

    const result = await explainFailure({
      layout: LAYOUT,
      mission: MISSION,
      failure: RUN.failure,
      log: RUN.log,
      create: recorder.create,
      model: 'test-model',
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('TIMEOUT');
    // Transport failures are not repairable, so there is no second call.
    expect(recorder.calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
  });

  it('maps a 429 to RATE_LIMITED', async () => {
    const recorder = alwaysThrows(
      new Anthropic.RateLimitError(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        'slow down',
        new Headers(),
      ),
    );

    const result = await explain(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('RATE_LIMITED');
    expect(recorder.calls).toHaveLength(1);
  });

  it('maps any other API error to PROVIDER_ERROR', async () => {
    const recorder = alwaysThrows(
      new Anthropic.InternalServerError(
        500,
        { type: 'error', error: { type: 'api_error', message: 'boom' } },
        'boom',
        new Headers(),
      ),
    );

    const result = await explain(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('PROVIDER_ERROR');
  });

  it('maps a non-SDK throw to PROVIDER_ERROR rather than crashing', async () => {
    const result = await explain(alwaysThrows(new TypeError('fetch failed')));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('PROVIDER_ERROR');
  });
});
