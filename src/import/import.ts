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
  resolveFromPeers,
  BLOCK_SPELLINGS,
  VARIETY_SPELLINGS,
  UNIT_FACTOR_KG,
  BLOCK_UNIT_HABIT,
  SOURCE_FILE,
  VARIETIES,
  squashed,
  type Block,
  type Unit,
  type Variety,
} from './rules';

type PendingQuestion = {
  field: 'unit' | 'harvest_date' | 'quantity' | 'duplicate' | 'variety';
  question: string;
  evidence: string | null;
  freeText: boolean;
  options: {
    label: string;
    quantityKg: string | null;
    harvestDate: string | null;
    variety?: string | null;
    keepsRowOut?: boolean;
  }[];
};

export type PendingRow = {
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
  /** Why a value the tables did not know was read the way it was. */
  resolvedNote: string | null;
  questions: PendingQuestion[];
};

/**
 * What a person already decided, so nobody is asked the same question twice.
 *
 * Applied on import: the row counts with the decided value, and the question
 * still comes back with that option marked so it can be changed.
 */
export type Decision = {
  scope: 'spelling' | 'row';
  field: string;
  subject: string;
  chosenLabel: string;
  quantityKg: string | null;
  harvestDate: string | null;
  variety: string | null;
};

export type Decisions = Map<string, Decision>;

export const decisionKey = (scope: string, field: string, subject: string): string =>
  `${scope}|${field}|${subject}`;

/**
 * A row as its writer spelled it: block, variety, date and quantity.
 *
 * Not the line number. A grower who re-exports with one row inserted moves
 * every line below it, and every decision keyed on a line would land on the
 * wrong row. What the row says does not move.
 *
 * Two rows identical in all four fields share a subject, which is right: the
 * same question about the same pair has the same answer, and that pair is
 * exactly the duplicate case.
 */
export function rowSubject(raw: PendingRow['raw']): string {
  return [raw.block, raw.variety, raw.harvestDate, raw.quantity]
    .map((value) => (value ?? '').trim().toLowerCase())
    .join('|');
}

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

/**
 * Values the lookup tables do not know, read from the rest of the file.
 *
 * Line 7 says `sweethart`. That was a hand-written entry in `VARIETY_SPELLINGS`
 * and it is not any more, because one entry per typo does not survive the
 * second file. The reason it was ever safe to accept is the reason it is
 * accepted now: R Craig, who wrote it, writes `Sweetheart` on his six other
 * rows and no other variety at all.
 *
 * The peer group is the grader. A person's own spelling on their own rows is
 * the strongest thing this file has, and it is the one `02-decisions.md` gave
 * for line 7 in the first place. Blocks are tried first, because a variety can
 * fall back to what the rest of that block grows and a block cannot fall back
 * to anything.
 *
 * When the file cannot settle it - no peers, a tie, or the token is too far
 * from anything - the value is left unread, and the row parks exactly as it
 * would have before. Nothing here invents a reading, and every reading it does
 * make is written into `resolved_note` so the customer can see the reason.
 */
function resolveFromTheRestOfTheFile(rows: PendingRow[]): void {
  const records = rows.filter((row) => row.status !== 'not_a_record');
  const notes = new Map<number, string[]>();

  const noteFor = (row: PendingRow, text: string) => {
    const existing = notes.get(row.sourceLine) ?? [];
    existing.push(text);
    notes.set(row.sourceLine, existing);
  };

  /** Rows by the same grader, excluding this one. */
  const bySameGrader = (row: PendingRow) =>
    records.filter((peer) => peer !== row && peer.raw.grader && peer.raw.grader === row.raw.grader);

  for (const row of records) {
    if (row.block === null && row.raw.block) {
      const peers = bySameGrader(row);
      const known = peers.map((peer) => peer.block).filter((b): b is Block => b !== null);
      const resolved = resolveFromPeers(row.raw.block, BLOCK_SPELLINGS, known);
      if (resolved) {
        row.block = resolved;
        noteFor(
          row,
          `block written ${JSON.stringify(row.raw.block)}, read as ${resolved}: ` +
            `${row.raw.grader} works ${resolved} on ${known.filter((b) => b === resolved).length} other rows and no other block`,
        );
      }
    }
  }

  for (const row of records) {
    if (row.variety !== null || !row.raw.variety) continue;

    // The grader first. Their own rows are the evidence 02-decisions.md gave
    // for line 7, and a person is a narrower group than a block.
    let peers = bySameGrader(row);
    let group = row.raw.grader ?? 'the same grader';

    if (!peers.some((peer) => peer.variety !== null) && row.block !== null) {
      peers = records.filter((peer) => peer !== row && peer.block === row.block);
      group = `Block ${row.block}`;
    }

    const known = peers.map((peer) => peer.variety).filter((v): v is Variety => v !== null);
    const resolved = resolveFromPeers(row.raw.variety, VARIETY_SPELLINGS, known);
    if (!resolved) continue;

    const matching = known.filter((variety) => variety === resolved).length;
    const others = new Set(known.filter((variety) => variety !== resolved)).size;

    row.variety = resolved;
    noteFor(
      row,
      `variety written ${JSON.stringify(row.raw.variety)}, read as ${resolved}: ` +
        `${group} writes ${resolved} on ${matching} other rows` +
        (others === 0 ? ' and no other variety' : ''),
    );
  }

  for (const row of records) {
    const written = notes.get(row.sourceLine);
    if (written) row.resolvedNote = written.join('; ');
  }
}

export function buildRows(csv: string, decisions: Decisions = new Map()): PendingRow[] {
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
        resolvedNote: null,
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
      resolvedNote: null,
      questions: [],
    });
  }

  resolveFromTheRestOfTheFile(rows);

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

  parkUnevidencedDuplicates(rows);
  parkUnresolvedVarieties(rows);
  applyDecisions(rows, decisions);

  return rows;
}

/**
 * A variety the tables do not know and the file cannot settle.
 *
 * Nothing in the shipped file reaches here: `sweethart` is resolved from
 * R Craig's own rows. `Swithart` would, at three edits, and so would any real
 * cultivar nobody has loaded.
 *
 * Every variety is offered, not just the nearest. Showing one candidate hides
 * that the other two were considered and rejected, and the customer cannot
 * check a shortlist they cannot see. The last option is the one that makes the
 * list honest: a token that is not a typo at all has no right answer on this
 * list, and offering only real varieties would offer only wrong answers.
 */
function parkUnresolvedVarieties(rows: PendingRow[]): void {
  for (const row of rows) {
    if (row.status === 'not_a_record') continue;
    if (row.variety !== null || !row.raw.variety) continue;
    if (row.questions.some((question) => question.field === 'variety')) continue;

    // What the rest of this block grows. `resolveFromTheRestOfTheFile` reaches
    // for the block only when the grader's own rows carry no variety at all,
    // so this group is one it may never have tried. It supplies the evidence
    // sentence and never the value: a name that reaches here has already been
    // declined once, and the customer is the one who decides.
    const grader = row.raw.grader ?? 'The grader';
    const block = row.block;
    const nearest = block
      ? resolveFromPeers(
          row.raw.variety,
          VARIETY_SPELLINGS,
          rows
            .filter((peer) => peer !== row && peer.block === block)
            .map((peer) => peer.variety)
            .filter((v): v is Variety => v !== null),
        )
      : null;

    row.status = 'parked';
    row.questions.push({
      field: 'variety',
      question:
        `Line ${row.sourceLine} says ${JSON.stringify(row.raw.variety)}, which is not a variety ` +
        `in this data. Which variety was it?`,
      // "close, but not close enough" was wrong here and said so out loud. A
      // name only reaches this branch when the block's other rows do put it
      // within reach, and the reading was declined because the grader's own
      // rows are the narrower evidence and they point elsewhere. Saying the
      // name is too far would tell the customer something untrue about their
      // own file.
      evidence: nearest
        ? `The closest name on the other rows in Block ${block?.slice(1)} is ${nearest}. ` +
          `${grader} wrote this row, and their own rows do not settle it, so nothing read it ` +
          `for you.`
        : `No variety in this data is close to it. ${grader} wrote it, ` +
          `and it may be a variety this file has never carried.`,
      freeText: false,
      options: [
        ...VARIETIES.map((variety) => ({
          label: variety,
          quantityKg: null,
          harvestDate: null,
          variety,
        })),
        {
          label: 'Not a variety in this data, do not count it',
          quantityKg: null,
          harvestDate: null,
          variety: null,
          keepsRowOut: true,
        },
      ],
    });
  }
}

/**
 * Apply what a person already said, so the question is asked once and not
 * every time the file is imported.
 *
 * Spelling decisions are looked up by the token, so `sweethart means
 * Sweetheart` improves every future import. Row decisions are looked up by
 * what the row says, so they follow the row rather than its line number.
 *
 * The question stays attached after the decision is applied. The row counts,
 * and the response shows the chosen option next to the others, because a
 * decision a person cannot see is a decision they cannot correct.
 */
function applyDecisions(rows: PendingRow[], decisions: Decisions): void {
  if (decisions.size === 0) return;

  for (const row of rows) {
    if (row.status === 'not_a_record') continue;

    // Spelling first: resolving the variety can remove the need for the park
    // that would otherwise ask about it.
    if (row.variety === null && row.raw.variety) {
      const spelling = decisions.get(
        decisionKey('spelling', 'variety', squashed(row.raw.variety)),
      );
      if (spelling?.variety) {
        row.variety = spelling.variety;
        row.resolvedNote =
          `variety written ${JSON.stringify(row.raw.variety)}, read as ${spelling.variety}: ` +
          `confirmed by a person`;
        // The question is not removed. Dropping it counted the row and left
        // nothing on screen saying a person had decided anything, so the only
        // way to change the answer was to write to the database by hand. The
        // check below turns the row to counted; the question comes back under
        // "answered by a person" with this option marked.
      }
    }

    for (const question of row.questions) {
      const decision = decisions.get(decisionKey('row', question.field, rowSubject(row.raw)));
      if (!decision) continue;

      if (decision.quantityKg !== null) {
        // Already kilograms, so the factor is 1. The row's own unit is not
        // reapplied to a figure a person gave in kilograms.
        row.quantityValue = decision.quantityKg;
        row.unitFactor = '1';
      }
      if (decision.harvestDate !== null) row.harvestDate = decision.harvestDate;
      if (decision.variety !== null) row.variety = decision.variety;
    }

    const settled =
      row.block !== null &&
      row.variety !== null &&
      row.harvestDate !== null &&
      row.quantityValue !== null &&
      row.unitFactor !== null;

    if (settled && row.questions.length > 0) row.status = 'counted';
  }
}

/**
 * Two rows that could be one row, where nothing in the file says which.
 *
 * Lines 16 and 17 are the same block, the same variety, the same date and the
 * same grader, for 1150 kg and 1105 kg. Line 17 says "re-weighed after
 * grading", and that note is the only reason this system knows the second row
 * replaces the first rather than joining it.
 *
 * Take the note away and there are three readings, all ordinary:
 *
 *   - two pickings from one block in one day, which is 4,320.000
 *   - line 17 is a re-weigh of line 16, which is 3,170.000
 *   - line 16 is the good weight and line 17 is the duplicate, 3,215.000
 *
 * Nothing settles it. Adjacent line numbers fit a correction typed straight
 * afterwards and fit two loads recorded in order. Line 17 being 45 kg lighter
 * fits grading losses and fits a smaller second picking.
 *
 * What this stops is the silent version. Without the note the old code counted
 * both rows and returned 4,320.000 with no question attached, because nothing
 * had linked them. Counting both is a decision, not a neutral outcome, and it
 * is the one the code was making whenever the evidence was missing.
 *
 * The earlier row parks, so the base answer holds at 3,170.000 either way and
 * the note now changes what the customer is told rather than what they are
 * charged. Two options, not three: if either row is a correction it is the
 * later one, because this file appends and never rewrites, and that is
 * evidence rather than certainty, so the customer still decides whether it is
 * a correction at all.
 */
function parkUnevidencedDuplicates(rows: PendingRow[]): void {
  const groups = new Map<string, PendingRow[]>();

  for (const row of rows) {
    if (row.status !== 'counted') continue;
    if (!row.block || !row.variety || !row.harvestDate) continue;
    if (row.quantityValue === null || row.unitFactor === null) continue;

    const key = `${row.block}|${row.variety}|${row.harvestDate}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // The note settles it, so linkSupersedes does the work in SQL and this
    // rule stays out of the way. Only an unevidenced group reaches a customer.
    if (group.some((row) => /re-weigh/i.test(row.raw.notes ?? ''))) continue;

    const ordered = [...group].sort((a, b) => a.sourceLine - b.sourceLine);
    const latest = ordered[ordered.length - 1];

    for (const row of ordered.slice(0, -1)) {
      const kg = multiplyExact(row.quantityValue as string, row.unitFactor as string);

      row.status = 'parked';
      row.questions.push({
        field: 'duplicate',
        question:
          `Lines ${row.sourceLine} and ${latest.sourceLine} are the same block, variety and date, ` +
          `for ${row.raw.quantity} and ${latest.raw.quantity}. Were these two pickings, or was ` +
          `line ${row.sourceLine} replaced by line ${latest.sourceLine}?`,
        evidence:
          `Both rows were written by ${row.raw.grader ?? 'the same grader'} and no note says either ` +
          `is a correction. Two pickings from one block in one day is ordinary, and so is a ` +
          `re-weigh entered on the next line. Line ${latest.sourceLine} is the later of the two, ` +
          `and this file appends rather than rewrites, so if either is a correction it is that one.`,
        freeText: false,
        options: [
          {
            label: `Two pickings, count line ${row.sourceLine} as well`,
            quantityKg: kg,
            harvestDate: null,
          },
          {
            label: `Replaced by line ${latest.sourceLine}, do not count it`,
            quantityKg: '0',
            harvestDate: null,
          },
        ],
      });
    }
  }
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
    status, resolved_note, row_subject, variety_subject
  ) VALUES (
    $1, $2,
    $3, $4, $5, $6, $7, $8, $9,
    $10, $11, $12::date, ($13::numeric * $14::numeric),
    $15::record_status, $16, $17, $18
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
    row.resolvedNote,
    rowSubject(row.raw),
    row.raw.variety ? squashed(row.raw.variety) : null,
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
        `INSERT INTO parked_option
           (question_id, label, sort_order, quantity_kg, harvest_date, variety, keeps_row_out)
         VALUES ($1, $2, $3, $4::numeric, $5::date, $6, $7)`,
        [
          questionId, option.label, index,
          option.quantityKg, option.harvestDate,
          option.variety ?? null, option.keepsRowOut === true,
        ],
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

/** Every decision a person has recorded, keyed for lookup during the build. */
export async function loadDecisions(client: PoolClient): Promise<Decisions> {
  const result = await client.query(
    `SELECT scope, field, subject, chosen_label,
            quantity_kg::text AS quantity_kg,
            harvest_date::text AS harvest_date,
            variety
       FROM decision`,
  );

  const decisions: Decisions = new Map();
  for (const row of result.rows) {
    decisions.set(decisionKey(row.scope, row.field, row.subject), {
      scope: row.scope,
      field: row.field,
      subject: row.subject,
      chosenLabel: row.chosen_label,
      quantityKg: row.quantity_kg,
      harvestDate: row.harvest_date,
      variety: row.variety,
    });
  }
  return decisions;
}

export async function importCsv(path: string): Promise<ImportReport> {
  const csv = readFileSync(path, 'utf8');

  const client = await getPool().connect();
  try {
    // Loaded before the rows are built, because a decision can settle a value
    // and remove the question that would otherwise have been asked about it.
    const decisions = await loadDecisions(client);
    const rows = buildRows(csv, decisions);

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
