# DECISIONS

The endpoint answers **3,170.000 kg** and returns the three rows it counted,
the four rows it did not, and what the answer becomes under each open question.

Longer versions of everything here: [`01-data-analysis.md`](01-data-analysis.md),
[`02-decisions.md`](02-decisions.md), [`03-build-plan.md`](03-build-plan.md).

## What I built

- One table holding all 26 lines of the file, including the blank line 13 and the `TOTAL` line 27. A four-value `status` column decides what is countable.
- `POST /ask`. The model turns English into a filter. Postgres produces every number.
- Parked rows: the file does not settle three of the seven Block 3 Sweetheart rows, so each comes back as a question with options, and each option is priced.
- 21 unit tests, a check constraint in Postgres, and `npm run verify` (17 checks).

## What I deliberately did not build

- **The model writing the answer back as a sentence.** It was the first thing on the cut list before I started. It is the one route by which an invented number could reach a customer, and the task did not ask for prose.
- **An endpoint to record a parked answer.** The options are shown with their exact deltas. Choosing one is not built. One endpoint was specified, and showing the options is the part that stops the wrong number.
- **Versioned re-import.** Re-running the import replaces this file's rows rather than doubling them. What is not handled is a row that changed between two imports: the old value is replaced, not kept.
- **A CSV upload route, auth, deployment, CI.** Not asked for, or explicitly not assessed.

## The judgement calls the data forced

The file settles some things and not others. That line decided everything.

**Settled, so the code reads them.** `"1,240"` has one reading, so the comma is
stripped. `4 Mar 26` writes its month in words, so it parses. `kg`/`Kg` and
`lb`/`lbs`/`Lb` are spelling, not meaning. `sweethart` is a typo: R Craig spells
it correctly on his six other Block 3 rows, so the file answers it itself. That
one is a lookup table, not fuzzy matching, because fuzzy matching would merge
two real varieties one day.

**Not settled, so the customer answers them.** Line 5's `03/04/2026` is a valid
way to write both 4 March and 3 April. Line 11 has a weight and no unit at all.
Line 6 says `record lost`. Each is parked and returned with what the answer
becomes under each reading.

I nearly filled line 11 from the block. Every other Block 3 row is kg, and the
unit follows the block rather than the person - Block 2 is in pounds because of
a US buyer sheet. That is strong evidence, and it travels with the question as
a sentence. It is not the value. A wrong unit moves that row by 2.2x or 1000x
and nothing in the row says which.

I also tested row position as evidence for line 5 and rejected it. Line 5 sits
exactly where 4 March belongs, which argues for that reading. But line 18 is
`4 Mar 26` and sits between 12 and 13 March, so this file demonstrably misplaces
rows. Both misplaced-looking rows are the two non-ISO dates.

**Two corrections, modelled differently.** Line 17 says "re-weighed after
grading", so it supersedes line 16 and both rows stay. Line 20 is `-120` and
appends. Its target is found from the note ("correction to 12/03") narrowed by
block and variety, never by date alone: three rows fall on 12 March and only one
is B4 Regina. If that does not leave exactly one row, it is stored unlinked and
flagged.

**The file fails its own cross-check.** Line 27 claims 28,450 kg. Adding every
quantity and ignoring units gives 27,297, and it adds pounds to kilograms as if
they were the same unit. Converted properly the file totals about 21,724 kg. The
grower's own total does not match the grower's own rows. That is the concrete
reason nothing trusts a number because someone typed it.

## Where the LLM sits, and why

It turns the question into a filter. That is all. It never sees a harvest row
and it never produces a number, so Postgres does every piece of arithmetic
including each parked option's delta.

Reading English is the part code is bad at: "Block 3" is not a value in the file,
"March 2026" is not a date range, and "Sweetheart" is spelled four ways.
Arithmetic is the part code is good at. The split follows that.

Three guards. The model fills a tool schema and zod re-checks it, because a tool
schema is a request and not a contract. A canary string sits in the prompt and
any reply containing it is discarded unread. A filter naming a block or variety
that does not exist is refused with the list of real ones, never answered with
0 kg - an empty result and a wrong filter look identical to a customer.

## How I checked the output was right

Three layers, each catching what the others cannot.

1. **21 unit tests**, each named after a real line in the CSV. Two assert a negative, because the negative is the decision: `record lost` must not equal 0, and a blank unit must not equal kg.
2. **A check constraint in Postgres.** A row cannot be `counted` unless block, variety, date and kilograms are all present. It lives in the database, so no code path avoids it. I probed it both ways.
3. **`npm run verify`, 17 checks,** including a diagnostic table. Three rows can each be wrongly added and one wrongly dropped, and each mistake produces its own number: 2,180 means the `sweethart` lookup did not fire; 4,320 means line 16 was not superseded; 4,350 means the date was read as 4 March; 4,380 means line 11 was filled; 8,617.439 means the block filter did not apply. A failing run names the file to open.

Every figure in `02-decisions.md` was recomputed directly from the CSV before
any code existed, and the documents are written to three decimal places to match
what the table stores. If a document and the output disagree later, I want to be
able to tell which one is wrong.

## AI tools, and what I checked

Claude Code wrote most of the TypeScript and SQL, and drafted the analysis and
decision documents from my direction. I did the four steps in a fixed order -
read the raw data, write the analysis, write the decisions, write the build plan
- and no code existed until the decisions did.

What I checked rather than accepted:

- The first pass of the analysis had three wrong facts: it said Sweetheart appears on 6 Block 1 rows (it is 5), cited the wrong line numbers for the 2,180 figure, and said dropping the block filter "roughly doubles" the answer (it is 2.7x). All three were caught by recomputing from the CSV, not by rereading the prose.
- Every number in `02-decisions.md` was then recomputed from the raw file by script - 33 assertions, all passing - before the file was written.
- `npm run verify` exists because "the total looks right" is not a check. It asserts which lines produced the total and what each wrong total would mean.

Two bugs the tests and probes caught that review would not have:

- The `pg` driver returns a `DATE` as a JavaScript `Date` at midnight local time. This machine runs Asia/Kolkata, so 2026-03-12 crossed as 2026-03-11T18:30:00Z. That is a silent off-by-one-day answer. Fixed at the driver: `DATE` now comes back as the string Postgres wrote.
- Dependency injection returned `undefined` at runtime while the typecheck was clean. `tsx` compiles with esbuild, which cannot emit `emitDecoratorMetadata`, so NestJS saw no constructor types. `tsc` validates that flag; esbuild ignores it. Fixed by compiling with `tsc` and running the output.

## What I am not happy about

- **The live model call was never run.** No API key was available in this environment, so `POST /ask` has only been exercised through the mock provider. The guards are unit-tested without a network and the SQL path is verified end to end, but the one thing I cannot claim is that a real model produces a well-formed filter for this question. That is the first thing I would do with an API key.
- **`quantity_kg` is `NUMERIC(12,3)`,** so 1210 lb stores as 548.847 rather than the exact 548.8467677. Grams is finer than anything this file records, but it is a rounding I chose rather than one the data forced.
- **`selectNotCountedRows` and `selectParkedRows` overlap.** A parked row appears in both, once with its question as a reason and once with its priced options. It is honest but it is duplication in the response.
- **The correction-linking rule reads a date out of free text.** "correction to 12/03" is parsed, both readings are tried, and block plus variety must leave exactly one row. It works here and it is guarded, but a note phrased differently would silently produce an unlinked correction rather than an error.
- **I did not build the mock provider last,** as planned. Its precondition was that the filter shape had settled, and it had, so building it early cost nothing. But it means the plan and the build differ, and I would rather they did not.

## What I would do next

**With a day:** run the live model against a list of awkward questions and see
what it does with "how much did we pick last spring" and "Block 3 in Q1". Add
the endpoint that records a parked answer, so confirming a unit moves the row
into the total and leaves an audit trail. Collapse the parked/not-counted
overlap in the response.

**With a week, differently:** the parked question would not be a row in a table
belonging to a CSV import. It would be a first-class thing a grower resolves
once, and every future file with the same ambiguity would inherit the answer.
Right now a re-import re-asks. I would also stop reading the correction target
out of a free-text note and give corrections a real reference column at import,
parked when the note does not settle it - the same rule as everything else.
