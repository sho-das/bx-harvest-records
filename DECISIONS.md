# DECISIONS

The endpoint answers **3,170.000 kg** and returns the three rows it counted,
the four rows it did not, and what the answer becomes under each open question.

Longer versions of everything here: [`01-data-analysis.md`](01-data-analysis.md),
[`02-decisions.md`](02-decisions.md), [`03-build-plan.md`](03-build-plan.md).

## What I built

- One table holding all 26 lines of the file, including the blank line 13 and the `TOTAL` line 27. A four-value `status` column decides what is countable.
- `POST /ask`. The model turns English into a filter. Postgres produces every number.
- Parked rows: the file does not settle three of the seven Block 3 Sweetheart rows, so each comes back as a question with options, and each option is priced.
- A page at `GET /`. One HTML file, plain CSS, vanilla JS, no build step and no new dependency. It calls `/ask` and nothing else.
- 28 unit tests, a check constraint in Postgres, and `npm run verify` (28 checks against the loaded data).

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

No `temperature` is sent. Claude Sonnet 5 rejects the parameter, and it was
never what made this repeatable: the forced tool call fixes the shape, zod
re-checks it, and the block and variety lists fix the vocabulary. A filter that
is only correct at temperature 0 is a filter with no guard on it.

Every failure in the model layer leaves by the same door. A rejected key, a rate
limit, an outage, a malformed reply, a canary hit: all return HTTP 502 with
`answered: false`, `answer_kg: null`, and one sentence saying what failed and
what to do. The message carries the status, the provider's own message and the
model name, and nothing from the request - an error message is where credentials
leak by accident, and a test asserts a key never appears in one.

## The page

It shows the exact `curl` for whatever is in the question box, built from the
same body string it sends. Displaying the command and making the call from one
string is the only way the page can be shown to do nothing the endpoint does not
do. There is one `fetch` in the file and it goes to `/ask`.

Selecting a parked option shows what the answer would become. It writes nothing.
Confirming a park for real is a write path that does not exist, and the page says
that rather than pretending otherwise.

**The one place the page does arithmetic, and why it had to.** Each park is
priced against the base answer once, when the response arrives: its delta is
`answer_becomes_kg` minus `answer_kg`. Selections then add up. The obvious
alternative - showing the selected option's `answer_becomes_kg` as the total -
is wrong the moment two parks are open. Choosing kg on line 11 and 4 March on
line 5 would read 4,380.000 instead of 5,560.000, because each park's figure is
computed against the base and not against each other. So the page adds, in whole
thousandths with `BigInt`, never in floating point. I checked all six
combinations against a live response.

Line 5 read as 3 April has a delta of +0.000, because the row falls outside
March. It is shown as +0.000 rather than hidden: answering a question and having
it change nothing is a result, not a non-event.

A whole park is a different matter, and the page found a bug there. Asking about
4 March showed all three parks, and two of them could not have mattered: line 11
is dated 9 March and no reading of its unit changes a date. Every option read
"answer 0.000". The parked query was filtering on block and variety but not on
date, while the not-counted query filtered on all three, so the same response
listed line 11 as waiting on an answer and did not list it among the rows left
out. A park is now returned only when at least one reading of it lands in range.
Ask about June and line 5 goes too, because 4 March and 3 April are both outside
it. Seven checks in `npm run verify` hold the two views to the same rule.

**Two things that must not look alike, and do not.** Block 9 returns a refusal
with the reason where the number goes and no tables at all. Regina in Block 3
returns 0.000 with the tables present and empty, under the line "No rows matched.
That is the answer, not a failure." The page branches on `answered` alone, which
is the only field that separates them.

## How I checked the output was right

Three layers, each catching what the others cannot.

1. **28 unit tests**, each named after a real line in the CSV or a way the model layer can fail. Two assert a negative, because the negative is the decision: `record lost` must not equal 0, and a blank unit must not equal kg.
2. **A check constraint in Postgres.** A row cannot be `counted` unless block, variety, date and kilograms are all present. It lives in the database, so no code path avoids it. I probed it both ways.
3. **`npm run verify`, 28 checks,** including a diagnostic table. Three rows can each be wrongly added and one wrongly dropped, and each mistake produces its own number: 2,180 means the `sweethart` lookup did not fire; 4,320 means line 16 was not superseded; 4,350 means the date was read as 4 March; 4,380 means line 11 was filled; 8,617.439 means the block filter did not apply. A failing run names the file to open.

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

Four bugs that review would not have found. Two came from running the code, two
from running it against the live model:

- The `pg` driver returns a `DATE` as a JavaScript `Date` at midnight local time. This machine runs Asia/Kolkata, so 2026-03-12 crossed as 2026-03-11T18:30:00Z. That is a silent off-by-one-day answer. Fixed at the driver: `DATE` now comes back as the string Postgres wrote.
- Dependency injection returned `undefined` at runtime while the typecheck was clean. `tsx` compiles with esbuild, which cannot emit `emitDecoratorMetadata`, so NestJS saw no constructor types. `tsc` validates that flag; esbuild ignores it. Fixed by compiling with `tsc` and running the output.
- The first live call failed: Claude Sonnet 5 rejects `temperature`, which I had set to 0 for determinism it was not providing. Worse than the 400 was how it arrived - a bare `{"statusCode":500}`, no reason and no `answer_kg` field at all. A client reading `answer_kg` off that gets `undefined`, and `undefined` becomes 0 in enough places to matter. Only a live run surfaces that; no unit test was going to.
- Asking about Regina in Block 3 returned `answer_kg: "0"` where every other question returns `"3170.000"`. `SUM` over no rows is NULL and the literal 0 replacing it is an integer, so a valid question with no matching rows came back in a different shape from one with rows. Fixed by casting the fallback to `NUMERIC(12,3)` in both places it appears. Nothing in the test suite reached it, because the suite only ever asked questions that had an answer.

The live run of the guards is what turned this from a claim into a check. Block 9
was refused with the list of real blocks. Rainier was refused with the list of
real varieties. A question about the weather was refused as not being about
harvested weight. And Regina in Block 3 was **answered**, with zero - which is
the one that matters, because it is the case that separates a guard that checks
names from a guard that refuses whatever it has not seen before. It is now a
unit test and four checks in `npm run verify`.

## What I am not happy about

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

# DECISIONS

The endpoint answers **3,170.000 kg** and returns the three rows it counted,
the four rows it did not, and what the answer becomes under each open question.

Longer versions of everything here: [`01-data-analysis.md`](01-data-analysis.md),
[`02-decisions.md`](02-decisions.md), [`03-build-plan.md`](03-build-plan.md).

## What I built

- One table holding all 26 data lines of the file, including the blank line 13 and the `TOTAL` line 27. A four-value `status` column decides what is countable.
- `POST /ask`. The model turns English into a filter. Postgres produces every number.
- Parked rows: the file does not settle three of the seven Block 3 Sweetheart rows, so each comes back as a question with options, and each option is priced.
- A page at `GET /`. One HTML file, plain CSS, vanilla JS, no build step and no new dependency. It calls `/ask` and nothing else.
- 28 unit tests, a check constraint in Postgres, and `npm run verify` (28 checks against the loaded data).

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

My first reading of line 5 was 4 March, and I said so before I started building.
Line 5 sits exactly where 4 March belongs in the sequence, and every other row in
the file is March. I changed it while building, once line 18 showed the file will
put a row in the wrong place - and line 18 is the other non-ISO date, so it is
the same class of row. The sequence argument only holds if the sequence is
reliable, and this file shows it is not. The reading that looked settled was
resting on the one piece of evidence the file disproves. It is parked now, with
both readings priced: 4,350 if it is March, 3,170 if it is April.

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

No `temperature` is sent. Claude Sonnet 5 rejects the parameter, and it was
never what made this repeatable: the forced tool call fixes the shape, zod
re-checks it, and the block and variety lists fix the vocabulary. A filter that
is only correct at temperature 0 is a filter with no guard on it.

Every failure in the model layer leaves by the same door. A rejected key, a rate
limit, an outage, a malformed reply, a canary hit: all return HTTP 502 with
`answered: false`, `answer_kg: null`, and one sentence saying what failed and
what to do. The message carries the status, the provider's own message and the
model name, and nothing from the request - an error message is where credentials
leak by accident, and a test asserts a key never appears in one.

## How I checked the output was right

Three layers, each catching what the others cannot.

1. **28 unit tests**, each named after a real line in the CSV or a way the model layer can fail. Two assert a negative, because the negative is the decision: `record lost` must not equal 0, and a blank unit must not equal kg.
2. **A check constraint in Postgres.** A row cannot be `counted` unless block, variety, date and kilograms are all present. It lives in the database, so no code path avoids it. I probed it both ways.
3. **`npm run verify`, 28 checks,** including a diagnostic table. Three rows can each be wrongly added and one wrongly dropped, and each mistake produces its own number: 2,180 means the `sweethart` lookup did not fire; 4,320 means line 16 was not superseded; 4,350 means the date was read as 4 March; 4,380 means line 11 was filled; 8,617.439 means the block filter did not apply. A failing run names the file to open.

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

Four bugs that review would not have found. Two came from running the code, two
from running it against the live model:

- The `pg` driver returns a `DATE` as a JavaScript `Date` at midnight local time. This machine runs Asia/Kolkata, so 2026-03-12 crossed as 2026-03-11T18:30:00Z. That is a silent off-by-one-day answer. Fixed at the driver: `DATE` now comes back as the string Postgres wrote.
- Dependency injection returned `undefined` at runtime while the typecheck was clean. `tsx` compiles with esbuild, which cannot emit `emitDecoratorMetadata`, so NestJS saw no constructor types. `tsc` validates that flag; esbuild ignores it. Fixed by compiling with `tsc` and running the output.
- The first live call failed: Claude Sonnet 5 rejects `temperature`, which I had set to 0 for determinism it was not providing. Worse than the 400 was how it arrived - a bare `{"statusCode":500}`, no reason and no `answer_kg` field at all. A client reading `answer_kg` off that gets `undefined`, and `undefined` becomes 0 in enough places to matter. Only a live run surfaces that; no unit test was going to.
- Asking about Regina in Block 3 returned `answer_kg: "0"` where every other question returns `"3170.000"`. `SUM` over no rows is NULL and the literal 0 replacing it is an integer, so a valid question with no matching rows came back in a different shape from one with rows. Fixed by casting the fallback to `NUMERIC(12,3)` in both places it appears. Nothing in the test suite reached it, because the suite only ever asked questions that had an answer.

The live run of the guards is what turned this from a claim into a check. Block 9
was refused with the list of real blocks. Rainier was refused with the list of
real varieties. A question about the weather was refused as not being about
harvested weight. And Regina in Block 3 was **answered**, with zero - which is
the one that matters, because it is the case that separates a guard that checks
names from a guard that refuses whatever it has not seen before. It is now a
unit test and four checks in `npm run verify`.

## What I am not happy about

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
