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
import {
  selectAnswerKg,
  selectCountedRows,
  selectNotCountedRows,
  selectParkedRows,
  selectExtremeBlocks,
} from '../src/ask/queries';
import { BLOCKS } from '../src/import/rules';
import type { Filter } from '../src/ask/intent.schema';

const QUESTION: Filter = {
  block: 'B3',
  blockComparison: false,
  highest: true,
  variety: 'Sweetheart',
  dateFrom: '2026-03-01',
  dateToExclusive: '2026-04-01',
  // Carried on the filter, read by no query. Set to what the customer would
  // have typed so this is the real shape, not a stub.
  blockAsWritten: 'Block 3',
  varietyAsWritten: 'Sweetheart',
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

/**
 * Every figure below is the file as shipped, read by the rules in this repo,
 * with nobody having answered anything. A saved decision changes what a row
 * means, so those figures stop being the truth: answer "kg" on line 11 and the
 * counted total is 4380.000, correctly.
 *
 * So this stops rather than checking. The two alternatives are worse:
 *
 *   Clear the decisions first. That deletes what a person recorded, to make a
 *   test pass. It is the only option here that can lose work.
 *
 *   Check both baselines. There is no second baseline to write down. The
 *   number moves with whichever questions were answered and how, so the
 *   expected value would have to be computed the same way the code under test
 *   computes it, which checks nothing.
 *
 * Stopping costs one command to undo, and it cannot report a wrong number as a
 * right one.
 */
async function refuseIfDecided(pool: ReturnType<typeof getPool>): Promise<void> {
  const result = await pool.query(
    `SELECT scope, field, subject, chosen_label FROM decision ORDER BY decided_at`,
  );
  if (result.rowCount === 0) return;

  console.log('\nNothing was checked.\n');
  console.log(
    `This script checks the file as it is read with no decisions saved, and ${result.rowCount} ` +
      `${result.rowCount === 1 ? 'is' : 'are'} saved:\n`,
  );
  for (const row of result.rows) {
    console.log(`  ${row.field} on ${row.scope} "${row.subject}" answered "${row.chosen_label}"`);
  }
  console.log(
    '\nAn answer changes what a row means, so the totals below would be wrong rather\n' +
      'than broken. Clear them and import again to check the file as shipped:\n\n' +
      '  psql "$DATABASE_URL" -c "DELETE FROM decision;" && npm run import\n',
  );
  await closePool();
  process.exit(1);
}

async function main() {
  const pool = getPool();
  await refuseIfDecided(pool);

  console.log('\nThe answer');
  const answer = await selectAnswerKg(pool, QUESTION);
  check('the counted total is 3170.000', answer, '3170.000');

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

  // A park is a question worth asking only if answering it could move this
  // answer. Line 11's date is settled at 9 March and no option changes a date,
  // so on a 4 March question no reading of its unit brings it into range.
  console.log('\nA park is only shown when answering it could change the answer');

  const parkedLines = async (f: Filter) => (await selectParkedRows(pool, f)).map((p) => p.line);
  const oneDay = (from: string, to: string): Filter => ({ ...QUESTION, dateFrom: from, dateToExclusive: to });

  check('March 2026 asks about lines 5, 6 and 11', await parkedLines(QUESTION), [5, 6, 11]);
  check('4 March asks about line 5 only, the one whose date is in question',
    await parkedLines(oneDay('2026-03-04', '2026-03-05')), [5]);
  check('9 March asks about line 11 only', await parkedLines(oneDay('2026-03-09', '2026-03-10')), [11]);
  check('June 2026 asks nothing, because 4 March and 3 April are both outside it',
    await parkedLines(oneDay('2026-06-01', '2026-07-01')), []);

  // The two views of a left-out row must not contradict each other. Before the
  // scope rule, line 11 was absent from the rows left out and present under
  // waiting on an answer, in the same response.
  for (const [label, f] of [
    ['March 2026', QUESTION],
    ['4 March', oneDay('2026-03-04', '2026-03-05')],
    ['June 2026', oneDay('2026-06-01', '2026-07-01')],
  ] as [string, Filter][]) {
    const asked = await parkedLines(f);
    const left = (await selectNotCountedRows(pool, f)).map((r) => r.line);
    check(
      `  every park on ${label} is also listed as a row left out`,
      asked.filter((line) => !left.includes(line)),
      [],
    );
  }

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

  // 8617.439 has two meanings now, and they must not be confused. Asked about
  // one block it means the block filter did not apply. Asked as a comparison
  // it is the correct total across all four. This check is the first meaning:
  // one block asked for, block dropped.
  const noBlock = await selectAnswerKg(pool, { ...QUESTION, block: null });
  check('8617.439 means the block filter did not apply to a single-block question', noBlock, '8617.439');

  check(
    '  and the parked option prices 4380.000 for confirming kg',
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

  // ---------------------------------------------------------------------------
  // The comparison: same question, one block at a time
  // ---------------------------------------------------------------------------

  console.log('\nEvery block answers the same question');
  const comparison: Filter = { ...QUESTION, block: null, blockComparison: true, highest: true };
  const byBlock: [string, string][] = [];
  for (const block of BLOCKS) {
    byBlock.push([block, await selectAnswerKg(pool, { ...comparison, block })]);
  }
  check(
    'B1 4445.000, B2 1002.439, B3 3170.000, B4 0.000',
    byBlock,
    [['B1', '4445.000'], ['B2', '1002.439'], ['B3', '3170.000'], ['B4', '0.000']],
  );

  // A bare GROUP BY returns three rows here, because B4 has no Sweetheart in
  // March. A block missing from the comparison is a block the customer never
  // learns was empty.
  check('B4 is present and empty, not absent', byBlock.length, 4);

  check('B3 still answers 3170.000 inside the comparison', byBlock[2][1], '3170.000');

  check('B1 is the highest of the four', await selectExtremeBlocks(pool, comparison, true), [
    'B1',
  ]);

  // The direction is a different question, not a different sort order, and
  // answering "least" with B1 is a wrong answer rather than an untidy one.
  // B4 wins it at 0.000 because B4 recorded no Sweetheart in March at all.
  check('B4 is the lowest of the four, at 0.000', await selectExtremeBlocks(pool, comparison, false), [
    'B4',
  ]);
  check('  and B4 really is 0.000, so the lowest is not a block that was skipped', byBlock[3][1], '0.000');

  // The one check that catches a fifth block entering the data without
  // entering BLOCKS: the parts would stop adding up to the whole.
  check(
    'the four blocks add up to the whole scope, 8617.439',
    await sum(...byBlock.map(([, kg]) => kg)),
    '8617.439',
  );

  console.log('\nA comparison where nothing matches has no winner, not a first place');
  const june: Filter = { ...comparison, dateFrom: '2026-06-01', dateToExclusive: '2026-07-01' };
  const juneByBlock: string[] = [];
  for (const block of BLOCKS) {
    juneByBlock.push(await selectAnswerKg(pool, { ...june, block }));
  }
  check('every block is 0.000', juneByBlock, ['0.000', '0.000', '0.000', '0.000']);
  // All four tie. The service turns that into "no rows matched in any block"
  // rather than naming B1, which would be a winner of nothing. Both directions
  // have to agree here: with every figure equal there is no highest and no
  // lowest, and a direction that returned one block would be inventing it.
  check('and all four tie for highest, rather than an empty list',
    await selectExtremeBlocks(pool, june, true), ['B1', 'B2', 'B3', 'B4']);
  check('and all four tie for lowest too',
    await selectExtremeBlocks(pool, june, false), ['B1', 'B2', 'B3', 'B4']);

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
