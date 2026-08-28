import { describe, expect, it } from 'vitest';

import { missionNameFromBrief, rateLimitExceeded } from '../../../src/lib/missions/mission-api';
import {
  AI_GENERATIONS_PER_HOUR,
  BRIEF_MAX_CHARS,
  BoundedMissionSchema,
  GenerateMissionSchema,
  MAX_PLAN_STEPS,
  MissionSchema,
  UpdateMissionSchema,
} from '../../../src/lib/schemas/mission';

const LAYOUT_ID = '11111111-2222-4333-8444-555555555555';

function movesteps(count: number) {
  return Array.from({ length: count }, () => ({ op: 'MOVE_TO', stationId: 'shelf-1' }));
}

describe('brief guard', () => {
  it('accepts a normal brief', () => {
    const parsed = GenerateMissionSchema.safeParse({
      layoutId: LAYOUT_ID,
      brief: 'pick a crate from shelf A and drop it at the dock',
    });

    expect(parsed.success).toBe(true);
  });

  it(`rejects a brief over ${BRIEF_MAX_CHARS} characters`, () => {
    const parsed = GenerateMissionSchema.safeParse({
      layoutId: LAYOUT_ID,
      brief: 'x'.repeat(BRIEF_MAX_CHARS + 1),
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a brief of exactly the cap', () => {
    const parsed = GenerateMissionSchema.safeParse({
      layoutId: LAYOUT_ID,
      brief: 'x'.repeat(BRIEF_MAX_CHARS),
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects an empty or whitespace-only brief', () => {
    for (const brief of ['', '   ', '\n\n']) {
      expect(GenerateMissionSchema.safeParse({ layoutId: LAYOUT_ID, brief }).success).toBe(false);
    }
  });

  it('rejects a layoutId that is not a uuid', () => {
    const parsed = GenerateMissionSchema.safeParse({ layoutId: 'nope', brief: 'do a thing' });

    expect(parsed.success).toBe(false);
  });
});

describe('step-cap guard', () => {
  it(`accepts a plan of exactly ${MAX_PLAN_STEPS} steps`, () => {
    expect(BoundedMissionSchema.safeParse({ steps: movesteps(MAX_PLAN_STEPS) }).success).toBe(true);
  });

  it('rejects one step over the cap', () => {
    const parsed = BoundedMissionSchema.safeParse({ steps: movesteps(MAX_PLAN_STEPS + 1) });

    expect(parsed.success).toBe(false);
  });

  it('rejects an over-cap plan on save as well as on generate', () => {
    const parsed = UpdateMissionSchema.safeParse({
      name: 'Long haul',
      plan: { steps: movesteps(MAX_PLAN_STEPS + 1) },
    });

    expect(parsed.success).toBe(false);
  });

  it('leaves the uncapped schema alone so stored plans still load', () => {
    // The cap is a product guard, not a property of the type — a row written
    // before it existed must still parse, or the editor cannot open it to fix.
    expect(MissionSchema.safeParse({ steps: movesteps(MAX_PLAN_STEPS + 5) }).success).toBe(true);
  });
});

describe('rate limit', () => {
  it(`allows the first ${AI_GENERATIONS_PER_HOUR} generations in an hour`, () => {
    expect(rateLimitExceeded(0)).toBe(false);
    expect(rateLimitExceeded(AI_GENERATIONS_PER_HOUR - 1)).toBe(false);
  });

  it('blocks once the hour is used up', () => {
    expect(rateLimitExceeded(AI_GENERATIONS_PER_HOUR)).toBe(true);
    expect(rateLimitExceeded(AI_GENERATIONS_PER_HOUR + 3)).toBe(true);
  });
});

describe('mission naming', () => {
  it('uses the first line of the brief', () => {
    expect(missionNameFromBrief('fetch a bolt\nthen charge')).toBe('fetch a bolt');
  });

  it('truncates a long brief rather than storing it twice', () => {
    const name = missionNameFromBrief('x'.repeat(500));

    expect(name).toHaveLength(58);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back when the brief is only whitespace', () => {
    expect(missionNameFromBrief('   ')).toBe('Generated mission');
  });
});
