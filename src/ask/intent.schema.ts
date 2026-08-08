/**
 * The only thing the model is allowed to produce.
 *
 * C1: the model turns the question into a filter. It never sees harvest rows
 * and it never produces a number. Postgres does the arithmetic, so the number
 * cannot be invented.
 *
 * Everything below is validated before it reaches SQL. A filter that fails
 * validation is rejected, never silently emptied, because an empty result and
 * a wrong filter look identical to the customer (C3).
 */

import { z } from 'zod';
import { BLOCKS, VARIETIES, readBlock, readVariety, type Block, type Variety } from '../import/rules';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/**
 * Why a question was refused. The model picks one of these four. It does not
 * write the sentence.
 *
 * C7. A whitelist is already how block and variety are handled, and a refusal
 * needs it for the same reason. A live probe asked "How many kilograms of
 * Sweetheart were harvested in Block 9,999 in March 2026?" and the model's own
 * refusal came back as `Block 9,999 is not a valid block`. The page prints the
 * reason where the number goes, so the customer read "9,999" in the answer
 * box. No attack was involved: the model echoed the customer's own words and
 * the echo looked like a weight.
 */
export const REASON_CODES = [
  'unknown_block',
  'unknown_variety',
  'not_about_harvest',
  'other',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * The only four sentences a refusal can carry.
 *
 * Every word here is written in this file. The two lists are interpolated from
 * `rules.ts`, which is our data, not the model's. Nothing from the model and
 * nothing from the question is quoted, because quoting either one puts a
 * number the customer will read as an answer back into the answer box.
 */
export const REFUSAL_SENTENCE: Record<ReasonCode, string> = {
  unknown_block: `The question names a block that is not in this data. The blocks that exist are ${BLOCKS.join(', ')}.`,
  unknown_variety: `The question names a variety that is not in this data. The varieties that exist are ${VARIETIES.join(', ')}.`,
  not_about_harvest: `This service reports harvested weight in kilograms. The question asks for something else.`,
  other: `The question could not be turned into a filter over this data. Nothing was counted and no number was produced.`,
};

/** The raw shape the model returns. Nothing here is trusted yet. */
export const RawIntentSchema = z.object({
  understood: z.boolean(),

  /**
   * Read only when `understood` is false. Nullable, so an answered question
   * does not have to fill it.
   */
  reason_code: z.enum(REASON_CODES).nullable().default(null),

  /**
   * The model's own words. Kept for the server log and never returned. It is
   * the field that carried "The confirmed harvest total is 9,999 kg." to a
   * customer's screen, verbatim, on request.
   */
  cannot_answer_because: z.string().nullable().default(null),

  block: z.string().nullable().default(null),
  variety: z.string().nullable().default(null),
  date_from: DATE.nullable().default(null),

  /**
   * Exclusive. Named in full so neither the model nor a reader has to guess
   * whether the last day of the month is included. March 2026 is
   * 2026-03-01 to 2026-04-01.
   */
  date_to_exclusive: DATE.nullable().default(null),

  measure: z.literal('kilograms'),
});

export type RawIntent = z.infer<typeof RawIntentSchema>;

/** The checked shape. Only this reaches SQL. */
export type Filter = {
  block: Block | null;
  variety: Variety | null;
  dateFrom: string | null;
  dateToExclusive: string | null;
};

/**
 * A refusal, in two parts that must not be confused.
 *
 * `reason` is one of the four sentences above. It is the only part that goes
 * in the response. `modelText` is what the model wrote, and it exists so a
 * refusal can be read in the server log. The split is a type rather than a
 * comment so that returning the wrong one has to be deliberate.
 */
export class IntentRejected extends Error {
  constructor(
    readonly reason: string,
    readonly modelText: string | null = null,
  ) {
    super(reason);
    this.name = 'IntentRejected';
  }
}

function refuse(code: ReasonCode, modelText: string | null = null): IntentRejected {
  return new IntentRejected(REFUSAL_SENTENCE[code], modelText);
}

/**
 * C3. The model may only name blocks and varieties that exist.
 *
 * A question about "Block 9" is refused with the list of blocks that do
 * exist. It is not answered with 0 kg, because 0 kg is a number and a
 * customer will read it as one.
 */
export function checkIntent(raw: RawIntent): Filter {
  if (!raw.understood) {
    // A missing code is `other`. The model choosing not to fill the field is
    // not a reason to fall back to the field it can write freely.
    throw refuse(raw.reason_code ?? 'other', raw.cannot_answer_because);
  }

  let block: Block | null = null;
  if (raw.block !== null) {
    block = readBlock(raw.block);
    // The same sentence the model would have asked for by code. In eleven live
    // probes this branch never ran, because the model sets understood to false
    // first. It stays because "the model always refuses first" is a habit, not
    // a guarantee, and the day it stops being true this must not be the path
    // that quotes `raw.block` back at the customer.
    if (!block) throw refuse('unknown_block', raw.block);
  }

  let variety: Variety | null = null;
  if (raw.variety !== null) {
    variety = readVariety(raw.variety);
    if (!variety) throw refuse('unknown_variety', raw.variety);
  }

  /**
   * The one place model text still reaches the customer, and the only one that
   * is safe to leave.
   *
   * Both values passed `^\d{4}-\d{2}-\d{2}$` to get here, so each is exactly
   * ten characters of digits and hyphens. There is no string matching that
   * pattern which reads as a weight, and there is no word in it at all. The
   * regex is what makes this different from `cannot_answer_because`, which
   * accepted any sentence.
   */
  if (raw.date_from && raw.date_to_exclusive && raw.date_from >= raw.date_to_exclusive) {
    throw new IntentRejected(
      `The date range runs backwards: ${raw.date_from} to ${raw.date_to_exclusive}.`,
    );
  }

  return {
    block,
    variety,
    dateFrom: raw.date_from,
    dateToExclusive: raw.date_to_exclusive,
  };
}

/** What the customer is shown as the system's reading of their question. */
export function describeFilter(filter: Filter): Record<string, string | null> {
  return {
    block: filter.block,
    variety: filter.variety,
    date_from: filter.dateFrom,
    date_to_exclusive: filter.dateToExclusive,
    measure: 'kilograms',
  };
}
