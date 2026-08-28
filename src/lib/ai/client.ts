/**
 * The Anthropic client. **Server only.**
 *
 * This module reads `ANTHROPIC_API_KEY`. Nothing under `src/components/**` or
 * `src/pages/**` (outside `src/pages/api/**`) may import from `src/lib/ai/**`,
 * and `tests/unit/ai/no-client-ai-imports.test.ts` fails the build if anything
 * does. The browser gets its constants from `src/lib/schemas/mission.ts`
 * instead.
 *
 * Everything the caller needs to know about a failed call is expressed as a
 * `PlannerErrorCode`, never as a thrown SDK exception: the four cases have four
 * different answers in the UI ("try again", "wait an hour", "we are broken",
 * "rewrite your brief"), and a caught-and-rethrown `APIError` loses that.
 */

import Anthropic from '@anthropic-ai/sdk';

import type { PlannerErrorCode } from '../schemas/mission';

/**
 * Wall-clock budget for one model call.
 *
 * Vercel allows far longer, but a planner that has not answered in 20 seconds
 * has effectively failed for a user watching a spinner — and with up to three
 * calls in a repair loop, a longer budget would stack up behind them.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A 40-step plan serialises to well under 2 KB. This is headroom, not a target;
 * it exists so a runaway response is cut off rather than billed in full.
 */
export const MAX_TOKENS = 4096;

/**
 * Planning a six-step warehouse errand is not frontier-model work — the
 * implementation plan says so explicitly, and the whole point of the schema is
 * that a small model cannot go far wrong inside it. Override with
 * `ANTHROPIC_MODEL` in the environment; nothing here is pinned in code.
 *
 * Note for whoever changes this: `temperature` is rejected by the Claude 4.6+
 * and 5 families. Pointing `ANTHROPIC_MODEL` at one of those needs the
 * `temperature: 0` below removed in the same edit.
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * The seam the tests mock.
 *
 * `plan-mission.ts` never touches the SDK directly — it is handed one of these
 * and calls it. Tests hand it a function that replays fixtures from
 * `tests/fixtures/llm/`, so no test can reach the real API even by accident.
 */
export type MessageCreator = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { signal: AbortSignal },
) => Promise<Anthropic.Message>;

export type ProviderFailure = { code: PlannerErrorCode; message: string };

export type ProviderResult =
  | { ok: true; message: Anthropic.Message }
  | ({ ok: false } & ProviderFailure);

/**
 * Reads a server-side variable.
 *
 * Unprefixed names never reach a client bundle — only `PUBLIC_*` does — so
 * these are safe to read this way. `import.meta.env` is what Vite populates in
 * dev and in tests; `process.env` is what the Vercel function runtime actually
 * holds at request time. Checking both means one code path works in all three.
 */
function readEnv(name: string): string | undefined {
  const viteEnv = import.meta.env as unknown as Record<string, unknown>;
  const fromVite = viteEnv[name];

  if (typeof fromVite === 'string' && fromVite.length > 0) return unquote(fromVite);

  const fromProcess = typeof process === 'undefined' ? undefined : process.env[name];

  return typeof fromProcess === 'string' && fromProcess.length > 0
    ? unquote(fromProcess)
    : undefined;
}

/**
 * Drops surrounding quotes.
 *
 * A `.env` file is read by dotenv, which strips them; a Vercel dashboard value
 * is stored byte for byte, which does not. So `ANTHROPIC_MODEL="claude-…"`
 * works locally and 404s on an unknown model in production — a failure that
 * appears only after deploy, on the one path with no test coverage. One line
 * here makes the two environments agree.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  // Both quotes must match, so a value that merely starts with one is left be.
  const match = /^(['"])(.*)\1$/.exec(trimmed);

  return match === null ? trimmed : match[2];
}

export function plannerModel(): string {
  return readEnv('ANTHROPIC_MODEL') ?? DEFAULT_MODEL;
}

/**
 * Builds a `MessageCreator` backed by the real API.
 *
 * `null` when `ANTHROPIC_API_KEY` is unset — a missing key is a deployment
 * problem, and answering it with a typed `PROVIDER_ERROR` gives the user a
 * sentence instead of a 500 page. The client is constructed per call rather
 * than held in a module-level singleton: serverless instances are reused across
 * requests, and a cached client would outlive a rotated key.
 */
export function anthropicMessageCreator(): MessageCreator | null {
  const apiKey = readEnv('ANTHROPIC_API_KEY');

  if (apiKey === undefined) return null;

  // The SDK retries 429s and 5xxs on its own; one retry inside a 20s budget is
  // useful, more would eat the whole window before the repair loop gets a turn.
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  return (params, options) => client.messages.create(params, { signal: options.signal });
}

/**
 * One model call, bounded and with every failure mapped to a typed code.
 *
 * The timeout is ours rather than the SDK's so that "we gave up" is
 * distinguishable from "the connection died" — both surface as an abort, but
 * only one of them is a `TIMEOUT` we caused, and the flag below records which.
 */
export async function sendMessage(
  create: MessageCreator,
  params: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ProviderResult> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const message = await create(params, { signal: controller.signal });

    return { ok: true, message };
  } catch (error) {
    return { ok: false, ...mapProviderError(error, timedOut) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns whatever the SDK threw into one of the four codes.
 *
 * Ordered most specific first, and matched on the SDK's typed classes rather
 * than on message text — a string match here would quietly stop working the
 * first time an error message is reworded.
 */
export function mapProviderError(error: unknown, timedOut = false): ProviderFailure {
  if (timedOut) {
    return { code: 'TIMEOUT', message: 'The planner took too long to answer.' };
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { code: 'TIMEOUT', message: 'The planner took too long to answer.' };
  }

  if (error instanceof Anthropic.RateLimitError) {
    return {
      code: 'RATE_LIMITED',
      message: 'The planner is rate limited right now. Try again in a minute.',
    };
  }

  if (error instanceof Anthropic.APIError) {
    return {
      code: 'PROVIDER_ERROR',
      message: `The planner refused the request (${error.status ?? 'no status'}).`,
    };
  }

  return { code: 'PROVIDER_ERROR', message: 'Could not reach the planner.' };
}

/** The `PROVIDER_ERROR` used when the deployment has no API key configured. */
export function missingKeyFailure(): ProviderFailure {
  return {
    code: 'PROVIDER_ERROR',
    message: 'The planner is not configured on this deployment.',
  };
}
