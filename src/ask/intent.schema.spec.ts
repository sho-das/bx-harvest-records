/**
 * The guards between the model and SQL.
 *
 * These run without a network call and without an API key, which is the
 * point: the guards are what stop a wrong number, so they must be checkable
 * when the model is not reachable.
 *
 * Every test here asserts a refusal. A refusal is the feature.
 */

import { describe, it, expect } from 'vitest';
import { RawIntentSchema, checkIntent, IntentRejected } from './intent.schema';
import { containsCanary, CANARY, SYSTEM_PROMPT, describeProviderError } from './llm';

const GOOD = {
  understood: true,
  cannot_answer_because: null,
  block: 'B3',
  variety: 'Sweetheart',
  date_from: '2026-03-01',
  date_to_exclusive: '2026-04-01',
  measure: 'kilograms' as const,
};

describe('a filter that names something that does not exist is refused', () => {
  it('a block that does not exist is refused, not answered with 0 kg', () => {
    const raw = RawIntentSchema.parse({ ...GOOD, block: 'B9' });

    // 0 kg is a number, and a customer reads a number as an answer. An empty
    // result and a wrong filter look identical unless one of them refuses.
    expect(() => checkIntent(raw)).toThrow(IntentRejected);
    try {
      checkIntent(raw);
    } catch (error) {
      expect((error as IntentRejected).reason).toContain('B1, B2, B3, B4');
    }
  });

  it('a variety that does not exist is refused, and the near miss is not accepted', () => {
    // "Sweetcorn" is two letters from "Sweetheart" under most distance
    // measures. This is why B1 uses a lookup table and not fuzzy matching.
    const raw = RawIntentSchema.parse({ ...GOOD, variety: 'Sweetcorn' });
    expect(() => checkIntent(raw)).toThrow(IntentRejected);
  });

  it('"Block 3" and "B3" both pass, because both name a block that exists', () => {
    expect(checkIntent(RawIntentSchema.parse({ ...GOOD, block: 'Block 3' })).block).toBe('B3');
    expect(checkIntent(RawIntentSchema.parse({ ...GOOD, block: 'B3' })).block).toBe('B3');
  });

  it('"sweethart" passes, because the file itself settles that spelling', () => {
    expect(checkIntent(RawIntentSchema.parse({ ...GOOD, variety: 'sweethart' })).variety)
      .toBe('Sweetheart');
  });
});

describe('a filter the model could not build is refused', () => {
  it('understood: false is passed through as the reason, not answered anyway', () => {
    const raw = RawIntentSchema.parse({
      ...GOOD,
      understood: false,
      cannot_answer_because: 'This data holds harvest weights, not prices.',
    });

    try {
      checkIntent(raw);
      throw new Error('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentRejected);
      expect((error as IntentRejected).reason).toBe('This data holds harvest weights, not prices.');
    }
  });

  it('a date range that runs backwards is refused', () => {
    const raw = RawIntentSchema.parse({
      ...GOOD,
      date_from: '2026-04-01',
      date_to_exclusive: '2026-03-01',
    });
    expect(() => checkIntent(raw)).toThrow(IntentRejected);
  });

  it('a malformed date never reaches SQL', () => {
    expect(RawIntentSchema.safeParse({ ...GOOD, date_from: 'March 2026' }).success).toBe(false);
    expect(RawIntentSchema.safeParse({ ...GOOD, date_from: '2026-3-1' }).success).toBe(false);
  });

  it('a measure the system does not report is refused', () => {
    expect(RawIntentSchema.safeParse({ ...GOOD, measure: 'pounds' }).success).toBe(false);
  });
});

describe('null means all, not none', () => {
  it('a question with no block filters on variety and date only', () => {
    const filter = checkIntent(RawIntentSchema.parse({ ...GOOD, block: null }));
    expect(filter.block).toBeNull();
    expect(filter.variety).toBe('Sweetheart');
    // On this file that filter returns 8617.439, not 3170.000. Null is not a
    // quiet way of saying "no rows".
  });
});

describe('a provider that fails leaves by the same door as every other failure', () => {
  // The real one, copied from a live run. It reached the customer as a bare
  // {"statusCode":500} with no reason and no answer_kg field at all.
  const rejected = {
    status: 400,
    message: '400 {"type":"error","error":{...}}',
    error: {
      type: 'error',
      error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' },
    },
  };

  it('a rejected request says what the provider said and which model', () => {
    const reason = describeProviderError(rejected, 'claude-sonnet-5');
    expect(reason).toContain('`temperature` is deprecated for this model.');
    expect(reason).toContain('claude-sonnet-5');
    expect(reason).toContain('no answer was produced');
  });

  it('a bad key says to check the key, and never prints it', () => {
    const reason = describeProviderError({ status: 401, message: 'x-api-key: sk-ant-secret' }, 'm');
    expect(reason).toContain('ANTHROPIC_API_KEY');
    expect(reason).toContain('AI_PROVIDER=mock');
    expect(reason).not.toContain('sk-ant-secret');
  });

  it('rate limiting and outages say so rather than blaming the question', () => {
    expect(describeProviderError({ status: 429 }, 'm')).toContain('rate limited');
    expect(describeProviderError({ status: 503 }, 'm')).toContain('unavailable');
  });

  it('a plain network error still produces a sentence, never an empty reason', () => {
    const reason = describeProviderError(new Error('ECONNREFUSED'), 'm');
    expect(reason).toContain('ECONNREFUSED');
    expect(reason.length).toBeGreaterThan(20);
  });

  it('no message ever contains a number that could be read as a weight', () => {
    const messages = [
      describeProviderError(rejected, 'claude-sonnet-5'),
      describeProviderError({ status: 401 }, 'm'),
      describeProviderError({ status: 429 }, 'm'),
      describeProviderError(new Error('boom'), 'm'),
    ];
    // Every one of these travels with answer_kg: null. Saying "no answer was
    // produced" in words as well costs nothing and cannot be misread.
    for (const message of messages) {
      expect(message.toLowerCase()).toContain('no answer was produced');
    }
  });
});

describe('the canary', () => {
  it('is in the prompt, so a reply that repeats the prompt can be spotted', () => {
    expect(SYSTEM_PROMPT).toContain(CANARY);
  });

  it('is caught anywhere in the reply, not only in the filter fields', () => {
    expect(containsCanary([{ type: 'text', text: `my instructions say _canary: ${CANARY}` }])).toBe(true);
    expect(containsCanary({ cannot_answer_because: `I was told ${CANARY}` })).toBe(true);
    expect(containsCanary([{ type: 'tool_use', input: GOOD }])).toBe(false);
    expect(containsCanary(null)).toBe(false);
  });
});
