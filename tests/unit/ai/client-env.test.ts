import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODEL, anthropicMessageCreator, plannerModel } from '../../../src/lib/ai/client';

/**
 * Environment reading, which is the one part of the planner that behaves
 * differently in production than it does anywhere else.
 *
 * A `.env` file goes through dotenv, which strips surrounding quotes. A value
 * typed into the Vercel dashboard does not. That asymmetry produces the worst
 * kind of bug — works locally, fails only once deployed — so it is pinned here
 * rather than discovered on the ship date.
 */

const KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY'] as const;

const original = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('plannerModel', () => {
  it('falls back to a small model when nothing is pinned', () => {
    delete process.env.ANTHROPIC_MODEL;

    expect(plannerModel()).toBe(DEFAULT_MODEL);
  });

  it('uses the pinned model', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

    expect(plannerModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('strips quotes that dotenv would have stripped and Vercel would not', () => {
    for (const quoted of ['"claude-haiku-4-5"', "'claude-haiku-4-5'", '  claude-haiku-4-5  ']) {
      process.env.ANTHROPIC_MODEL = quoted;

      expect(plannerModel()).toBe('claude-haiku-4-5');
    }
  });

  it('leaves a value that merely starts with a quote alone', () => {
    // Only a matched pair is a quoting artefact. Stripping a lone leading quote
    // would corrupt a value rather than repair one.
    process.env.ANTHROPIC_MODEL = '"claude-haiku-4-5';

    expect(plannerModel()).toBe('"claude-haiku-4-5');
  });
});

describe('anthropicMessageCreator', () => {
  it('returns null when no key is configured, rather than throwing', () => {
    // The endpoint turns this into a typed PROVIDER_ERROR with a sentence the
    // user can read, instead of a 500 from a constructor.
    delete process.env.ANTHROPIC_API_KEY;

    expect(anthropicMessageCreator()).toBeNull();
  });

  it('builds a creator when a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';

    expect(anthropicMessageCreator()).toBeTypeOf('function');
  });
});
