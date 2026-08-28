import type Anthropic from '@anthropic-ai/sdk';

import type { MessageCreator } from '../../../src/lib/ai/client';
import cleanValid from '../../fixtures/llm/clean-valid.json';
import noPlan from '../../fixtures/llm/no-plan.json';
import overStepCap from '../../fixtures/llm/over-step-cap.json';
import schemaInvalid from '../../fixtures/llm/schema-invalid.json';
import semanticInvalid from '../../fixtures/llm/semantic-invalid-place-before-pick.json';
import textFallback from '../../fixtures/llm/text-fallback.json';
import unknownStation from '../../fixtures/llm/unknown-station.json';

/**
 * Anthropic responses, replayed from disk.
 *
 * The fixtures are shaped as real API responses — a `content` array holding a
 * `tool_use` block — because that is the shape the extractor has to cope with.
 * A hand-rolled `{ plan: ... }` stand-in would test the test, not the code.
 *
 * JSON imports widen string literals (`'tool_use'` -> `string`), so the union
 * types have to be re-asserted. Casts like this are why CLAUDE.md allows in
 * tests what it forbids in `src`.
 */
export const FIXTURES = {
  cleanValid: cleanValid as unknown as Anthropic.Message,
  textFallback: textFallback as unknown as Anthropic.Message,
  schemaInvalid: schemaInvalid as unknown as Anthropic.Message,
  semanticInvalid: semanticInvalid as unknown as Anthropic.Message,
  unknownStation: unknownStation as unknown as Anthropic.Message,
  overStepCap: overStepCap as unknown as Anthropic.Message,
  noPlan: noPlan as unknown as Anthropic.Message,
};

export type Recorder = {
  create: MessageCreator;
  /** One entry per call, in order. Asserted on to pin the repair-loop count. */
  calls: Anthropic.MessageCreateParamsNonStreaming[];
};

/**
 * A `MessageCreator` that replays the given responses in order.
 *
 * Running past the end throws rather than repeating the last response: a test
 * that expects three calls and gets four should fail loudly, not quietly pass
 * because the stub kept answering.
 */
export function replay(...responses: Anthropic.Message[]): Recorder {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  const create: MessageCreator = async (params) => {
    const response = responses[calls.length];

    calls.push(params);

    if (response === undefined) {
      throw new Error(`Unexpected model call #${calls.length}: only ${responses.length} stubbed.`);
    }

    return response;
  };

  return { create, calls };
}

/** A `MessageCreator` that always throws — for the error-mapping paths. */
export function alwaysThrows(error: unknown): Recorder {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  const create: MessageCreator = async (params) => {
    calls.push(params);

    throw error;
  };

  return { create, calls };
}

/**
 * A `MessageCreator` that never resolves until its signal aborts.
 *
 * This exercises the real `AbortController` path rather than a fake clock, so
 * the test proves the timeout actually cancels the request.
 */
export function neverResolves(): Recorder {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  const create: MessageCreator = (params, options) => {
    calls.push(params);

    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  };

  return { create, calls };
}
