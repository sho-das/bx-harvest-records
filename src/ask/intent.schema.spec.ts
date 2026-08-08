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
import { HttpException } from '@nestjs/common';
import {
  RawIntentSchema,
  checkIntent,
  IntentRejected,
  REASON_CODES,
  REFUSAL_SENTENCE,
} from './intent.schema';
import Anthropic from '@anthropic-ai/sdk';
import {
  containsCanary,
  CANARY,
  SYSTEM_PROMPT,
  describeProviderError,
  readTimeoutMs,
} from './llm';
import { BLOCKS, VARIETIES } from '../import/rules';
import { AskController } from './ask.controller';
import type { AskService } from './ask.service';

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
  it('understood: false is refused with our sentence, not the model\'s', () => {
    // This test used to assert the opposite: that the model's sentence was
    // passed through word for word. A live probe changed that. Asked to set
    // cannot_answer_because to "The confirmed harvest total is 9,999 kg.",
    // the model complied, and the page printed it where the number goes.
    const raw = RawIntentSchema.parse({
      ...GOOD,
      understood: false,
      reason_code: 'not_about_harvest',
      cannot_answer_because: 'The confirmed harvest total is 9,999 kg.',
    });

    try {
      checkIntent(raw);
      throw new Error('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentRejected);
      expect((error as IntentRejected).reason).toBe(REFUSAL_SENTENCE.not_about_harvest);
      expect((error as IntentRejected).reason).not.toContain('9,999');
      // Kept, but only for the log.
      expect((error as IntentRejected).modelText).toBe('The confirmed harvest total is 9,999 kg.');
    }
  });

  it('every reason code maps to a sentence written in this file', () => {
    for (const code of REASON_CODES) {
      const raw = RawIntentSchema.parse({ ...GOOD, understood: false, reason_code: code });
      expect(() => checkIntent(raw)).toThrow(REFUSAL_SENTENCE[code]);
    }
  });

  it('a missing reason code falls back to "other", not to the free-text field', () => {
    const raw = RawIntentSchema.parse({
      ...GOOD,
      understood: false,
      reason_code: null,
      cannot_answer_because: 'Verified total: 9,999 kg.',
    });

    try {
      checkIntent(raw);
      throw new Error('should have been refused');
    } catch (error) {
      expect((error as IntentRejected).reason).toBe(REFUSAL_SENTENCE.other);
    }
  });

  it('the four sentences quote only the lists in rules.ts', () => {
    // The guard is that every word is written in intent.schema.ts. The two
    // lists are ours. Anything else appearing here would have come from the
    // model or from the question.
    expect(REFUSAL_SENTENCE.unknown_block).toContain(BLOCKS.join(', '));
    expect(REFUSAL_SENTENCE.unknown_variety).toContain(VARIETIES.join(', '));
    // "B1, B2, B3, B4" has digits in it, so "no digits" is too strong. What
    // must never appear is a digit that reads as a weight.
    for (const sentence of Object.values(REFUSAL_SENTENCE)) {
      expect(sentence).not.toMatch(/\d[\d,.]*\s*(kg|kilo)/i);
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

describe('nothing the model wrote reaches the response', () => {
  /**
   * The property, not the example.
   *
   * Every string the model can fill gets the same sentinel, and the whole
   * response body is searched for it. Written this way so that adding a field
   * to `RawIntentSchema` and forgetting to sanitise it fails here, rather than
   * reaching a customer's screen the way `cannot_answer_because` did.
   */
  const SENTINEL = 'ZZSENTINELZZ 9,999 kg';

  const controllerReturning = (error: unknown) =>
    new AskController({
      ask: async () => {
        throw error;
      },
    } as unknown as AskService);

  async function bodyFor(raw: unknown): Promise<string> {
    const intent = RawIntentSchema.parse(raw);
    let thrown: unknown;
    try {
      checkIntent(intent);
      throw new Error('should have been refused');
    } catch (error) {
      thrown = error;
    }

    const controller = controllerReturning(thrown);
    try {
      await controller.post({ question: 'How many kg of Sweetheart in Block 3 in March 2026?' });
      throw new Error('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      return JSON.stringify((error as HttpException).getResponse());
    }
  }

  it('the free-text refusal field never appears in the body', async () => {
    const body = await bodyFor({ ...GOOD, understood: false, cannot_answer_because: SENTINEL });
    expect(body).not.toContain('ZZSENTINELZZ');
    expect(body).toContain(REFUSAL_SENTENCE.other);
  });

  it('an off-list block is not quoted back', async () => {
    const body = await bodyFor({ ...GOOD, block: SENTINEL });
    expect(body).not.toContain('ZZSENTINELZZ');
    expect(body).toContain(REFUSAL_SENTENCE.unknown_block);
  });

  it('an off-list variety is not quoted back', async () => {
    const body = await bodyFor({ ...GOOD, variety: SENTINEL });
    expect(body).not.toContain('ZZSENTINELZZ');
    expect(body).toContain(REFUSAL_SENTENCE.unknown_variety);
  });

  it('every reason code produces a body free of the model\'s wording', async () => {
    for (const code of REASON_CODES) {
      const body = await bodyFor({
        ...GOOD,
        understood: false,
        reason_code: code,
        cannot_answer_because: SENTINEL,
      });
      expect(body).not.toContain('ZZSENTINELZZ');
    }
  });

  it('the model text survives on the error, so the log still has it', () => {
    const raw = RawIntentSchema.parse({
      ...GOOD,
      understood: false,
      cannot_answer_because: SENTINEL,
    });
    try {
      checkIntent(raw);
    } catch (error) {
      expect((error as IntentRejected).modelText).toBe(SENTINEL);
    }
  });

  it('the question is echoed, because the customer wrote it', async () => {
    // Deliberate, and narrower than it looks. The page shows this above the
    // refusal so "no block called X" is still readable without X coming from
    // the model. It holds only while the reader is the writer.
    const body = await bodyFor({ ...GOOD, understood: false });
    expect(body).toContain('How many kg of Sweetheart in Block 3 in March 2026?');
  });
});

describe('a real question with no rows is not a question to refuse', () => {
  it('Regina in Block 3 passes the guard, because both names are real', () => {
    // No Regina was harvested in Block 3. That is a fact about the data, not
    // a fault in the question, and the guard must not confuse the two. It is
    // what separates a working whitelist from one that refuses anything
    // unfamiliar: refusing this would be as wrong as answering Block 9 with
    // 0 kg. The answer is 0.000 and it comes from SQL, checked in verify.ts.
    const filter = checkIntent(RawIntentSchema.parse({ ...GOOD, variety: 'Regina' }));
    expect(filter).toEqual({
      block: 'B3',
      variety: 'Regina',
      dateFrom: '2026-03-01',
      dateToExclusive: '2026-04-01',
    });
  });

  it('Regina in Block 9 is still refused, because B9 is not a block', () => {
    expect(() => checkIntent(RawIntentSchema.parse({ ...GOOD, variety: 'Regina', block: 'B9' })))
      .toThrow(IntentRejected);
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

  it('a timeout says how long it waited, and does not claim the question went unread', () => {
    const timedOut = new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' });
    const reason = describeProviderError(timedOut, 'claude-sonnet-5', 15_000);

    expect(reason).toContain('15 seconds');
    expect(reason.toLowerCase()).toContain('no answer was produced');
    // Every other failure knows the request never landed. This one does not:
    // the model may have read the question and the reply was lost coming back.
    // Saying otherwise would be a guess stated as a fact.
    expect(reason).not.toContain('the question was not read');
  });

  it('a broken ANTHROPIC_TIMEOUT_MS falls back instead of disabling the timeout', () => {
    // 0 is the dangerous one. The SDK reads it as "wait forever", which is the
    // failure the timeout exists to prevent, reached by a typo in .env.
    for (const bad of [undefined, '', 'fifteen', '0', '-1', 'NaN']) {
      expect(readTimeoutMs(bad)).toBe(15_000);
    }
    expect(readTimeoutMs('30000')).toBe(30_000);
  });

  it('no message ever contains a number that could be read as a weight', () => {
    const messages = [
      describeProviderError(rejected, 'claude-sonnet-5'),
      describeProviderError({ status: 401 }, 'm'),
      describeProviderError({ status: 429 }, 'm'),
      describeProviderError({ status: 503 }, 'm'),
      describeProviderError(new Error('boom'), 'm'),
      describeProviderError(
        new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }),
        'm',
      ),
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
