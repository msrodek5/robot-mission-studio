/**
 * Failed run → plain-language postmortem, with the repair loop that makes model
 * output trustworthy.
 *
 * Deliberately the same shape as `plan-mission.ts`, down to the names: one
 * initial call, a two-stage gate, up to two repairs, then a typed failure. It
 * shares the client, the error taxonomy, and `stripFences`; it does not share a
 * second Anthropic client, because there is only one (`./client.ts`).
 *
 * The gate is two-stage and both stages matter (CLAUDE.md rule 4):
 *
 * 1. `PostmortemSchema.safeParse` — is this even a postmortem? Catches a missing
 *    diagnosis, a `stepIndex` that arrived as a string, an essay over the cap.
 * 2. `outOfRangeEdits(mission, postmortem)` — do the edits point at *this plan*?
 *    "Change step 7" on a four-step plan parses perfectly and is useless to the
 *    person reading it. This is the postmortem's `validateMission()`: the check
 *    a schema cannot make because the schema does not know how long the plan is.
 *
 * Either failure sends it back with an explanation. Two repairs, then it is
 * `INVALID_OUTPUT` and the user gets a sentence rather than a stack trace.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { PostmortemSchema } from '../schemas/mission';
import type { PostmortemInput, PlannerErrorCode } from '../schemas/mission';
import type { Failure, Layout, LogEntry, Mission } from '../sim';
import {
  MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  plannerModel,
  sendMessage,
  type MessageCreator,
} from './client';
import { stripFences } from './plan-mission';
import {
  EMIT_POSTMORTEM_TOOL_NAME,
  POSTMORTEM_JSON_SCHEMA,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  TOOL_DESCRIPTION,
  buildRepairPrompt,
  buildUserPrompt,
} from './prompts/postmortem';

/**
 * One initial call plus at most two repairs — the same budget the planner gets,
 * for the same reason: a third repair has never fixed what two could not, and
 * each one costs a user-visible second.
 *
 * Stated here rather than imported from `plan-mission.ts` because the budget is
 * a policy choice per feature, not a shared constant. That the two agree is
 * pinned by a test rather than by an import.
 */
export const MAX_REPAIRS = 2;
export const MAX_ATTEMPTS = MAX_REPAIRS + 1;

export type PostmortemUsage = { inputTokens: number; outputTokens: number };

export type ExplainFailureSuccess = {
  ok: true;
  postmortem: PostmortemInput;
  /** Model calls made, including the successful one. */
  attempts: number;
  model: string;
  promptVersion: string;
  usage: PostmortemUsage;
};

export type ExplainFailureFailure = {
  ok: false;
  code: PlannerErrorCode;
  message: string;
  attempts: number;
  usage: PostmortemUsage;
};

export type ExplainFailureResult = ExplainFailureSuccess | ExplainFailureFailure;

export type ExplainFailureOptions = {
  layout: Layout;
  mission: Mission;
  failure: Failure;
  log: LogEntry[];
  create: MessageCreator;
  model?: string;
  timeoutMs?: number;
};

const EMIT_POSTMORTEM_TOOL: Anthropic.Tool = {
  name: EMIT_POSTMORTEM_TOOL_NAME,
  description: TOOL_DESCRIPTION,
  // Derived from PostmortemSchema — see the note in prompts/postmortem.ts. The
  // cast narrows the generic JSON Schema object to the SDK's input_schema type;
  // the top-level `type: 'object'` the SDK requires is guaranteed by the Zod
  // schema being an object schema.
  input_schema: POSTMORTEM_JSON_SCHEMA as Anthropic.Tool.InputSchema,
};

export async function explainFailure(
  options: ExplainFailureOptions,
): Promise<ExplainFailureResult> {
  const { layout, mission, failure, log, create, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const model = options.model ?? plannerModel();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildUserPrompt(layout, mission, failure, log) },
  ];

  const usage: PostmortemUsage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let lastProblems: string[] = [];

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;

    const response = await sendMessage(
      create,
      {
        model,
        max_tokens: MAX_TOKENS,
        // The same failed run should get the same explanation twice. A run page
        // that reworded itself on every visit would look broken — and the
        // postmortem is cached on the row precisely so it does not.
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools: [EMIT_POSTMORTEM_TOOL],
        // Forced, so the postmortem arrives as structured tool input rather than
        // as JSON embedded in prose. The text fallback below exists because
        // "forced" is not "guaranteed".
        tool_choice: {
          type: 'tool',
          name: EMIT_POSTMORTEM_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
        messages,
      },
      timeoutMs,
    );

    // TIMEOUT, RATE_LIMITED, PROVIDER_ERROR: nothing to repair, so stop. Only
    // the model's *content* is worth a second try, never the transport.
    if (!response.ok) {
      return { ok: false, code: response.code, message: response.message, attempts, usage };
    }

    usage.inputTokens += response.message.usage.input_tokens;
    usage.outputTokens += response.message.usage.output_tokens;

    const outcome = evaluate(mission, response.message);

    if (outcome.ok) {
      return {
        ok: true,
        postmortem: outcome.postmortem,
        attempts,
        model,
        promptVersion: PROMPT_VERSION,
        usage,
      };
    }

    lastProblems = outcome.problems;

    messages.push(
      { role: 'assistant', content: response.message.content },
      repairTurn(outcome.toolUseId, outcome.problems),
    );
  }

  return {
    ok: false,
    code: 'INVALID_OUTPUT',
    message: userFacingFailure(lastProblems),
    attempts,
    usage,
  };
}

// ---------------------------------------------------------------------------
// The semantic gate
// ---------------------------------------------------------------------------

/**
 * Suggested edits that point at a step this plan does not have.
 *
 * The one check the schema cannot make. Returns a problem line per offending
 * edit, phrased so the repair turn tells the model both what it said and what
 * the valid range is — "step 7 does not exist" alone would leave it guessing.
 *
 * An empty plan is handled by the same arithmetic: every index is out of range,
 * so every edit is rejected, and the model is pushed towards the empty list that
 * is the only honest answer there.
 */
export function outOfRangeEdits(mission: Mission, postmortem: PostmortemInput): string[] {
  const count = mission.steps.length;

  return postmortem.suggestedEdits
    .filter((edit) => edit.stepIndex >= count)
    .map((edit) =>
      count === 0
        ? `suggestedEdits refers to step ${edit.stepIndex}, but the plan has no steps at all. Return an empty list.`
        : `suggestedEdits refers to step ${edit.stepIndex}, but the plan has ${count} steps — valid indices are 0 to ${count - 1}.`,
    );
}

// ---------------------------------------------------------------------------
// Evaluating one response
// ---------------------------------------------------------------------------

type Evaluation =
  | { ok: true; postmortem: PostmortemInput }
  | { ok: false; problems: string[]; toolUseId: string | null };

/**
 * No fatal branch, unlike the planner's step cap.
 *
 * Every way a postmortem can be wrong is a wording problem the model can fix on
 * the next turn: too long, wrong field type, an index off the end of the plan.
 * There is no equivalent of "41 steps" — a guard that says the request itself
 * was unreasonable — so there is nothing to fail fast on.
 */
function evaluate(mission: Mission, message: Anthropic.Message): Evaluation {
  const extracted = extract(message);

  if (!extracted.ok) {
    return { ok: false, problems: [extracted.problem], toolUseId: null };
  }

  const parsed = PostmortemSchema.safeParse(extracted.value);

  if (!parsed.success) {
    return {
      ok: false,
      problems: formatZodError(parsed.error),
      toolUseId: extracted.toolUseId,
    };
  }

  const problems = outOfRangeEdits(mission, parsed.data);

  if (problems.length > 0) {
    return { ok: false, problems, toolUseId: extracted.toolUseId };
  }

  return { ok: true, postmortem: parsed.data };
}

function formatZodError(error: z.ZodError): string[] {
  // Bounded: a badly wrong response can produce an issue per edit, and pasting
  // all of them into the repair turn buries the useful ones.
  return error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.length === 0 ? 'postmortem' : issue.path.join('.');

    return `${path}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Getting the postmortem out of the response
// ---------------------------------------------------------------------------

type Extraction =
  | { ok: true; value: unknown; toolUseId: string | null }
  | { ok: false; problem: string };

/**
 * Reads the postmortem from the `tool_use` block — never by string-parsing text.
 *
 * The fallback is the exception that proves it, and it is the same trade the
 * planner makes: `tool_choice` makes a tool call overwhelmingly likely, not
 * certain, and burning a repair on a diagnosis that was probably fine costs the
 * user a second for nothing. Reached only when there is no tool block at all.
 */
function extract(message: Anthropic.Message): Extraction {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === EMIT_POSTMORTEM_TOOL_NAME) {
      return { ok: true, value: block.input, toolUseId: block.id };
    }
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text.length === 0) {
    return { ok: false, problem: 'You returned nothing. Call emit_postmortem.' };
  }

  try {
    return { ok: true, value: JSON.parse(stripFences(text)), toolUseId: null };
  } catch {
    // Prose is the one failure mode where the model's answer might be *right*
    // and unusable anyway: an explanation with no step anchors is what US-6
    // exists to replace, so it is repaired rather than salvaged.
    return {
      ok: false,
      problem: 'You replied with prose instead of calling emit_postmortem.',
    };
  }
}

// ---------------------------------------------------------------------------
// The repair turn
// ---------------------------------------------------------------------------

/**
 * The correction, shaped to whatever the model actually sent.
 *
 * An echoed assistant turn containing a `tool_use` block *must* be answered by a
 * `tool_result` with the matching id — the API rejects the request otherwise. So
 * the correction rides inside the tool result when there was a tool call, and is
 * a plain user turn when the model answered in text.
 */
function repairTurn(toolUseId: string | null, problems: string[]): Anthropic.MessageParam {
  const prompt = buildRepairPrompt(problems);

  if (toolUseId === null) {
    return { role: 'user', content: prompt };
  }

  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: prompt, is_error: true }],
  };
}

/**
 * What the user reads when the loop runs out.
 *
 * Kept short and free of Zod paths: unlike a rejected plan, where the problem
 * list names the station that does not exist and is worth showing, a postmortem
 * that would not parse tells the user nothing they can act on. The run page
 * still has the failure code and detail, which is the fallback US-6 improves on
 * rather than replaces.
 */
function userFacingFailure(problems: string[]): string {
  const base = 'The postmortem could not be generated for this run.';

  return problems.length === 0 ? base : `${base} The explanation came back unusable three times.`;
}
