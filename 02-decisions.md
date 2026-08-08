# 02 - Decisions

One choice per problem, one line of reason each. If the reason cannot be written, the choice has not been made.

Stack is fixed by the task: NestJS, Postgres, TypeScript. No auth, no deployment, no CI.

Every number in this document was recomputed from `data/harvest-records-2026.csv` and matches it.

---

## A. How rows are stored

### A1. Nothing is thrown out

Every line in the file gets a row in the table, including the empty line 13 and the `TOTAL` line 27. A `status` column carries four values:

- `counted` - enters the total
- `parked` - readable, not counted, waiting on an answer from the customer
- `superseded` - replaced by a later row
- `not_a_record` - not a harvest at all, kept for the audit trail, never countable

Reason: throwing a row away hides the problem from the person who can fix it. A missing row nobody mentioned is a wrong number.

Why a status enum and not a boolean: `parked` and `superseded` are both "not counted" but need different handling. One asks the customer a question. The other points at a replacement row.

### A2. Store the value as written and the converted value

`quantity_raw TEXT`, `unit_raw TEXT`, `quantity_kg NUMERIC`. Never only the converted one.

Reason: a customer can always be shown where a figure came from. `"1,240"` and `2100 lb` both survive in the form they were typed.

### A3. `DATE`, never `TIMESTAMP`

Reason: a harvest happened on a day, not at a moment. `TIMESTAMP` lets the server timezone shift a row to the previous day. The machine runs Asia/Kolkata.

### A4. The `TOTAL` row and the empty row are `not_a_record`

Stored, never countable, no question attached.

Reason: if `TOTAL` is counted as a harvest, every number after it is wrong. Deleting it means nobody can later prove what the file contained. The file can be reconciled against the table line by line.

### A5. One table for all four statuses, not a table per status

`harvest_record` holds counted, parked, superseded and not_a_record rows together. Status is a column, not a table.

Reason: a row moves between statuses as questions get answered - a parked row becomes counted the moment the customer names the unit. Separate tables would mean moving rows between them and reassigning ids. The source line is the row's identity from import onwards, and it should not change because a status did.

### A6. `NUMERIC`, not float, for every weight

`quantity_kg NUMERIC(12,3)`.

Reason: 2,100 lb converts to 952.543977 kg, which binary floating point cannot hold exactly, and these values get summed. `NUMERIC` is exact decimal, so the same rows produce the same total every time. Three decimal places is grams, which is finer than anything this file records.

## B. The judgement calls the data forced

### B1. `sweethart` is `Sweetheart` - lookup table, not fuzzy matching

Reason: R Craig spells it correctly on his six other Block 3 rows, so it is a typo, and the file answers this one. A lookup table is explicit and a person can read it. Fuzzy matching would silently merge two real varieties one day.

### B2. A row with no unit is parked, not filled

Lines 6 and 11. Do not write a value the row never carried. Attach the evidence so the customer can answer in one step: every other Block 3 row says `kg`.

Reason: the block-to-unit rule is strong evidence, not the value. A wrong unit moves a row by 2.2x (lb) or 1000x (g), and nothing in the row itself says which.

The block-to-unit map stays in `rules.ts`. It supplies the evidence sentence that travels with the park, not the value.

On this file line 11 is the only row this changes. Line 6 also has no unit but is parked for a harder reason: `record lost`, no quantity at all.

### B3. The ambiguous date `03/04/2026` is parked

Line 5. Show what the total becomes under each reading.

Reason: `03/04/2026` is a valid way to write both dates, so there is no correct value hiding in the file. A value that might fall outside the month being asked about must not enter a total silently.

Row position was tested as evidence and rejected: line 18 (`4 Mar 26`) sits between 12 and 13 March, so this file demonstrably misplaces rows.

The question names a month, so the date filter is required in code. On this file every other row is already March, so the filter changes the outcome for this one row only. That is not the same as "dates do not matter here".

### B4. A parked row carries a question with options, not a yes/no

Each option shows the value it produces and what the answer becomes.

Line 11 - no unit written. Evidence: every other Block 3 row is kg.

Every figure below is written to three decimal places, because that is what the table stores and what the endpoint returns (A6). If this document and the output ever disagree, one of them is wrong, and rounding here would hide which.

| Option | Row becomes | Answer becomes |
|---|---|---|
| kg | 1,210.000 kg | 4,380.000 |
| lb | 548.847 kg | 3,718.847 |
| g | 1.210 kg | 3,171.210 |

Line 5 - date written `03/04/2026`.

| Option | In range? | Answer becomes |
|---|---|---|
| 4 March 2026 | yes | 4,350.000 |
| 3 April 2026 | no | 3,170.000 |

Line 6 - `record lost`, note "pickers left early". Free-text question, no options. Nobody can pick a weight from a list.

The two parks are independent, so each carries its own kilogram delta. A single chained figure cannot express that. Confirming both gives 5,560.000.

**The endpoint answers 3,170.000 kg**, from lines 7, 17 and 26.

### B5. The two rows on 12 March - the re-weigh supersedes

Line 16 (1150) is marked `superseded_by` line 17 (1105). Both rows stay. Only 1105 counts.

Reason: the note says what happened - "re-weighed after grading". Deleting the first row loses the history.

### B6. The `-120` row appends, it does not modify

Line 20 stays its own row with a negative quantity. The row it corrects (line 15) is not touched. Link by block, variety and date together, never by date alone. If the match is not unique, store it unlinked and flag it.

Reason: three rows fall on 12 March and only one is B4 Regina. Matching on date alone would attach a Block 4 correction to a Block 3 Sweetheart row.

Second reason: the file has two kinds of correction. A re-weigh replaces. A negative adjustment appends. Modelling both keeps the table append-only, so the history survives.

Scope: this row is B4 Regina and does not touch the Block 3 answer.

### B7. "Block 3" becomes `B3` by lookup table

Reason: the model should not invent block codes. Give it the list of blocks that exist.

### B8. The values the file answers outright

These are read by the code. No question goes to the customer.

- **`"1,240"` on line 4 - strip the comma.** A quoted thousands separator has one reading.
- **`4 Mar 26` on line 18 - parses to 4 March 2026.** The month is written in words, so there is nothing to resolve.
- **`kg`/`Kg` and `lb`/`lbs`/`Lb` - normalised by lookup table.** Casing and plurals are spelling, not meaning.

### The line between the two groups

B1 and B8 have one reading, so the code reads them.

Lines 5, 6 and 11 have more than one reading, or none at all, so the customer answers them.

That is the whole rule. Nothing else decides what gets parked.

## C. Where the LLM sits

### C1. The model turns the question into a filter

It never sees harvest rows and it never produces a number.

Reason: Postgres does the arithmetic, so the number cannot be invented. The model reads English, which is the part code is bad at.

### C2. The model may write the sentence back, only if there is time

Every number in the sentence is compared to what Postgres returned. Exact match, no tolerance. Any mismatch and the sentence is thrown away and the structured answer is shown instead.

Reason: this is the one route by which a wrong number could reach the customer.

### C3. Guards on the filter

- The model may only name blocks and varieties that exist. A filter naming anything else is rejected, not silently emptied.
- A canary string `_canary: DO_NOT_REFERENCE` sits in the prompt. If it comes back in the output, the output is thrown away.
- The prompt says: use only the data given, never estimate or round, do not use general knowledge, say you cannot answer when the question does not fit the data.

Reason: an empty result and a wrong filter look identical to the customer. Rejecting is the difference.

### C4. What the endpoint returns

The number, what the question was understood to mean, the rows counted, every row not counted with its reason, and every parked row with its options and its own kilogram delta.

Reason: this is the direct answer to "a wrong number cannot reach the customer". The customer sees the figure, sees what is not in it, and can move a parked row into it by answering one question. `understood_as` shows what the system thought the question meant, which is where a wrong number usually starts.

## D. Build choices

### D1. Raw SQL with the `pg` driver, not an ORM

Reason: one table and one read query. An ORM is setup time with nothing saved.

### D2. Migrations as plain `.sql` files applied with `psql`

Reason: one migration. A migration tool is a dependency to explain.

### D3. Postgres on the host, not Docker

Reason: smaller install, no daemon to fail on the day, and `psql` comes with it. Cost: the README says how to start Postgres instead of shipping one Docker command.

### D4. Mock provider, built last

`AI_PROVIDER=mock` returns one hard-coded intent object.

Reason: a shape that has not been decided cannot be mocked. Build the real provider first and let `intent.schema.ts` settle. Its value is as a fallback if the API is down, and that value does not need it to exist early.

### D5. Tests are the evidence, not extra

Eight small tests on the parsers, each named after a real row. Written beside the parser while the row is fresh, not saved for the end.

- `"1,240"` becomes 1240
- `record lost` is parked, not read as 0
- `03/04/2026` is parked with both readings
- `4 Mar 26` parses to 4 March 2026
- `lbs` and `Lb` both convert to kilograms
- A blank unit is parked, not filled
- The `TOTAL` row is stored as `not_a_record`, never counted
- The blank row is stored as `not_a_record`, never counted

No controller tests, no module wiring tests, no coverage target. The task says coverage is not assessed.

Reason: "how did you check the output was right" is the question the task says it cares about. These tests are the answer.

### D6. Hand-written scaffolding, not `nest new`

`nest new` was not run. Four files were written by hand: `package.json`, `tsconfig.json`, `src/main.ts` and `src/app.module.ts`. The `@nestjs/cli` package is not installed.

Reason: `nest new` ships eslint, prettier, a jest and ts-jest setup, an e2e test folder, `nest-cli.json` and a sample controller with its spec. None of that is used here. The task says test coverage and polish are not assessed, so the generated test harness would be configuration nobody reads. What is used is four files totalling about 60 lines.

Cost, and it is real: `nest build`, `nest start --watch` and `nest generate` do not exist in this project. `tsconfig.json` has to carry `experimentalDecorators` and `emitDecoratorMetadata` correctly by hand, and NestJS does not start without them. Getting that wrong produces an error message that does not name the missing flag. `nest new` gets that right for you, and this is the one thing it would have been worth having.

Second cost: `vitest` runs the tests instead of `jest`. A NestJS reviewer expects jest. The parsers are plain functions with no dependency injection, so nothing in the test file would change under jest, but it is a difference from what the stack implies.

## E. What gets cut, in order

If the clock is against me at 1:55, stop building and start writing. An unfinished feature with an honest note beats a finished feature with no document.

1. **The model writing the sentence back** (C2). Roughly 20 min. Not asked for.
2. **Re-import safety** - loading the same file twice does not duplicate rows. Roughly 15 min. Not asked for.

Both are wanted. Deciding to build something is not the same as having time for it.

**Not building at all:** any endpoint other than the one asked for. One question was specified.

Everything not built goes in `DECISIONS.md` under "what I deliberately did not build", with the reason.