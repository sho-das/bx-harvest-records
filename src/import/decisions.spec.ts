/**
 * What a person's answer does to a row, and what happens when nobody answers.
 *
 * These run on `buildRows`, which takes the file as text and the decisions as a
 * map and touches no database. That is the whole point of `POST /decision`
 * re-importing rather than updating the row it was told about: there is one
 * implementation of "what does this row mean", it is a pure function, and it
 * can be run on a five-line file in a test.
 *
 * Every CSV below is the real header with rows written to shape, not copied,
 * because the shipped file has no row that reaches these paths: `sweethart` is
 * settled from R Craig's own rows, and both duplicate pairs carry a note.
 */

import { describe, it, expect } from 'vitest';
import { buildRows, decisionKey, rowSubject, multiplyExact, type Decisions } from './import';

const HEADER = 'block,variety,harvest_date,quantity,unit,grader,notes';

/** The file as a string, with line 2 onwards supplied by the test. */
const file = (...rows: string[]) => [HEADER, ...rows].join('\n');

const at = (csv: string, line: number) => {
  const row = buildRows(csv).find((r) => r.sourceLine === line);
  if (!row) throw new Error(`no row on line ${line}`);
  return row;
};

/** One decision, in the shape `loadDecisions` produces from the table. */
function decide(
  scope: 'spelling' | 'row',
  field: string,
  subject: string,
  chosenLabel: string,
  changes: { quantityKg?: string; harvestDate?: string; variety?: string } = {},
): Decisions {
  return new Map([
    [
      decisionKey(scope, field, subject),
      {
        scope,
        field,
        subject,
        chosenLabel,
        quantityKg: changes.quantityKg ?? null,
        harvestDate: changes.harvestDate ?? null,
        variety: changes.variety ?? null,
      },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// A variety no table knows and no peer settles
// ---------------------------------------------------------------------------

describe('a variety the file cannot settle', () => {
  // Three edits from Sweetheart, which is past the quarter-of-the-word gate,
  // so the peer rule declines even though R Craig writes Sweetheart below it.
  const UNKNOWN = file(
    'B3,Swithart,2026-03-06,990,kg,R Craig,',
    'B3,Sweetheart,2026-03-07,800,kg,R Craig,',
  );

  it('parks rather than reads it', () => {
    const row = at(UNKNOWN, 2);
    expect(row.status).toBe('parked');
    expect(row.variety).toBeNull();
    expect(row.questions.map((q) => q.field)).toEqual(['variety']);
  });

  it('offers every variety, plus the answer that is not a variety', () => {
    // Showing only the nearest name hides that the other two were considered,
    // and a customer cannot check a shortlist they cannot see. The last option
    // is what makes the list honest: a token that is not a typo at all has no
    // right answer among real varieties.
    const question = at(UNKNOWN, 2).questions[0];
    expect(question.options.map((o) => o.label)).toEqual([
      'Sweetheart',
      'Lapins',
      'Regina',
      'Not a variety in this data, do not count it',
    ]);
    expect(question.options.map((o) => o.variety)).toEqual([
      'Sweetheart',
      'Lapins',
      'Regina',
      null,
    ]);
  });

  it('says plainly when nothing in the file is close', () => {
    // Three edits is past the gate against every name here, so there is no
    // near miss to report and the evidence does not invent one.
    expect(at(UNKNOWN, 2).questions[0].evidence).toBe(
      'No variety in this data is close to it. R Craig wrote it, and it may be a variety this ' +
        'file has never carried.',
    );
  });

  it('names the block’s own spelling when the grader’s rows point elsewhere', () => {
    // "Swetheart" is one edit from Sweetheart, so the block would settle it.
    // R Craig is asked first, because a person is narrower evidence than a
    // block, and every other row of his says Lapins. So it parks, and the
    // evidence says which name the block uses rather than claiming the name is
    // too far away.
    const conflict = file(
      'B3,Swetheart,2026-03-06,990,kg,R Craig,',
      'B4,Lapins,2026-03-07,800,kg,R Craig,',
      'B3,Sweetheart,2026-03-08,700,kg,J Silvestre,',
    );
    const row = at(conflict, 2);

    expect(row.status).toBe('parked');
    expect(row.variety).toBeNull();
    expect(row.questions[0].evidence).toBe(
      'The closest name on the other rows in Block 3 is Sweetheart. R Craig wrote this row, and ' +
        'their own rows do not settle it, so nothing read it for you.',
    );
  });
});

// ---------------------------------------------------------------------------
// Two rows that could be one row
// ---------------------------------------------------------------------------

describe('a duplicate with nothing in the file to settle it', () => {
  const SAME = file(
    'B3,Sweetheart,2026-03-12,1150,kg,R Craig,',
    'B3,Sweetheart,2026-03-12,1105,kg,R Craig,',
  );

  it('parks the earlier row and counts the later one', () => {
    // The file appends rather than rewrites, so if either is a correction it
    // is the later one. That is why the earlier row is the one held back: it
    // is the row whose meaning is in question.
    expect(at(SAME, 2).status).toBe('parked');
    expect(at(SAME, 3).status).toBe('counted');
    expect(at(SAME, 2).questions.map((q) => q.field)).toEqual(['duplicate']);
  });

  it('prices both readings, so neither is the default', () => {
    const options = at(SAME, 2).questions[0].options;
    expect(options.map((o) => o.label)).toEqual([
      'Two pickings, count line 2 as well',
      'Replaced by line 3, do not count it',
    ]);
    expect(options.map((o) => o.quantityKg)).toEqual(['1150', '0']);
  });

  it('leaves it alone when a note says one row replaces the other', () => {
    // Line 17 of the real file says "re-weighed after grading". With that note
    // the pair is settled by SQL, and no customer is asked anything.
    const noted = file(
      'B3,Sweetheart,2026-03-12,1150,kg,R Craig,',
      'B3,Sweetheart,2026-03-12,1105,kg,R Craig,re-weighed after grading',
    );
    expect(at(noted, 2).status).toBe('counted');
    expect(at(noted, 2).questions).toEqual([]);
  });

  it('does not park two rows that differ in any of the four fields', () => {
    const different = file(
      'B3,Sweetheart,2026-03-12,1150,kg,R Craig,',
      'B3,Sweetheart,2026-03-13,1105,kg,R Craig,',
    );
    expect(at(different, 2).status).toBe('counted');
    expect(at(different, 3).status).toBe('counted');
  });
});

// ---------------------------------------------------------------------------
// Applying what a person answered
// ---------------------------------------------------------------------------

describe('a decision on a row', () => {
  const NO_UNIT = file('B3,Sweetheart,2026-03-09,1210,,R Craig,');

  it('is parked while nobody has answered', () => {
    expect(at(NO_UNIT, 2).status).toBe('parked');
    expect(at(NO_UNIT, 2).quantityValue).toBe('1210');
    expect(at(NO_UNIT, 2).unitFactor).toBeNull();
  });

  it('counts the row once a unit is chosen, at the weight the option carried', () => {
    const rows = buildRows(
      NO_UNIT,
      decide('row', 'unit', 'b3|sweetheart|2026-03-09|1210', 'kg', { quantityKg: '1210' }),
    );
    expect(rows[0].status).toBe('counted');
    expect(rows[0].quantityValue).toBe('1210');
    // Already kilograms, so the factor is 1. The row's own unit is not applied
    // a second time to a figure a person gave in kilograms.
    expect(rows[0].unitFactor).toBe('1');
  });

  it('takes the pounds reading when that is the one chosen', () => {
    const rows = buildRows(
      NO_UNIT,
      decide('row', 'unit', 'b3|sweetheart|2026-03-09|1210', 'lb', {
        quantityKg: multiplyExact('1210', '0.45359237'),
      }),
    );
    expect(rows[0].status).toBe('counted');
    expect(rows[0].quantityValue).toBe('548.8467677');
  });

  it('keeps the question, so the answer can be seen and changed', () => {
    // A decision nobody can see is a decision nobody can correct. The row
    // counts and the question stays attached, which is what puts it under
    // "answered by a person" with the chosen option marked.
    const rows = buildRows(
      NO_UNIT,
      decide('row', 'unit', 'b3|sweetheart|2026-03-09|1210', 'kg', { quantityKg: '1210' }),
    );
    expect(rows[0].questions.map((q) => q.field)).toEqual(['unit']);
  });

  it('follows the row rather than the line it is on', () => {
    // The same row, moved down by an insert above it. A decision keyed on the
    // line number would land on the new row instead.
    const moved = file('B1,Lapins,2026-03-01,500,kg,J Silvestre,', 'B3,Sweetheart,2026-03-09,1210,,R Craig,');
    const rows = buildRows(
      moved,
      decide('row', 'unit', 'b3|sweetheart|2026-03-09|1210', 'kg', { quantityKg: '1210' }),
    );
    const parked = rows.find((r) => r.sourceLine === 3);
    expect(parked?.status).toBe('counted');
  });

  it('ignores a decision written against a different row', () => {
    const rows = buildRows(
      NO_UNIT,
      decide('row', 'unit', 'b3|sweetheart|2026-03-09|999', 'kg', { quantityKg: '999' }),
    );
    expect(rows[0].status).toBe('parked');
    expect(rows[0].unitFactor).toBeNull();
  });

  it('keys on the row exactly as the grower wrote it', () => {
    expect(rowSubject({
      block: 'B3', variety: 'Sweetheart', harvestDate: '2026-03-09', quantity: '1210',
      unit: null, grader: 'R Craig', notes: null,
    })).toBe('b3|sweetheart|2026-03-09|1210');
  });
});

describe('a decision on a spelling', () => {
  const UNKNOWN = file(
    'B3,Swithart,2026-03-06,990,kg,R Craig,',
    'B3,Swithart,2026-03-07,800,kg,R Craig,',
  );

  const SWITHART = decide('spelling', 'variety', 'swithart', 'Sweetheart', {
    variety: 'Sweetheart',
  });

  it('reads the word on every row that carries it, not just the one asked about', () => {
    // This is the difference between the two scopes. A unit answer is about one
    // row. "Swithart means Sweetheart" is true of the word, so answering it once
    // settles both rows here and every future file that spells it that way.
    const rows = buildRows(UNKNOWN, SWITHART);
    expect(rows.map((r) => r.variety)).toEqual(['Sweetheart', 'Sweetheart']);
    expect(rows.map((r) => r.status)).toEqual(['counted', 'counted']);
  });

  it('says a person decided it, not that a table knew it', () => {
    const rows = buildRows(UNKNOWN, SWITHART);
    expect(rows[0].resolvedNote).toBe(
      'variety written "Swithart", read as Sweetheart: confirmed by a person',
    );
  });

  it('keeps the question, so the answer can be seen and changed', () => {
    const rows = buildRows(UNKNOWN, SWITHART);
    expect(rows[0].questions.map((q) => q.field)).toEqual(['variety']);
  });

  it('leaves the row out when the answer is that it is not a variety here', () => {
    // The option supplies no variety, so nothing completes the row and it stays
    // parked. That is the answer working, not the answer failing.
    const notAVariety = decide('spelling', 'variety', 'swithart', 'Not a variety in this data, do not count it');
    const rows = buildRows(UNKNOWN, notAVariety);
    expect(rows.map((r) => r.status)).toEqual(['parked', 'parked']);
    expect(rows[0].variety).toBeNull();
  });

  it('does not touch a spelling nobody answered', () => {
    const rows = buildRows(UNKNOWN, decide('spelling', 'variety', 'sweetcorn', 'Sweetheart', {
      variety: 'Sweetheart',
    }));
    expect(rows[0].variety).toBeNull();
    expect(rows[0].status).toBe('parked');
  });
});
