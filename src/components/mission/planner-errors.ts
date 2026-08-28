import { PLANNER_ERROR_CODES, type PlannerErrorCode } from '../../lib/schemas/mission';

/**
 * What the user should *do* about each failure.
 *
 * The four codes have four different answers, so they get four different
 * cards. Collapsing them into "something went wrong" would leave someone
 * retrying a brief that will never work, or rewriting a brief that was fine and
 * merely arrived while the provider was down.
 */
export type PlannerErrorView = {
  title: string;
  hint: string;
  /** Whether pressing Generate again is worth the user's time. */
  retryable: boolean;
};

const VIEWS: Record<PlannerErrorCode, PlannerErrorView> = {
  TIMEOUT: {
    title: 'The planner timed out',
    hint: 'It did not answer within 20 seconds. Nothing was saved — try again.',
    retryable: true,
  },
  RATE_LIMITED: {
    title: 'Rate limited',
    hint: 'Too many generations in a short window. Existing plans can still be edited and run.',
    retryable: false,
  },
  PROVIDER_ERROR: {
    title: 'The planner is unavailable',
    hint: 'This is our side, not your brief. Try again shortly.',
    retryable: true,
  },
  INVALID_OUTPUT: {
    title: 'No valid plan for this brief',
    hint: 'The planner tried three times and could not produce a plan this layout can run. Naming the stations you mean usually fixes it.',
    retryable: false,
  },
};

/** A server `code` is untrusted input like any other — narrowed, not cast. */
export function isPlannerErrorCode(value: unknown): value is PlannerErrorCode {
  return typeof value === 'string' && (PLANNER_ERROR_CODES as readonly string[]).includes(value);
}

export function plannerErrorView(code: PlannerErrorCode): PlannerErrorView {
  return VIEWS[code];
}
