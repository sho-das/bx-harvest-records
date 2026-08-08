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

/** The raw shape the model returns. Nothing here is trusted yet. */
export const RawIntentSchema = z.object({
  understood: z.boolean(),
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

export class IntentRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'IntentRejected';
  }
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
    throw new IntentRejected(
      raw.cannot_answer_because ?? 'The question could not be turned into a filter.',
    );
  }

  let block: Block | null = null;
  if (raw.block !== null) {
    block = readBlock(raw.block);
    if (!block) {
      throw new IntentRejected(
        `There is no block called "${raw.block}" in this data. The blocks that exist are ${BLOCKS.join(', ')}.`,
      );
    }
  }

  let variety: Variety | null = null;
  if (raw.variety !== null) {
    variety = readVariety(raw.variety);
    if (!variety) {
      throw new IntentRejected(
        `There is no variety called "${raw.variety}" in this data. The varieties that exist are ${VARIETIES.join(', ')}.`,
      );
    }
  }

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
