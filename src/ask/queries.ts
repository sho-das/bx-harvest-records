/**
 * The three statements that run per request.
 *
 * Every number the customer sees comes out of one of these. The application
 * never adds two numbers together: not the total, not a parked row's delta,
 * not the figure the answer would become. If a number is wrong, it is wrong
 * in SQL, where it can be run by hand and looked at.
 *
 * NUMERIC comes back as a string on purpose. Turning "3170.000" into a
 * JavaScript number and back is a rounding step nobody asked for.
 */

import type { Pool } from 'pg';
import { BLOCKS, type Block } from '../import/rules';
import type { Filter } from './intent.schema';

export type CountedRow = {
  line: number;
  date: string;
  quantity_raw: string | null;
  unit_raw: string | null;
  quantity_kg: string;
  read_as: string | null;
};

export type NotCountedRow = {
  line: number;
  status: string;
  date: string | null;
  quantity_raw: string | null;
  unit_raw: string | null;
  reason: string;
  superseded_by_line: number | null;
};

export type ParkedOption = {
  label: string;
  row_becomes_kg: string | null;
  in_range: boolean;
  answer_becomes_kg: string | null;
};

export type ParkedRow = {
  line: number;
  field: string;
  question: string;
  evidence: string | null;
  free_text: boolean;
  options: ParkedOption[];
};

/**
 * Shared WHERE for rows that definitely match. NULL in a filter means "all".
 *
 * Written once and rendered with or without a table prefix. `selectTopBlocks`
 * joins a second table, so there `block` on its own is ambiguous. One
 * definition means the block comparison cannot drift from the answer it is
 * comparing.
 */
const matches = (prefix = '') => `
      ($1::text IS NULL OR ${prefix}block   = $1)
  AND ($2::text IS NULL OR ${prefix}variety = $2)
  AND ($3::date IS NULL OR ${prefix}harvest_date >= $3)
  AND ($4::date IS NULL OR ${prefix}harvest_date <  $4)
`;

const MATCHES = matches();

function params(filter: Filter) {
  return [filter.block, filter.variety, filter.dateFrom, filter.dateToExclusive];
}

// ---------------------------------------------------------------------------
// 1. The number
// ---------------------------------------------------------------------------

/**
 * The cast on the COALESCE is not decoration.
 *
 * `SUM` over an empty set is NULL, and the literal 0 that replaces it is an
 * integer, so the answer came back as "0" where a matching query returns
 * "3170.000". Two shapes for the same field. A client that formats or compares
 * on the string, or asserts a fixed number of decimals, breaks on the one case
 * nobody thinks to test: a question that is entirely valid and has no rows.
 *
 * Regina in Block 3 is that case. Both names are real, so nothing refuses it,
 * and the honest answer is zero.
 */
export async function selectAnswerKg(pool: Pool, filter: Filter): Promise<string> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(quantity_kg), 0)::numeric(12,3)::text AS answer_kg
       FROM harvest_record
      WHERE status = 'counted' AND ${MATCHES}`,
    params(filter),
  );
  return result.rows[0].answer_kg as string;
}

// ---------------------------------------------------------------------------
// 1b. Which block is highest
// ---------------------------------------------------------------------------

/**
 * The blocks at one end of the comparison. Usually one.
 *
 * Postgres picks the extreme, not TypeScript. The per-block figures cross as
 * strings, for the reason at the top of this file, and the largest of
 * "4445.000", "1002.439", "3170.000" and "0.000" is only correct by string
 * order because every value happens to have four digits before the point. A
 * block at "999.000" would sort above "1002.439" and win a comparison it lost.
 *
 * `unnest($5)` drives the query from the block list rather than from the rows,
 * so a block with nothing in it still ranks, at zero. Every filter predicate
 * sits in the ON clause: moved to WHERE they would turn the LEFT JOIN into an
 * inner one and the empty block would vanish, which is the whole thing this
 * exists to avoid.
 *
 * That matters most in the other direction. Asked which block picked the
 * least, a block with no rows at all is the honest answer at 0.000, and it is
 * only in the running because the join keeps it. The caller says plainly that
 * it recorded nothing, rather than letting 0.000 read as a small harvest.
 *
 * Every block ties when nothing matches at all. Four blocks at zero is the
 * honest answer either way, and the caller says so rather than naming one.
 */
export async function selectExtremeBlocks(
  pool: Pool,
  filter: Filter,
  highest: boolean,
): Promise<Block[]> {
  // A lookup on a boolean, never a string built from the request. The only two
  // values that can ever reach the SQL text are written on this line.
  const extreme = highest ? 'MAX' : 'MIN';

  const result = await pool.query(
    `WITH per_block AS (
       SELECT b.block,
              COALESCE(SUM(r.quantity_kg), 0)::numeric(12,3) AS kg
         FROM unnest($5::text[]) AS b(block)
         LEFT JOIN harvest_record r
                ON r.block = b.block
               AND r.status = 'counted'
               AND ${matches('r.')}
        GROUP BY b.block
     )
     SELECT block
       FROM per_block
      WHERE kg = (SELECT ${extreme}(kg) FROM per_block)
      ORDER BY block`,
    [...params(filter), BLOCKS],
  );

  const top: Block[] = [];
  for (const row of result.rows) {
    const block = BLOCKS.find((known) => known === row.block);
    // Unreachable while $5 is BLOCKS. It is here so that stops being an
    // assumption the day the list comes from somewhere else.
    if (!block) throw new Error(`selectExtremeBlocks returned an unknown block: ${row.block}`);
    top.push(block);
  }
  return top;
}

// ---------------------------------------------------------------------------
// 2. The rows that were counted
// ---------------------------------------------------------------------------

/**
 * `read_as` names the one place the code decided something rather than took
 * the value as written. On this file that is line 7 and nothing else.
 */
export async function selectCountedRows(pool: Pool, filter: Filter): Promise<CountedRow[]> {
  const result = await pool.query(
    `SELECT source_line AS line,
            harvest_date::text AS date,
            quantity_raw, unit_raw,
            quantity_kg::text AS quantity_kg,
            NULLIF(
              CONCAT_WS('; ',
                CASE WHEN variety_raw IS DISTINCT FROM variety
                     THEN 'variety written ' || quote_literal(variety_raw) || ', read as ' || variety END,
                CASE WHEN block_raw IS DISTINCT FROM block
                     THEN 'block written ' || quote_literal(block_raw) || ', read as ' || block END,
                CASE WHEN harvest_date_raw IS DISTINCT FROM harvest_date::text
                     THEN 'date written ' || quote_literal(harvest_date_raw) || ', read as ' || harvest_date::text END,
                CASE WHEN quantity_raw LIKE '%,%'
                     THEN 'quantity written ' || quote_literal(quantity_raw) || ', thousands comma removed' END,
                CASE WHEN lower(unit_raw) <> 'kg'
                     THEN 'unit written ' || quote_literal(unit_raw) || ', converted to kilograms'
                     WHEN unit_raw <> 'kg'
                     THEN 'unit written ' || quote_literal(unit_raw) || ', read as kg' END
              ), ''
            ) AS read_as
       FROM harvest_record
      WHERE status = 'counted' AND ${MATCHES}
      ORDER BY source_line`,
    params(filter),
  );
  return result.rows as CountedRow[];
}

// ---------------------------------------------------------------------------
// 3. The rows that exist and were left out
// ---------------------------------------------------------------------------

/**
 * A row is in scope if nothing settled about it rules it out. An unsettled
 * field is treated as "might match", never as "does not match", so a row is
 * never dropped from the customer's view by a value the file failed to give.
 *
 * `not_a_record` rows are excluded here: line 13 and line 27 are kept in the
 * table so the file can be reconciled line by line, but they are not
 * something that was left out of an answer (A4).
 */
const IN_SCOPE = `
      ($1::text IS NULL OR r.block   = $1 OR r.block   IS NULL)
  AND ($2::text IS NULL OR r.variety = $2 OR r.variety IS NULL)
  AND ($3::date IS NULL OR r.harvest_date >= $3 OR r.harvest_date IS NULL)
  AND ($4::date IS NULL OR r.harvest_date <  $4 OR r.harvest_date IS NULL)
  AND r.status <> 'not_a_record'
`;

export async function selectNotCountedRows(pool: Pool, filter: Filter): Promise<NotCountedRow[]> {
  const result = await pool.query(
    `SELECT r.source_line AS line,
            r.status::text AS status,
            r.harvest_date::text AS date,
            r.quantity_raw, r.unit_raw,
            CASE
              WHEN r.status = 'superseded'
                THEN COALESCE(later.notes, 'replaced by a later row')
                     || ', replaced by line ' || later.source_line
              ELSE COALESCE(
                     (SELECT string_agg(q.question, ' ' ORDER BY q.field)
                        FROM parked_question q WHERE q.record_id = r.id),
                     'not counted')
            END AS reason,
            later.source_line AS superseded_by_line
       FROM harvest_record r
       LEFT JOIN harvest_record later ON later.id = r.superseded_by
      WHERE r.status <> 'counted' AND ${IN_SCOPE}
      ORDER BY r.source_line`,
    params(filter),
  );
  return result.rows as NotCountedRow[];
}

// ---------------------------------------------------------------------------
// 4. The parked rows, with what each option does to the answer
// ---------------------------------------------------------------------------

/**
 * One rule covers both kinds of park.
 *
 * Apply the option to the row. Re-run the filter. If the row now passes, the
 * delta is its kilograms. If it does not, the delta is zero. If the row still
 * has no weight after the option is applied, the delta is unknown, and
 * unknown is returned as null rather than as zero.
 *
 * Line 11 has a settled date and no weight, so the option supplies the weight.
 * Line 5 has a settled weight and no date, so the option supplies the date.
 * Neither case is written into this query by hand.
 *
 * A park is only returned when answering it could change this answer. Ask about
 * 4 March and line 11 drops out: its date is settled at 9 March, no option
 * changes a date, so no reading of its unit brings it into range. Line 5 stays,
 * because its date is the thing in question and one reading is 4 March.
 *
 * The test is `bool_or(in_range)` across the park's own options, which is the
 * same "nothing settled about it rules it out" rule the not-counted query uses.
 * Without it the two disagreed on screen: line 11 was absent from the rows left
 * out and present under waiting on an answer, in the same response.
 *
 * A park with every option out of range drops too. Ask about June and line 5
 * goes, because 4 March and 3 April are both outside it. Asking a customer a
 * question whose every answer changes nothing is noise.
 */
export async function selectParkedRows(pool: Pool, filter: Filter): Promise<ParkedRow[]> {
  const result = await pool.query(
    `WITH answer AS (
       -- Same cast, same reason. Without it a parked option on a
       -- zero-row question prices as "0" while its neighbours price
       -- as "1210.000".
       SELECT COALESCE(SUM(quantity_kg), 0)::numeric(12,3) AS total
         FROM harvest_record
        WHERE status = 'counted'
          AND ($1::text IS NULL OR block   = $1)
          AND ($2::text IS NULL OR variety = $2)
          AND ($3::date IS NULL OR harvest_date >= $3)
          AND ($4::date IS NULL OR harvest_date <  $4)
     ),
     applied AS (
       SELECT r.source_line, r.id AS record_id,
              q.id AS question_id, q.field, q.question, q.evidence, q.free_text,
              o.id AS option_id, o.label, o.sort_order,
              COALESCE(o.quantity_kg,  r.quantity_kg)  AS row_kg,
              COALESCE(o.harvest_date, r.harvest_date) AS row_date,
              COALESCE(o.quantity_kg,  r.quantity_kg) IS NOT NULL AS has_weight,
              (COALESCE(o.harvest_date, r.harvest_date) IS NOT NULL
                AND ($3::date IS NULL OR COALESCE(o.harvest_date, r.harvest_date) >= $3)
                AND ($4::date IS NULL OR COALESCE(o.harvest_date, r.harvest_date) <  $4)) AS in_range
         FROM harvest_record r
         JOIN parked_question q ON q.record_id = r.id
         LEFT JOIN parked_option o ON o.question_id = q.id
        WHERE r.status = 'parked'
          AND ($1::text IS NULL OR r.block   = $1 OR r.block   IS NULL)
          AND ($2::text IS NULL OR r.variety = $2 OR r.variety IS NULL)
     ),
     worth_asking AS (
       -- Keep the park only if at least one reading of it lands in range.
       -- Partitioned by question, so an option that changes nothing still
       -- shows, as long as a sibling option changes something.
       SELECT a.*, bool_or(a.in_range) OVER (PARTITION BY a.question_id) AS can_matter
         FROM applied a
     )
     SELECT a.source_line AS line, a.field, a.question, a.evidence, a.free_text,
            a.option_id, a.label, a.sort_order, a.in_range,
            a.row_kg::text AS row_becomes_kg,
            CASE
              WHEN NOT a.has_weight THEN NULL
              WHEN a.row_date IS NULL THEN NULL
              WHEN ($3::date IS NOT NULL AND a.row_date <  $3) THEN answer.total
              WHEN ($4::date IS NOT NULL AND a.row_date >= $4) THEN answer.total
              ELSE answer.total + a.row_kg
            END::text AS answer_becomes_kg
       FROM worth_asking a
       CROSS JOIN answer
      WHERE a.can_matter
      ORDER BY a.source_line, a.sort_order NULLS FIRST`,
    params(filter),
  );

  const byLine = new Map<string, ParkedRow>();
  for (const row of result.rows) {
    const key = `${row.line}:${row.field}`;
    let parked = byLine.get(key);
    if (!parked) {
      parked = {
        line: row.line,
        field: row.field,
        question: row.question,
        evidence: row.evidence,
        free_text: row.free_text,
        options: [],
      };
      byLine.set(key, parked);
    }
    if (row.option_id !== null) {
      parked.options.push({
        label: row.label,
        row_becomes_kg: row.row_becomes_kg,
        in_range: row.in_range,
        answer_becomes_kg: row.answer_becomes_kg,
      });
    }
  }
  return [...byLine.values()];
}

// ---------------------------------------------------------------------------
// 5. Where the answer came from
// ---------------------------------------------------------------------------

export async function selectSourceSummary(
  pool: Pool,
  filter: Filter,
): Promise<{ file: string; rows_read: number; rows_in_scope: number }> {
  const result = await pool.query(
    `SELECT (SELECT source_file FROM harvest_record LIMIT 1) AS file,
            (SELECT COUNT(*)::int FROM harvest_record) AS rows_read,
            (SELECT COUNT(*)::int FROM harvest_record r WHERE ${IN_SCOPE}) AS rows_in_scope`,
    params(filter),
  );
  return result.rows[0];
}
