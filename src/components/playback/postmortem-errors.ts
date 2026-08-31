import type { PlannerErrorCode } from '../../lib/schemas/mission';

/**
 * What the user should *do* when the postmortem fails.
 *
 * Same four codes as the planner — one taxonomy, one server mapping — but
 * different copy, because the situation is different. A failed generation leaves
 * the user with nothing; a failed postmortem leaves them with the failure code
 * and detail already on the page. So none of these say "try a different brief",
 * and all of them are quieter: the run page is still useful without this card.
 *
 * The views live here rather than being shared with `planner-errors.ts` for
 * exactly that reason. Sharing them would force one wording onto two situations
 * whose only common ground is the code.
 */
export type PostmortemErrorView = {
  title: string;
  hint: string;
  /** Whether pressing Explain again is worth the user's time. */
  retryable: boolean;
};

const VIEWS: Record<PlannerErrorCode, PostmortemErrorView> = {
  TIMEOUT: {
    title: 'The explanation timed out',
    hint: 'Nothing was saved, so trying again costs nothing but the wait.',
    retryable: true,
  },
  RATE_LIMITED: {
    title: 'Rate limited',
    hint: 'Too many requests in a short window. The failure details above are unaffected.',
    retryable: false,
  },
  PROVIDER_ERROR: {
    title: 'The explainer is unavailable',
    hint: 'This is our side, not your mission. Try again shortly.',
    retryable: true,
  },
  INVALID_OUTPUT: {
    title: 'No usable explanation',
    hint: 'Three attempts came back unusable. The failure code and detail above still say where the run stopped.',
    retryable: false,
  },
};

export function postmortemErrorView(code: PlannerErrorCode): PostmortemErrorView {
  return VIEWS[code];
}
