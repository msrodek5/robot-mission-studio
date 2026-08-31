import type Anthropic from '@anthropic-ai/sdk';

import type { MessageCreator } from '../../../src/lib/ai/client';
import cleanValid from '../../fixtures/llm/clean-valid.json';
import noPlan from '../../fixtures/llm/no-plan.json';
import overStepCap from '../../fixtures/llm/over-step-cap.json';
import postmortemClean from '../../fixtures/llm/postmortem-clean.json';
import postmortemNoEdits from '../../fixtures/llm/postmortem-no-edits.json';
import postmortemNoTool from '../../fixtures/llm/postmortem-no-tool.json';
import postmortemOutOfRange from '../../fixtures/llm/postmortem-out-of-range.json';
import postmortemSchemaInvalid from '../../fixtures/llm/postmortem-schema-invalid.json';
import postmortemTextFallback from '../../fixtures/llm/postmortem-text-fallback.json';
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

/**
 * The postmortem's responses, same idea and the same shapes.
 *
 * Kept in a separate map rather than merged into `FIXTURES` so a test that
 * replays a mission fixture into `explainFailure` — or the reverse — reads as
 * obviously wrong at the call site.
 */
export const POSTMORTEM_FIXTURES = {
  clean: postmortemClean as unknown as Anthropic.Message,
  noEdits: postmortemNoEdits as unknown as Anthropic.Message,
  schemaInvalid: postmortemSchemaInvalid as unknown as Anthropic.Message,
  outOfRange: postmortemOutOfRange as unknown as Anthropic.Message,
  textFallback: postmortemTextFallback as unknown as Anthropic.Message,
  noTool: postmortemNoTool as unknown as Anthropic.Message,
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
