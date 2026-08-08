# 03 - Build plan

Three hours, hard stop. This is the order of work, the schema, what the endpoint returns, and what gets dropped.

Every decision here comes from `02-decisions.md`. Nothing new is decided in this file.

---

## 1. Order of work

| Clock | What | Minutes |
|---|---|---|
| 0:00 | Skeleton. `nest new`, a `pg` pool, `GET /health` runs `SELECT 1` | 15 |
| 0:15 | Migration. One `.sql` file, applied with `psql` | 15 |
| 0:30 | Parsers and their eight tests | 35 |
| 1:05 | Importer. All 26 rows in, statuses set, links written, parks written | 25 |
| 1:30 | The queries. Checked in `psql` before any endpoint exists | 10 |
| 1:40 | LLM. Intent shape, prompt, provider, guards | 20 |
| 2:00 | Endpoint. Response assembly, parked deltas, the real question end to end | 20 |
| 2:20 | Mock provider and README | 10 |
| 2:30 | `DECISIONS.md` | 15 |
| 2:45 | Spare, or C2 (the model writing the sentence back) | 15 |

Tests are written beside the parsers, not saved for the end. A test written an hour after the row is a test about a remembered row.

### Three checkpoints, each with a named action

**1:30 - all 26 rows are in the table.** If they are not, stop adding row kinds. Get the query working on what is in, and note the missing kind in `DECISIONS.md`.

**2:00 - `psql` returns 3,170 for the real question.** If it does not, the LLM path is not the problem. Stop building it, build the mock provider now instead, and cut C2.

**2:30 - hard start on `DECISIONS.md`,** whatever the state of the code. An unfinished feature with an honest note beats a finished feature with no document.

## 2. The schema

One enum, three tables.

```sql
CREATE TYPE record_status AS ENUM ('counted', 'parked', 'superseded', 'not_a_record');

CREATE TABLE harvest_record (
  id                BIGSERIAL PRIMARY KEY,
  source_file       TEXT    NOT NULL,
  source_line       INTEGER NOT NULL,

  -- as written in the file
  block_raw         TEXT,
  variety_raw       TEXT,
  harvest_date_raw  TEXT,
  quantity_raw      TEXT,
  unit_raw          TEXT,
  grader_raw        TEXT,
  notes             TEXT,

  -- as read by the code. NULL means the file did not settle it.
  block             TEXT,
  variety           TEXT,
  harvest_date      DATE,
  quantity_kg       NUMERIC(12,3),

  status            record_status NOT NULL,
  superseded_by     BIGINT REFERENCES harvest_record(id),
  corrects          BIGINT REFERENCES harvest_record(id),
  correction_unmatched BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT counted_rows_are_complete CHECK (
    status <> 'counted' OR (
      block        IS NOT NULL AND
      variety      IS NOT NULL AND
      harvest_date IS NOT NULL AND
      quantity_kg  IS NOT NULL
    )
  ),
  UNIQUE (source_file, source_line)
);

CREATE INDEX ON harvest_record (block, variety, harvest_date) WHERE status = 'counted';
```

`DATE` not `TIMESTAMP` (A3). `quantity_raw` and `unit_raw` kept beside `quantity_kg` (A2). Nothing deleted, so `superseded_by` and `corrects` point at rows that are still there (A1, B5, B6).

The check constraint is the load-bearing line. A row cannot be `counted` while any field it needs is missing. That rule lives in Postgres, not in TypeScript, so no code path can go around it.

`UNIQUE (source_file, source_line)` is the re-import safety from cut 2. It costs nothing here because the column is already there.

### The parked tables

```sql
CREATE TABLE parked_question (
  id          BIGSERIAL PRIMARY KEY,
  record_id   BIGINT NOT NULL REFERENCES harvest_record(id),
  field       TEXT   NOT NULL,   -- 'unit', 'harvest_date', 'quantity'
  question    TEXT   NOT NULL,
  evidence    TEXT,
  free_text   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE parked_option (
  id            BIGSERIAL PRIMARY KEY,
  question_id   BIGINT NOT NULL REFERENCES parked_question(id),
  label         TEXT   NOT NULL,      -- 'kg', '4 March 2026'
  quantity_kg   NUMERIC(12,3),        -- what the row becomes. NULL = unchanged.
  harvest_date  DATE                  -- what the date becomes. NULL = unchanged.
);
```

An option stores what it does to **the row**, never what it does to **the answer**. The answer changes with the question asked. The row does not.

So "answer becomes 4,380" is computed at query time, from one rule that covers both kinds of park:

```sql
CASE
  WHEN COALESCE(o.harvest_date, r.harvest_date) >= $date_from
   AND COALESCE(o.harvest_date, r.harvest_date) <  $date_to
  THEN COALESCE(o.quantity_kg, r.quantity_kg)
  ELSE 0
END AS delta_kg
```

Apply the option to the row. Re-run the filter. If the row now passes, the delta is its kilograms. If not, the delta is zero.

Line 11 (no unit): the date is already 9 March, so it passes either way, and the delta is the option's kilograms - 1,210 or 548.85 or 1.21.

Line 5 (`03/04/2026`): the kilograms are already 1,180, and the option changes the date. 4 March passes, so the delta is 1,180. 3 April fails, so the delta is 0.

One rule, two different questions. Neither is hard-coded.

### The main query

```sql
SELECT COALESCE(SUM(quantity_kg), 0) AS answer_kg
FROM harvest_record
WHERE status = 'counted'
  AND block   = $1
  AND variety = $2
  AND harvest_date >= $3
  AND harvest_date <  $4;
```

Half-open range, `>= 2026-03-01 AND < 2026-04-01`. It never has to know whether March has 30 or 31 days.

Three statements run per request: this sum, the in-scope rows with their status, and the parked rows with their options and deltas. Every number in all three comes out of Postgres. The application never adds two numbers together.

## 3. What the endpoint returns

`POST /ask` with a JSON body:

```json
{ "question": "How many kilograms of Sweetheart were harvested in Block 3 in March 2026?" }
```

POST, not GET with a query parameter. A question written in English needs URL encoding, and a URL is written to the access log of every proxy it passes through. A body is not.

```json
{
  "answer_kg": 3170,

  "understood_as": {
    "block": "B3",
    "variety": "Sweetheart",
    "date_from": "2026-03-01",
    "date_to": "2026-04-01"
  },

  "counted": [
    { "line": 7,  "date": "2026-03-06", "quantity_raw": "990",
      "unit_raw": "kg", "quantity_kg": 990,
      "read_as": "variety written 'sweethart', read as Sweetheart" },
    { "line": 17, "date": "2026-03-12", "quantity_raw": "1105",
      "unit_raw": "kg", "quantity_kg": 1105, "read_as": null },
    { "line": 26, "date": "2026-03-20", "quantity_raw": "1075",
      "unit_raw": "kg", "quantity_kg": 1075, "read_as": null }
  ],

  "not_counted": [
    { "line": 16, "status": "superseded",
      "reason": "re-weighed after grading, replaced by line 17",
      "superseded_by_line": 17 }
  ],

  "parked": [
    { "line": 11, "field": "unit",
      "question": "Line 11 has a quantity of 1210 but no unit. Which unit was it?",
      "evidence": "Every other Block 3 row in this file is written in kg.",
      "options": [
        { "label": "kg", "row_becomes_kg": 1210,   "answer_becomes_kg": 4380 },
        { "label": "lb", "row_becomes_kg": 548.85, "answer_becomes_kg": 3718.85 },
        { "label": "g",  "row_becomes_kg": 1.21,   "answer_becomes_kg": 3171.21 }
      ] },

    { "line": 5, "field": "harvest_date",
      "question": "Line 5 has the date 03/04/2026. Which date was it?",
      "evidence": "22 of the 24 dates in this file are written year-month-day. This one is not. Row order does not settle it either: line 18 (4 Mar 26) sits between 12 and 13 March, so this file does misplace rows.",
      "options": [
        { "label": "4 March 2026", "in_range": true,  "answer_becomes_kg": 4350 },
        { "label": "3 April 2026", "in_range": false, "answer_becomes_kg": 3170 }
      ] },

    { "line": 6, "field": "quantity",
      "question": "Line 6 says 'record lost' where the quantity should be. The note says 'pickers left early'. What was harvested?",
      "evidence": null,
      "free_text": true,
      "options": [] }
  ],

  "source": { "file": "harvest-records-2026.csv", "rows_read": 26, "rows_in_scope": 7 }
}
```

Four things the customer can see that a bare number hides:

- **`understood_as`** - what the system thought the question meant. A wrong number usually starts here, not in the arithmetic.
- **`read_as`** - the one place the code decided something. Line 7 is the only counted row where a value was read rather than taken as written.
- **`not_counted`** - the row that exists and was left out, with the note from the file explaining why.
- **`parked`** - the three rows the file does not settle, each with the exact number the answer becomes under each reading.

7 rows are in scope: 3 counted, 1 superseded, 3 parked. The customer can add those up and see that nothing vanished.

## 4. File layout

```
src/
  main.ts
  app.module.ts
  db/
    pool.ts
    migrations/001_init.sql
  import/
    rules.ts          block, variety and unit lookup tables
    parse.ts          quantity, unit and date parsers
    parse.spec.ts     the eight tests
    import.ts         reads the CSV, writes the rows and the parks
  ask/
    ask.controller.ts
    ask.service.ts
    queries.ts        the three SQL statements
    intent.schema.ts  the filter shape, validated with zod
    llm.ts            provider, prompt, guards
scripts/
  import.ts
```

Three folders. A year later, changing how a unit is read means opening one file: `rules.ts`.

## 5. How the output gets checked

The task calls this the interesting question. Three layers, each catching something the others cannot.

**Eight parser tests, each named after a real row.** Listed in `02-decisions.md` D5. They catch a parser reading `record lost` as 0, or `Lb` as an unknown unit.

**The check constraint in Postgres.** No row can be `counted` while block, variety, date or kilograms is missing. This catches a bug in the importer, which the parser tests cannot, because the importer is the thing that sets status.

**One end-to-end check with a diagnostic wrong-answer list.** The endpoint must return 3,170 from lines 7, 17 and 26.

Three rows can each be wrongly added, and they are independent of each other: line 16 (1,150), line 5 (1,180) and line 11 (1,210). One row can be wrongly dropped: line 7 (990). One filter can fail entirely.

| If it returns | What broke | Single cause? |
|---|---|---|
| 2,180 | The `sweethart` lookup did not fire | yes |
| 4,320 | Line 16 was not marked superseded | yes |
| 4,350 | `03/04/2026` was read as 4 March | yes |
| 4,380 | The blank unit on line 11 was filled instead of parked | yes |
| 5,560 | Line 11 filled **and** the date read as 4 March | no, two |
| 6,710 | Line 11 filled, date read as 4 March, **and** line 16 not superseded | no, three |
| 8,617.44 | The block filter did not apply | yes |

The ladder in `01-data-analysis.md` is cumulative, so its rungs are not causes. This table is not the ladder. Each single-cause row is one rule failing on its own, which is how a rule usually fails. 5,560 and 6,710 are listed because they are the numbers the ladder produces, and seeing one means more than one rule broke at once.

## 6. What is being cut

From `02-decisions.md` section E, in cut order:

1. **The model writing the sentence back** (C2). Roughly 20 minutes. Not asked for, and it is the only route by which a wrong number could reach the customer.
2. **Full re-import safety.** The `UNIQUE (source_file, source_line)` constraint is in, because it is one line. Handling a second import properly - detecting a changed row, versioning it - is not. Roughly 15 minutes.

Cuts this plan adds:

3. **No endpoint to record a parked answer.** The options are shown with their exact deltas. Choosing one is not built. Reason: the task specified one endpoint, and showing the options is the part that stops a wrong number.
4. **No CSV upload route.** Import is a script run once. Reason: nothing in the task asks for it.

Not building at all: any endpoint other than the one asked for. Auth, deployment, CI - the task says they are not assessed.

Everything above goes in `DECISIONS.md` under "what I deliberately did not build", with the reason beside it.
