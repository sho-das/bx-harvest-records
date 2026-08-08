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

/** Shared WHERE for rows that definitely match. NULL in a filter means "all". */
const MATCHES = `
      ($1::text IS NULL OR block   = $1)
  AND ($2::text IS NULL OR variety = $2)
  AND ($3::date IS NULL OR harvest_date >= $3)
  AND ($4::date IS NULL OR harvest_date <  $4)
`;

function params(filter: Filter) {
  return [filter.block, filter.variety, filter.dateFrom, filter.dateToExclusive];
}

// ---------------------------------------------------------------------------
// 1. The number
// ---------------------------------------------------------------------------

export async function selectAnswerKg(pool: Pool, filter: Filter): Promise<string> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(quantity_kg), 0)::text AS answer_kg
       FROM harvest_record
      WHERE status = 'counted' AND ${MATCHES}`,
    params(filter),
  );
  return result.rows[0].answer_kg as string;
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
 */
export async function selectParkedRows(pool: Pool, filter: Filter): Promise<ParkedRow[]> {
  const result = await pool.query(
    `WITH answer AS (
       SELECT COALESCE(SUM(quantity_kg), 0) AS total
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
              COALESCE(o.quantity_kg,  r.quantity_kg) IS NOT NULL AS has_weight
         FROM harvest_record r
         JOIN parked_question q ON q.record_id = r.id
         LEFT JOIN parked_option o ON o.question_id = q.id
        WHERE r.status = 'parked'
          AND ($1::text IS NULL OR r.block   = $1 OR r.block   IS NULL)
          AND ($2::text IS NULL OR r.variety = $2 OR r.variety IS NULL)
     )
     SELECT a.source_line AS line, a.field, a.question, a.evidence, a.free_text,
            a.option_id, a.label, a.sort_order,
            a.row_kg::text AS row_becomes_kg,
            (a.row_date IS NOT NULL
              AND ($3::date IS NULL OR a.row_date >= $3)
              AND ($4::date IS NULL OR a.row_date <  $4)) AS in_range,
            CASE
              WHEN NOT a.has_weight THEN NULL
              WHEN a.row_date IS NULL THEN NULL
              WHEN ($3::date IS NOT NULL AND a.row_date <  $3) THEN answer.total
              WHEN ($4::date IS NOT NULL AND a.row_date >= $4) THEN answer.total
              ELSE answer.total + a.row_kg
            END::text AS answer_becomes_kg
       FROM applied a
       CROSS JOIN answer
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
