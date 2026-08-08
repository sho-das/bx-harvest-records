import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool';
import { LlmService } from './llm';
import { checkIntent, describeFilter } from './intent.schema';
import {
  selectAnswerKg,
  selectCountedRows,
  selectNotCountedRows,
  selectParkedRows,
  selectSourceSummary,
  type CountedRow,
  type NotCountedRow,
  type ParkedRow,
} from './queries';

export type Answer = {
  answered: true;
  answer_kg: string;
  understood_as: Record<string, string | null>;
  counted: CountedRow[];
  not_counted: NotCountedRow[];
  parked: ParkedRow[];
  source: { file: string; rows_read: number; rows_in_scope: number };
  read_by: { provider: string; model: string };
};

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
   */
  async ask(question: string): Promise<Answer> {
    const { intent, provider, model } = await this.llm.read(question);
    const filter = checkIntent(intent);

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
      answer_kg: answerKg,
      understood_as: describeFilter(filter),
      counted,
      not_counted: notCounted,
      parked,
      source,
      read_by: { provider, model },
    };
  }
}
