import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool';
import { BLOCKS, type Block } from '../import/rules';
import { LlmService } from './llm';
import { IntentRejected, checkIntent, describeFilter, type Filter } from './intent.schema';
import {
  selectAnswerKg,
  selectCountedRows,
  selectNotCountedRows,
  selectParkedRows,
  selectSourceSummary,
  selectExtremeBlocks,
  type CountedRow,
  type NotCountedRow,
  type ParkedRow,
} from './queries';

type Understood = Record<string, string | boolean | null>;
type ReadBy = { provider: string; model: string };

/** One filter, one number, and everything the number left out. */
export type SingleAnswer = {
  answered: true;
  comparison: false;
  answer_kg: string;
  understood_as: Understood;
  counted: CountedRow[];
  not_counted: NotCountedRow[];
  parked: ParkedRow[];
  source: { file: string; rows_read: number; rows_in_scope: number };
  read_by: ReadBy;
};

/**
 * Every block, and which one came top.
 *
 * There is no `answer_kg`. The question was "which block", so the answer is a
 * block, and a single headline figure beside it would be a number nobody asked
 * for sitting where the answer goes.
 *
 * `answer_block` is a list even when it holds one entry. A field that is a
 * string sometimes and an array other times makes every reader branch, the
 * page included.
 */
export type ComparisonAnswer = {
  answered: true;
  comparison: true;
  highest: boolean;
  answer_block: Block[];
  tied: boolean;
  by_block: { block: Block; answer_kg: string }[];
  understood_as: Understood;
  read_by: ReadBy;
};

/** `comparison` is the discriminant. Nothing has to sniff for a missing field. */
export type Answer = SingleAnswer | ComparisonAnswer;

/**
 * "3170.000" as thousandths, so two figures can be compared exactly.
 *
 * A comparison, not a calculation. Nothing is added, and no number this
 * produces is ever returned. It exists so the service can check that the block
 * Postgres named as the winner really does hold the largest figure in the
 * table printed beside it.
 *
 * `NUMERIC(12,3)::text` always writes three decimals, and a block total can be
 * negative because a correction row can be, so the sign is handled rather than
 * assumed away.
 */
function milli(kg: string): bigint {
  const [whole, fraction = ''] = kg.split('.');
  const digits = BigInt(whole.replace('-', '') + fraction.padEnd(3, '0'));
  return whole.startsWith('-') ? -digits : digits;
}

@Injectable()
export class AskService {
  constructor(private readonly llm: LlmService) {}

  /**
   * The whole path, in order:
   *
   *   1. The model reads the question and returns a filter. Nothing else.
   *   2. The filter is checked. A block or variety that does not exist is
   *      rejected here, before any SQL runs.
   *   3. Postgres produces every number.
   *   4. The response carries the number together with what was left out.
   *
   * Steps 1 and 2 are the only places a wrong answer can start, and step 2
   * cannot be skipped: `checkIntent` is the only thing that produces the
   * `Filter` type the queries take.
   *
   * Step 3 runs five queries either way. Which five depends on the one flag
   * the model sets, and that flag is decided before any of them run.
   */
  async ask(question: string): Promise<Answer> {
    const { intent, provider, model } = await this.llm.read(question);
    const filter = checkIntent(intent);
    const readBy = { provider, model };

    return filter.blockComparison
      ? this.compareBlocks(filter, filter.highest, readBy)
      : this.answerOne(filter, readBy);
  }

  /** One filter, one number, and every row the number left out. */
  private async answerOne(filter: Filter, readBy: ReadBy): Promise<SingleAnswer> {
    const pool = getPool();
    const [answerKg, counted, notCounted, parked, source] = await Promise.all([
      selectAnswerKg(pool, filter),
      selectCountedRows(pool, filter),
      selectNotCountedRows(pool, filter),
      selectParkedRows(pool, filter),
      selectSourceSummary(pool, filter),
    ]);

    return {
      answered: true,
      comparison: false,
      answer_kg: answerKg,
      understood_as: describeFilter(filter),
      counted,
      not_counted: notCounted,
      parked,
      source,
      read_by: readBy,
    };
  }

  /**
   * The same question asked once per block, plus the query that ranks them.
   *
   * Five queries again. Four of them are `selectAnswerKg` with a different
   * block and everything else identical, which is what makes this a comparison
   * rather than four unrelated figures. `BLOCKS` decides how many run and in
   * what order, so nothing here declares a second time what the blocks are.
   *
   * The counted, not-counted, parked and source queries do not run. They
   * describe one filter, and there are four here.
   */
  private async compareBlocks(
    filter: Filter,
    highest: boolean,
    readBy: ReadBy,
  ): Promise<ComparisonAnswer> {
    const pool = getPool();
    const [totals, answerBlock] = await Promise.all([
      Promise.all(BLOCKS.map((block) => selectAnswerKg(pool, { ...filter, block }))),
      selectExtremeBlocks(pool, filter, highest),
    ]);

    const byBlock = BLOCKS.map((block, i) => ({ block, answer_kg: totals[i] }));

    /**
     * The named block and the figures come out of different queries, so they
     * can disagree, and a comparison naming a block that is not at the end of
     * the table printed beside it is exactly the wrong answer this system
     * exists to stop. When they disagree there is no way to tell which one is
     * wrong, so neither is returned.
     *
     * The comparison flips with the direction. Asking for the least and
     * checking against the most is the same bug this catches, written into the
     * check itself, so the direction is threaded through rather than assumed.
     *
     * In practice this never fires. It is here because "two queries over the
     * same data agree" is an assumption, and an assumption that is never
     * checked is the one that breaks quietly.
     */
    const beats = (a: string, b: string) =>
      highest ? milli(a) > milli(b) : milli(a) < milli(b);

    const end = byBlock.reduce((a, b) => (beats(b.answer_kg, a.answer_kg) ? b : a));
    const expected = byBlock
      .filter((row) => milli(row.answer_kg) === milli(end.answer_kg))
      .map((row) => row.block);

    if ([...expected].sort().join(',') !== [...answerBlock].sort().join(',')) {
      throw new IntentRejected(
        `The blocks came back with a total that does not match the block named as ${
          highest ? 'highest' : 'lowest'
        }, so nothing was returned. This is a fault in this service, not in the question.`,
      );
    }

    return {
      answered: true,
      comparison: true,
      highest,
      answer_block: answerBlock,
      tied: answerBlock.length > 1,
      by_block: byBlock,
      understood_as: describeFilter(filter),
      read_by: readBy,
    };
  }
}
