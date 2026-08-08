/**
 * Reads harvest-records-2026.csv and writes every line to the table.
 *
 * A1: nothing is thrown out. The file is 28 lines: a header, 26 data lines and
 * a trailing newline. All 26 data lines become rows, including the empty
 * line 13 and the TOTAL line 27.
 *
 * The importer never decides what a value means. `parse.ts` decides, and it
 * only ever reports what the file settles. Anything it does not settle is
 * written as a parked question with its options.
 */

import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool';
import {
  splitCsvLine,
  parseQuantity,
  parseUnit,
  parseDate,
  classifyLine,
} from './parse';
import {
  readBlock,
  readVariety,
  UNIT_FACTOR_KG,
  BLOCK_UNIT_HABIT,
  SOURCE_FILE,
  type Block,
  type Unit,
} from './rules';

type PendingQuestion = {
  field: 'unit' | 'harvest_date' | 'quantity';
  question: string;
  evidence: string | null;
  freeText: boolean;
  options: { label: string; quantityKg: string | null; harvestDate: string | null }[];
};

type PendingRow = {
  sourceLine: number;
  raw: {
    block: string | null;
    variety: string | null;
    harvestDate: string | null;
    quantity: string | null;
    unit: string | null;
    grader: string | null;
    notes: string | null;
  };
  block: Block | null;
  variety: string | null;
  harvestDate: string | null;
  quantityValue: string | null;
  unitFactor: string | null;
  status: 'counted' | 'parked' | 'not_a_record';
  questions: PendingQuestion[];
};

export type ImportReport = {
  linesRead: number;
  counted: number;
  parked: number;
  superseded: number;
  notARecord: number;
  correctionsLinked: number;
  correctionsUnmatched: number;
};

// ---------------------------------------------------------------------------
// Reading the file into pending rows
// ---------------------------------------------------------------------------

function field(fields: string[], index: number): string | null {
  const value = (fields[index] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * The evidence sentence that travels with a missing-unit park.
 *
 * Counted from the file, not hard-coded, so it cannot drift into a claim the
 * data no longer supports. It says what the other rows in this block do. It
 * never says what this row was (B2).
 */
function unitEvidence(rows: PendingRow[], block: Block, sourceLine: number): string {
  const tally = new Map<string, number>();
  for (const row of rows) {
    if (row.block !== block || row.sourceLine === sourceLine) continue;
    const unit = parseUnit(row.raw.unit);
    if (unit.kind !== 'settled') continue;
    tally.set(unit.unit, (tally.get(unit.unit) ?? 0) + 1);
  }

  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([unit, count]) => `${count} say ${unit}`);

  if (parts.length === 0) {
    return `No other row in Block ${block.slice(1)} carries a unit either.`;
  }
  if (parts.length === 1) {
    const [unit, count] = [...tally.entries()][0];
    return `Every other row in Block ${block.slice(1)} that carries a unit says ${unit} (${count} rows). That is what the block usually does. It is not what this row said.`;
  }
  return `Other rows in Block ${block.slice(1)}: ${parts.join(', ')}. The block is not consistent, so this row cannot be read from it.`;
}

/**
 * The evidence sentence for an ambiguous date.
 *
 * Row position was tested as evidence and rejected. Line 18 is `4 Mar 26` and
 * it sits between 12 March and 13 March, so this file demonstrably misplaces
 * rows. That finding is stated, not recomputed, because it is a judgement.
 */
function dateEvidence(rows: PendingRow[]): string {
  let isoCount = 0;
  let dateCount = 0;
  for (const row of rows) {
    if (row.status === 'not_a_record' || !row.raw.harvestDate) continue;
    dateCount++;
    if (/^\d{4}-\d{2}-\d{2}$/.test(row.raw.harvestDate)) isoCount++;
  }
  return (
    `${isoCount} of the ${dateCount} dates in this file are written year-month-day. This one is not. ` +
    `Row order does not settle it either: line 18 (4 Mar 26) sits between 12 March and 13 March, ` +
    `so this file does put rows in the wrong place.`
  );
}

function buildRows(csv: string): PendingRow[] {
  const lines = csv.split(/\r?\n/);
  const rows: PendingRow[] = [];

  // Line 1 is the header. Line numbers below match the file exactly, so a
  // number in the response can be opened in a text editor and looked at.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) continue; // trailing newline
    const sourceLine = i + 1;
    const fields = splitCsvLine(line);
    const kind = classifyLine(fields);

    const raw = {
      block: field(fields, 0),
      variety: field(fields, 1),
      harvestDate: field(fields, 2),
      quantity: field(fields, 3),
      unit: field(fields, 4),
      grader: field(fields, 5),
      notes: field(fields, 6),
    };

    // A4. The TOTAL row and the empty row are stored, never countable.
    if (kind !== 'record') {
      rows.push({
        sourceLine,
        raw,
        block: null,
        variety: null,
        harvestDate: null,
        quantityValue: null,
        unitFactor: null,
        status: 'not_a_record',
        questions: [],
      });
      continue;
    }

    rows.push({
      sourceLine,
      raw,
      block: readBlock(raw.block),
      variety: readVariety(raw.variety),
      harvestDate: null,
      quantityValue: null,
      unitFactor: null,
      status: 'counted',
      questions: [],
    });
  }

  // Second pass: resolve the values, now that the whole file is available to
  // build evidence sentences from.
  for (const row of rows) {
    if (row.status === 'not_a_record') continue;

    const quantity = parseQuantity(row.raw.quantity);
    const unit = parseUnit(row.raw.unit);
    const date = parseDate(row.raw.harvestDate);

    if (date.kind === 'settled') {
      row.harvestDate = date.date;
    } else if (date.kind === 'ambiguous') {
      row.status = 'parked';
      row.questions.push({
        field: 'harvest_date',
        question: `Line ${row.sourceLine} has the date "${row.raw.harvestDate}". Which date was it?`,
        evidence: dateEvidence(rows),
        freeText: false,
        options: date.readings.map((reading) => ({
          label: reading.label,
          quantityKg: null,
          harvestDate: reading.date,
        })),
      });
    } else {
      row.status = 'parked';
      row.questions.push({
        field: 'harvest_date',
        question: `Line ${row.sourceLine} has no date that can be read. What date was this harvested?`,
        evidence: null,
        freeText: true,
        options: [],
      });
    }

    if (quantity.kind === 'unreadable') {
      // No number at all. Do not also ask about the unit: a unit question on
      // a row with no weight is noise. Nobody can pick a weight from a list,
      // so this one is free text.
      row.status = 'parked';
      const note = row.raw.notes ? ` The note says "${row.raw.notes}".` : '';
      const wrote = row.raw.quantity ? `says "${row.raw.quantity}"` : 'is blank';
      row.questions.push({
        field: 'quantity',
        question: `Line ${row.sourceLine} ${wrote} where the quantity should be.${note} What was harvested?`,
        evidence: null,
        freeText: true,
        options: [],
      });
      continue;
    }

    row.quantityValue = quantity.value;

    if (unit.kind === 'settled') {
      row.unitFactor = UNIT_FACTOR_KG[unit.unit];
      continue;
    }

    // B2. A row with no unit is parked, not filled. The block-to-unit rule is
    // strong evidence, and strong evidence is not the value the row carried.
    row.status = 'parked';
    const habit: Unit | null = row.block ? BLOCK_UNIT_HABIT[row.block] : null;
    const order: Unit[] = habit
      ? [habit, ...(['kg', 'lb', 'g'] as Unit[]).filter((u) => u !== habit)]
      : (['kg', 'lb', 'g'] as Unit[]);

    row.questions.push({
      field: 'unit',
      question: `Line ${row.sourceLine} has a quantity of ${quantity.value} but no unit. Which unit was it?`,
      evidence: row.block ? unitEvidence(rows, row.block, row.sourceLine) : null,
      freeText: false,
      options: order.map((candidate) => ({
        label: candidate,
        quantityKg: multiplyExact(quantity.value, UNIT_FACTOR_KG[candidate]),
        harvestDate: null,
      })),
    });
  }

  return rows;
}

/**
 * Multiplies two decimal strings exactly, by hand.
 *
 * Used only to cost a parked option before it reaches Postgres. Every total
 * the customer sees is summed by Postgres in NUMERIC. This exists so that
 * `1210 lb` costs 548.8467677 and not 548.8467676999999.
 */
export function multiplyExact(a: string, b: string): string {
  const scale = (s: string) => (s.split('.')[1] ?? '').length;
  const digits = (s: string) => BigInt(s.replace('.', ''));

  const product = digits(a) * digits(b);
  const decimals = scale(a) + scale(b);
  if (decimals === 0) return product.toString();

  const negative = product < 0n;
  const text = (negative ? -product : product).toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, '');

  const value = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${value}` : value;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const INSERT_ROW = `
  INSERT INTO harvest_record (
    source_file, source_line,
    block_raw, variety_raw, harvest_date_raw, quantity_raw, unit_raw, grader_raw, notes,
    block, variety, harvest_date, quantity_kg,
    status
  ) VALUES (
    $1, $2,
    $3, $4, $5, $6, $7, $8, $9,
    $10, $11, $12::date, ($13::numeric * $14::numeric),
    $15::record_status
  )
  RETURNING id
`;

async function writeRow(client: PoolClient, row: PendingRow): Promise<number> {
  const result = await client.query(INSERT_ROW, [
    SOURCE_FILE,
    row.sourceLine,
    row.raw.block,
    row.raw.variety,
    row.raw.harvestDate,
    row.raw.quantity,
    row.raw.unit,
    row.raw.grader,
    row.raw.notes,
    row.block,
    row.variety,
    row.harvestDate,
    row.quantityValue,
    row.unitFactor,
    row.status,
  ]);
  return result.rows[0].id as number;
}

async function writeQuestions(
  client: PoolClient,
  recordId: number,
  questions: PendingQuestion[],
): Promise<void> {
  for (const question of questions) {
    const inserted = await client.query(
      `INSERT INTO parked_question (record_id, field, question, evidence, free_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [recordId, question.field, question.question, question.evidence, question.freeText],
    );
    const questionId = inserted.rows[0].id as number;

    for (const [index, option] of question.options.entries()) {
      await client.query(
        `INSERT INTO parked_option (question_id, label, sort_order, quantity_kg, harvest_date)
         VALUES ($1, $2, $3, $4::numeric, $5::date)`,
        [questionId, option.label, index, option.quantityKg, option.harvestDate],
      );
    }
  }
}

/**
 * B5. The re-weigh supersedes.
 *
 * Line 17 says "re-weighed after grading" and matches line 16 on block,
 * variety and date. Both rows stay in the table. Only the later one counts.
 * Deleting the first row would lose the history.
 */
async function linkSupersedes(client: PoolClient): Promise<number> {
  const result = await client.query(`
    UPDATE harvest_record AS old
       SET status = 'superseded', superseded_by = fresh.id
      FROM harvest_record AS fresh
     WHERE fresh.source_file = old.source_file
       AND fresh.notes ILIKE '%re-weigh%'
       AND old.id <> fresh.id
       AND old.status = 'counted'
       AND old.block = fresh.block
       AND old.variety = fresh.variety
       AND old.harvest_date = fresh.harvest_date
       AND old.source_line < fresh.source_line
       AND (old.notes IS NULL OR old.notes NOT ILIKE '%re-weigh%')
    RETURNING old.id
  `);
  return result.rowCount ?? 0;
}

/**
 * B6. The negative row appends, it does not modify.
 *
 * The row it corrects is found from the note ("correction to 12/03") narrowed
 * by block and variety, never by date alone: three rows fall on 12 March and
 * only one is B4 Regina. Both readings of 12/03 are tried. If that does not
 * leave exactly one row, the correction is stored unlinked and flagged.
 */
async function linkCorrections(
  client: PoolClient,
): Promise<{ linked: number; unmatched: number }> {
  const corrections = await client.query(
    `SELECT id, block, variety, harvest_date, notes
       FROM harvest_record
      WHERE quantity_kg < 0 AND status = 'counted'`,
  );

  let linked = 0;
  let unmatched = 0;

  for (const correction of corrections.rows) {
    const note: string = correction.notes ?? '';
    const match = /(\d{1,2})\s*[\/-]\s*(\d{1,2})/.exec(note);
    const year = String(correction.harvest_date).slice(0, 4);

    const candidateDates: string[] = [];
    if (match) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      // Both readings. The unique-match rule below decides which survives.
      if (b >= 1 && b <= 12) candidateDates.push(`${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`);
      if (a >= 1 && a <= 12) candidateDates.push(`${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`);
    }

    const found = candidateDates.length
      ? await client.query(
          `SELECT id FROM harvest_record
            WHERE block = $1 AND variety = $2
              AND harvest_date = ANY($3::date[])
              AND quantity_kg > 0
              AND status IN ('counted', 'superseded')`,
          [correction.block, correction.variety, candidateDates],
        )
      : { rows: [] as { id: number }[] };

    if (found.rows.length === 1) {
      await client.query(`UPDATE harvest_record SET corrects = $1 WHERE id = $2`, [
        found.rows[0].id,
        correction.id,
      ]);
      linked++;
    } else {
      await client.query(
        `UPDATE harvest_record SET correction_unmatched = TRUE WHERE id = $1`,
        [correction.id],
      );
      unmatched++;
    }
  }

  return { linked, unmatched };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function importCsv(path: string): Promise<ImportReport> {
  const csv = readFileSync(path, 'utf8');
  const rows = buildRows(csv);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Re-running the import replaces this file's rows rather than doubling
    // them. What is NOT built is versioning a row that changed between two
    // imports: the old one is replaced, not kept. See DECISIONS.md.
    await client.query('DELETE FROM harvest_record WHERE source_file = $1', [SOURCE_FILE]);

    for (const row of rows) {
      const id = await writeRow(client, row);
      if (row.questions.length) await writeQuestions(client, id, row.questions);
    }

    const superseded = await linkSupersedes(client);
    const corrections = await linkCorrections(client);

    await client.query('COMMIT');

    const counted = await client.query(
      `SELECT status, COUNT(*)::int AS n FROM harvest_record
        WHERE source_file = $1 GROUP BY status`,
      [SOURCE_FILE],
    );
    const byStatus = new Map<string, number>(
      counted.rows.map((r: { status: string; n: number }) => [r.status, r.n]),
    );

    return {
      linesRead: rows.length,
      counted: byStatus.get('counted') ?? 0,
      parked: byStatus.get('parked') ?? 0,
      superseded: byStatus.get('superseded') ?? superseded,
      notARecord: byStatus.get('not_a_record') ?? 0,
      correctionsLinked: corrections.linked,
      correctionsUnmatched: corrections.unmatched,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
