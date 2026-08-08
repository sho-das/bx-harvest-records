/**
 * The third layer of checking.
 *
 * The parser tests check that a value is read correctly. The check constraint
 * in Postgres stops an incomplete row being counted. This script checks the
 * number the customer actually gets, and it does something the other two
 * cannot: it says which rule broke.
 *
 * Three rows can each be wrongly added to the Block 3 Sweetheart answer, and
 * they are independent: line 16 (1,150), line 5 (1,180) and line 11 (1,210).
 * One row can be wrongly dropped: line 7 (990). One filter can fail entirely.
 * Each of those produces its own number, so a failing run names the file to
 * open rather than just saying the total is wrong.
 *
 * Run with:  npm run verify
 */

import { config } from 'dotenv';
config();

import { getPool, closePool } from '../src/db/pool';
import { selectAnswerKg, selectCountedRows, selectParkedRows } from '../src/ask/queries';
import type { Filter } from '../src/ask/intent.schema';

const QUESTION: Filter = {
  block: 'B3',
  variety: 'Sweetheart',
  dateFrom: '2026-03-01',
  dateToExclusive: '2026-04-01',
};

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    console.log(`          expected ${e}`);
    console.log(`          got      ${a}`);
  }
}

async function main() {
  const pool = getPool();

  console.log('\nThe answer');
  const answer = await selectAnswerKg(pool, QUESTION);
  check('POST /ask returns 3170.000', answer, '3170.000');

  const counted = await selectCountedRows(pool, QUESTION);
  check('from lines 7, 17 and 26', counted.map((r) => r.line), [7, 17, 26]);
  check(
    'and line 7 is the only row where the code read a value rather than took it',
    counted.filter((r) => r.read_as !== null).map((r) => r.line),
    [7],
  );

  // A question where both names are real and no row matches. It is the case
  // that separates a working guard from one that refuses whatever it does not
  // recognise: refusing this would be as wrong as answering Block 9 with 0 kg.
  console.log('\nA real question with no rows answers zero, in the same shape');
  const emptyButValid: Filter = { ...QUESTION, variety: 'Regina' };
  const zero = await selectAnswerKg(pool, emptyButValid);
  check('Regina in Block 3, March 2026 returns 0.000, not 0', zero, '0.000');
  check(
    '  and 0.000 has the same shape as 3170.000',
    [zero.split('.')[1]?.length, answer.split('.')[1]?.length],
    [3, 3],
  );
  check(
    '  with no counted rows',
    (await selectCountedRows(pool, emptyButValid)).length,
    0,
  );
  check(
    '  and nothing parked, because all three parks are Sweetheart',
    (await selectParkedRows(pool, emptyButValid)).length,
    0,
  );

  console.log('\nEvery line in the file is accounted for');
  const status = await pool.query(
    `SELECT status::text AS status, COUNT(*)::int AS n FROM harvest_record GROUP BY status ORDER BY status`,
  );
  check(
    '26 rows: 20 counted, 3 parked, 1 superseded, 2 not_a_record',
    Object.fromEntries(status.rows.map((r: { status: string; n: number }) => [r.status, r.n])),
    { counted: 20, not_a_record: 2, parked: 3, superseded: 1 },
  );

  console.log('\nEach wrong answer names one broken rule');

  // Every figure below is computed from the table, not typed in. If the data
  // changes, these move with it and stay diagnostic.
  const rowKg = async (line: number): Promise<string | null> => {
    const result = await pool.query(
      `SELECT quantity_kg::text AS kg FROM harvest_record WHERE source_line = $1`,
      [line],
    );
    return result.rows[0].kg;
  };

  /** Sums decimal strings in Postgres. Nothing here is added in JavaScript. */
  const sum = async (...values: (string | null)[]): Promise<string> => {
    const result = await pool.query(
      `SELECT (SELECT SUM(v) FROM unnest($1::numeric[]) AS v)::text AS total`,
      [values.filter((v): v is string => v !== null)],
    );
    return result.rows[0].total;
  };

  const parked = await selectParkedRows(pool, QUESTION);
  const unitPark = parked.find((p) => p.line === 11);

  // Line 11 has no quantity_kg in the table at all, because no unit was
  // written and nothing filled one in. Its weight exists only as an option on
  // the parked question. That is not an accident of this script: "filled
  // instead of parked" is precisely the mistake where 1210 becomes a weight,
  // and the table refuses to hold one until somebody names the unit.
  const line11AsKg = unitPark?.options.find((o) => o.label === 'kg')?.row_becomes_kg ?? null;
  check('line 11 holds no weight in the table until a unit is named', await rowKg(11), null);
  check('  its kg reading, 1210.000, lives on the parked option', line11AsKg, '1210.000');

  check('2180.000 means the sweethart lookup did not fire', await sum(answer, `-${await rowKg(7)}`), '2180.000');
  check('4320.000 means line 16 was not marked superseded', await sum(answer, await rowKg(16)), '4320.000');
  check('4350.000 means 03/04/2026 was read as 4 March', await sum(answer, await rowKg(5)), '4350.000');
  check(
    '4380.000 means the blank unit on line 11 was filled instead of parked',
    await sum(answer, line11AsKg),
    '4380.000',
  );
  check(
    '5560.000 means line 11 was filled AND the date read as 4 March',
    await sum(answer, await rowKg(5), line11AsKg),
    '5560.000',
  );
  check(
    '6710.000 means all three of those broke at once',
    await sum(answer, await rowKg(5), line11AsKg, await rowKg(16)),
    '6710.000',
  );

  const noBlock = await selectAnswerKg(pool, { ...QUESTION, block: null });
  check('8617.439 means the block filter did not apply', noBlock, '8617.439');

  check(
    '  and the endpoint agrees 4380.000 is what confirming kg would give',
    unitPark?.options.find((o) => o.label === 'kg')?.answer_becomes_kg,
    '4380.000',
  );

  console.log('\nEach parked row prices its own options');
  check(
    'line 11: kg, lb, g',
    unitPark?.options.map((o) => [o.label, o.answer_becomes_kg]),
    [['kg', '4380.000'], ['lb', '3718.847'], ['g', '3171.210']],
  );
  const datePark = parked.find((p) => p.line === 5);
  check(
    'line 5: 4 March counts, 3 April does not',
    datePark?.options.map((o) => [o.label, o.in_range, o.answer_becomes_kg]),
    [['4 March 2026', true, '4350.000'], ['3 April 2026', false, '3170.000']],
  );
  const lostPark = parked.find((p) => p.line === 6);
  check('line 6: free text, no options, no delta', {
    free_text: lostPark?.free_text,
    options: lostPark?.options.length,
  }, { free_text: true, options: 0 });

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    await closePool();
    process.exit(1);
  }
  console.log('All checks passed.');
  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
