/**
 * Brief → `Mission`, with the repair loop that makes model output trustworthy.
 *
 * The gate is two-stage and both stages matter (CLAUDE.md rule 4):
 *
 * 1. `MissionSchema.safeParse` — is this even a plan? Catches a missing field,
 *    a misspelled `op`, a string where a number belongs.
 * 2. `validateMission(layout, mission)` — is this plan *sensible on this
 *    layout*? Catches a station that does not exist, a PLACE before a PICK, a
 *    CHARGE at a shelf. A plan can sail through stage 1 and be nonsense here.
 *
 * Either failure sends the plan back with an explanation. Two repairs, then it
 * is `INVALID_OUTPUT` and the user gets a sentence rather than a stack trace.
 * Nothing constructs a `Mission` from raw model text on any path.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  MAX_PLAN_STEPS,
  MissionSchema,
  type MissionInput,
  type PlannerErrorCode,
} from '../schemas/mission';
import { hasBlockingIssues, validateMission } from '../sim';
import type { Issue, Layout } from '../sim';
import {
  MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  plannerModel,
  sendMessage,
  type MessageCreator,
} from './client';
import {
  EMIT_MISSION_TOOL_NAME,
  MISSION_JSON_SCHEMA,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  TOOL_DESCRIPTION,
  buildRepairPrompt,
  buildUserPrompt,
} from './prompts/plan-mission';

/**
 * One initial call plus at most two repairs.
 *
 * A third repair has never in practice fixed what two could not, and each one
 * costs a user-visible second inside a request that is already slow.
 */
export const MAX_REPAIRS = 2;
export const MAX_ATTEMPTS = MAX_REPAIRS + 1;

export type PlannerUsage = { inputTokens: number; outputTokens: number };

export type PlanMissionSuccess = {
  ok: true;
  mission: MissionInput;
  /** Warnings that survived the loop. Errors cannot: they trigger a repair. */
  issues: Issue[];
  /** Model calls made, including the successful one. */
  attempts: number;
  model: string;
  promptVersion: string;
  usage: PlannerUsage;
};

export type PlanMissionFailure = {
  ok: false;
  code: PlannerErrorCode;
  message: string;
  attempts: number;
  usage: PlannerUsage;
};

export type PlanMissionResult = PlanMissionSuccess | PlanMissionFailure;

export type PlanMissionOptions = {
  layout: Layout;
  brief: string;
  create: MessageCreator;
  model?: string;
  timeoutMs?: number;
};

const EMIT_MISSION_TOOL: Anthropic.Tool = {
  name: EMIT_MISSION_TOOL_NAME,
  description: TOOL_DESCRIPTION,
  // Derived from MissionSchema — see the note in prompts/plan-mission.ts. The
  // cast narrows the generic JSON Schema object to the SDK's input_schema type;
  // the top-level `type: 'object'` the SDK requires is guaranteed by the Zod
  // schema being an object schema.
  input_schema: MISSION_JSON_SCHEMA as Anthropic.Tool.InputSchema,
};

export async function planMission(options: PlanMissionOptions): Promise<PlanMissionResult> {
  const { layout, brief, create, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const model = options.model ?? plannerModel();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildUserPrompt(layout, brief) },
  ];

  const usage: PlannerUsage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let lastProblems: string[] = [];

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;

    const response = await sendMessage(
      create,
      {
        model,
        max_tokens: MAX_TOKENS,
        // Planning is a lookup, not a brainstorm: the same brief against the
        // same layout should give the same plan twice.
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools: [EMIT_MISSION_TOOL],
        // Forced, so the plan arrives as structured tool input rather than as
        // JSON embedded in prose. The text fallback below exists because
        // "forced" is not "guaranteed".
        tool_choice: { type: 'tool', name: EMIT_MISSION_TOOL_NAME, disable_parallel_tool_use: true },
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

    const outcome = evaluate(layout, response.message);

    if (outcome.ok) {
      return {
        ok: true,
        mission: outcome.mission,
        issues: outcome.issues,
        attempts,
        model,
        promptVersion: PROMPT_VERSION,
        usage,
      };
    }

    // A plan that is over the step cap is not a modelling mistake to negotiate
    // over — it is a guard, and it fails now rather than after two more calls.
    if (outcome.fatal) {
      return { ok: false, code: 'INVALID_OUTPUT', message: outcome.message, attempts, usage };
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
// Evaluating one response
// ---------------------------------------------------------------------------

type Evaluation =
  | { ok: true; mission: MissionInput; issues: Issue[] }
  | { ok: false; fatal: true; message: string }
  | { ok: false; fatal: false; problems: string[]; toolUseId: string | null };

function evaluate(layout: Layout, message: Anthropic.Message): Evaluation {
  const extracted = extractPlan(message);

  if (!extracted.ok) {
    return { ok: false, fatal: false, problems: [extracted.problem], toolUseId: null };
  }

  const parsed = MissionSchema.safeParse(extracted.value);

  if (!parsed.success) {
    return {
      ok: false,
      fatal: false,
      problems: formatZodError(parsed.error),
      toolUseId: extracted.toolUseId,
    };
  }

  if (parsed.data.steps.length > MAX_PLAN_STEPS) {
    return {
      ok: false,
      fatal: true,
      message: `The planner produced ${parsed.data.steps.length} steps; the limit is ${MAX_PLAN_STEPS}. Try a narrower brief.`,
    };
  }

  const issues = validateMission(layout, parsed.data);

  // Warnings are the user's business, not the model's. `ENDS_CARRYING` on a
  // brief that says "go and fetch it" is a correct plan, and bouncing it back
  // would cost a call to fix something that is not broken.
  if (hasBlockingIssues(issues)) {
    return {
      ok: false,
      fatal: false,
      problems: issues.filter((issue) => issue.severity === 'error').map(describeIssue),
      toolUseId: extracted.toolUseId,
    };
  }

  return { ok: true, mission: parsed.data, issues };
}

function describeIssue(issue: Issue): string {
  const where = issue.stepIndex === null ? 'the plan' : `step ${issue.stepIndex}`;

  return `${issue.code} in ${where}: ${issue.message}`;
}

function formatZodError(error: z.ZodError): string[] {
  // Bounded: a badly wrong plan can produce an issue per step per union branch,
  // and pasting eighty of them into the repair turn buries the useful ones.
  return error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.length === 0 ? 'plan' : issue.path.join('.');

    return `${path}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Getting the plan out of the response
// ---------------------------------------------------------------------------

type Extraction =
  | { ok: true; value: unknown; toolUseId: string | null }
  | { ok: false; problem: string };

/**
 * Reads the plan from the `tool_use` block — never by string-parsing text.
 *
 * The fallback below is the exception that proves it: `tool_choice` makes a
 * tool call overwhelmingly likely, not certain, and a model that answers in
 * prose anyway would otherwise burn a repair on a plan that was probably fine.
 * It is a second-best path, and it is only reached when there is no tool block
 * at all.
 */
function extractPlan(message: Anthropic.Message): Extraction {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === EMIT_MISSION_TOOL_NAME) {
      return { ok: true, value: block.input, toolUseId: block.id };
    }
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text.length === 0) {
    return { ok: false, problem: 'The planner returned no plan. Call emit_mission.' };
  }

  try {
    return { ok: true, value: JSON.parse(stripFences(text)), toolUseId: null };
  } catch {
    return {
      ok: false,
      problem: 'The planner replied with prose instead of calling emit_mission.',
    };
  }
}

/**
 * Pulls JSON out of a markdown fence, or out of surrounding chatter.
 *
 * Only ever applied to the fallback path. Models that ignore `tool_choice` tend
 * to ignore "no prose" too, so "here is the plan:\n```json\n{...}\n```" is the
 * shape this has to survive.
 */
export function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);

  if (fenced !== null) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

// ---------------------------------------------------------------------------
// The repair turn
// ---------------------------------------------------------------------------

/**
 * The correction, shaped to whatever the model actually sent.
 *
 * An echoed assistant turn containing a `tool_use` block *must* be answered by
 * a `tool_result` with the matching id — the API rejects the request otherwise.
 * So the correction rides inside the tool result when there was a tool call,
 * and is a plain user turn when the model answered in text.
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
 * The model's own problem list is the most useful thing available — it names
 * the station that does not exist — but it is capped so a wall of Zod paths
 * does not end up in the UI.
 */
function userFacingFailure(problems: string[]): string {
  if (problems.length === 0) {
    return 'The planner could not produce a valid plan for this brief.';
  }

  return [
    'The planner could not produce a valid plan for this brief. Last problems:',
    ...problems.slice(0, 3).map((problem) => `• ${problem}`),
  ].join(' ');
}
