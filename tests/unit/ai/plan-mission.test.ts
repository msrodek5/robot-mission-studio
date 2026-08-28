import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, planMission, stripFences } from '../../../src/lib/ai/plan-mission';
import { EMIT_MISSION_TOOL_NAME, PROMPT_VERSION } from '../../../src/lib/ai/prompts/plan-mission';
import { validateMission } from '../../../src/lib/sim';
import { bench } from '../sim/layouts';
import { FIXTURES, alwaysThrows, neverResolves, replay } from './llm-fixtures';

const LAYOUT = bench();
const BRIEF = 'pick a bolt from the shelf and drop it at the dock';

function plan(recorder: { create: ReturnType<typeof replay>['create'] }, timeoutMs = 50) {
  return planMission({
    layout: LAYOUT,
    brief: BRIEF,
    create: recorder.create,
    model: 'test-model',
    timeoutMs,
  });
}

describe('planMission — the happy path', () => {
  it('accepts a clean tool_use response on the first call', async () => {
    const recorder = replay(FIXTURES.cleanValid);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(recorder.calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.model).toBe('test-model');
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.mission.steps).toHaveLength(4);
    expect(result.mission.steps[0]).toEqual({ op: 'MOVE_TO', stationId: 'shelf-1' });
    // The whole point of the gate: what comes back is runnable on this layout.
    expect(validateMission(LAYOUT, result.mission)).toEqual([]);
  });

  it('reports token usage from the response', async () => {
    const result = await plan(replay(FIXTURES.cleanValid));

    expect(result.usage).toEqual({ inputTokens: 512, outputTokens: 96 });
  });

  it('forces the emit_mission tool and pins temperature to 0', async () => {
    const recorder = replay(FIXTURES.cleanValid);

    await plan(recorder);

    const [params] = recorder.calls;

    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: EMIT_MISSION_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    expect(params.temperature).toBe(0);
    expect(params.tools?.[0]).toMatchObject({ name: EMIT_MISSION_TOOL_NAME });
  });

  it('never puts the obstacle grid in the prompt', async () => {
    // The division of labour, asserted rather than trusted: A* owns routing, so
    // the model is told dimensions and stations and nothing else. A future edit
    // that helpfully "gives the model more context" fails here.
    const walled = bench({ obstacles: [{ x: 1, y: 0 }, { x: 3, y: 0 }] });
    const recorder = replay(FIXTURES.cleanValid);

    await planMission({
      layout: walled,
      brief: BRIEF,
      create: recorder.create,
      model: 'test-model',
      timeoutMs: 50,
    });

    const prompt = JSON.stringify(recorder.calls[0].messages);

    expect(prompt).toContain('shelf-1');
    expect(prompt).toContain('5 wide by 5 tall');
    expect(prompt).not.toContain('obstacle');
    // Station cells are withheld too — they are the raw material for routing.
    expect(prompt).not.toContain('"cell"');
  });
});

describe('planMission — the text fallback', () => {
  it('reads a fenced JSON plan when the model ignores tool_choice', async () => {
    const recorder = replay(FIXTURES.textFallback);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One call: a text answer that parses is accepted, not repaired.
    expect(recorder.calls).toHaveLength(1);
    expect(result.mission.steps).toHaveLength(4);
  });

  it('strips markdown fences and surrounding prose', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('Here you go: {"a":1} — enjoy')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('planMission — the repair loop', () => {
  it('repairs a schema failure and succeeds on the second call', async () => {
    const recorder = replay(FIXTURES.schemaInvalid, FIXTURES.cleanValid);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(recorder.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    // Usage is cumulative across the loop — the rejected call was billed too.
    expect(result.usage.outputTokens).toBe(48 + 96);
  });

  it('sends the rejected plan back with the parse errors', async () => {
    const recorder = replay(FIXTURES.schemaInvalid, FIXTURES.cleanValid);

    await plan(recorder);

    const repair = recorder.calls[1].messages;

    // user brief, assistant's rejected plan, then the correction.
    expect(repair).toHaveLength(3);
    expect(repair[1].role).toBe('assistant');

    // An echoed tool_use block must be answered by a tool_result with the
    // matching id, or the API rejects the whole request.
    const correction = repair[2];
    expect(correction.role).toBe('user');
    expect(Array.isArray(correction.content)).toBe(true);
    expect(correction.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_test',
      is_error: true,
    });
  });

  it('repairs a schema-valid but semantically wrong plan', async () => {
    // PLACE before PICK parses perfectly and is still nonsense. This is the
    // case a Zod-only gate would wave through.
    expect(validateMission(LAYOUT, { steps: [{ op: 'PLACE', stationId: 'dock-1', item: 'bolt' }] }))
      .not.toEqual([]);

    const recorder = replay(FIXTURES.semanticInvalid, FIXTURES.cleanValid);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(recorder.calls).toHaveLength(2);
    expect(result.attempts).toBe(2);

    const correction = JSON.stringify(recorder.calls[1].messages[2]);
    expect(correction).toContain('GRIPPER_EMPTY');
  });

  it('repairs an invented station id', async () => {
    const recorder = replay(FIXTURES.unknownStation, FIXTURES.cleanValid);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);

    const correction = JSON.stringify(recorder.calls[1].messages[2]);
    expect(correction).toContain('UNKNOWN_STATION');
    expect(correction).toContain('shelf-A');
  });

  it('sends a plain user turn when the model answered in text', async () => {
    // No tool_use block means no tool_use_id, so a tool_result would be
    // rejected by the API. The correction has to be an ordinary user message.
    const recorder = replay(FIXTURES.noPlan, FIXTURES.cleanValid);

    const result = await plan(recorder);

    expect(result.ok).toBe(true);
    expect(recorder.calls[1].messages[2]).toMatchObject({ role: 'user' });
    expect(typeof recorder.calls[1].messages[2].content).toBe('string');
  });

  it('gives up with INVALID_OUTPUT after exactly three calls', async () => {
    const recorder = replay(
      FIXTURES.schemaInvalid,
      FIXTURES.schemaInvalid,
      FIXTURES.schemaInvalid,
    );

    const result = await plan(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // One initial call plus two repairs. Not four, and not a silent retry loop.
    expect(recorder.calls).toHaveLength(MAX_ATTEMPTS);
    expect(recorder.calls).toHaveLength(3);
    expect(result.code).toBe('INVALID_OUTPUT');
    expect(result.attempts).toBe(3);
    expect(result.message).toContain('could not produce a valid plan');
  });

  it('counts schema and semantic failures against the same budget', async () => {
    const recorder = replay(
      FIXTURES.schemaInvalid,
      FIXTURES.semanticInvalid,
      FIXTURES.unknownStation,
    );

    const result = await plan(recorder);

    expect(result.ok).toBe(false);
    expect(recorder.calls).toHaveLength(3);
  });
});

describe('planMission — guards', () => {
  it('rejects a plan over the step cap without spending a repair', async () => {
    const recorder = replay(FIXTURES.overStepCap);

    const result = await plan(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // A guard, not a negotiation: 41 steps fails now rather than after two more
    // calls that would each cost the user a second.
    expect(recorder.calls).toHaveLength(1);
    expect(result.code).toBe('INVALID_OUTPUT');
    expect(result.message).toContain('41 steps');
    expect(result.message).toContain('40');
  });
});

describe('planMission — provider failures', () => {
  it('maps a stalled request to TIMEOUT and stops', async () => {
    const recorder = neverResolves();

    const result = await planMission({
      layout: LAYOUT,
      brief: BRIEF,
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

    const result = await plan(recorder);

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

    const result = await plan(recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('PROVIDER_ERROR');
  });

  it('maps a non-SDK throw to PROVIDER_ERROR rather than crashing', async () => {
    const result = await plan(alwaysThrows(new TypeError('fetch failed')));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('PROVIDER_ERROR');
  });
});
