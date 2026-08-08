# Harvest question endpoint

One endpoint. It answers:

> How many kilograms of Sweetheart were harvested in Block 3 in March 2026?

The answer is **3,170.000 kg**, and the response says which three rows produced
it, which rows were left out, and what the answer becomes if the customer
settles each open question.

## Running it

Postgres runs on the host, not in Docker. On macOS with Homebrew:

```bash
brew services start postgresql@16
createdb bx_harvest
```

Then:

```bash
npm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY, or set AI_PROVIDER=mock
npm run migrate               # one .sql file, safe to re-run
npm run import                # reads data/harvest-records-2026.csv
npm start                     # compiles with tsc, then serves on :3000
```

Ask it:

```bash
curl -s -X POST localhost:3000/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"How many kilograms of Sweetheart were harvested in Block 3 in March 2026?"}'
```

`POST`, not `GET` with a query parameter. A question written in English needs
URL encoding, and a URL is written to the access log of every proxy it passes
through. A body is not.

Without an API key, set `AI_PROVIDER=mock` in `.env`. The mock returns one
fixed filter and does not read the question. The response says
`"read_by": {"provider": "mock"}`, so a fixed filter cannot be mistaken for a
filter that was worked out.

## Checking it

```bash
npm test        # 28 unit tests, no database and no network needed
npm run verify  # 21 checks against the loaded data
```

## What the response contains

```json
{
  "answered": true,
  "answer_kg": "3170.000",
  "understood_as": { "block": "B3", "variety": "Sweetheart",
                     "date_from": "2026-03-01", "date_to_exclusive": "2026-04-01" },
  "counted":     [ { "line": 7, "quantity_kg": "990.000",
                     "read_as": "variety written 'sweethart', read as Sweetheart" }, ... ],
  "not_counted": [ { "line": 16, "status": "superseded",
                     "reason": "re-weighed after grading, replaced by line 17" }, ... ],
  "parked":      [ { "line": 11, "field": "unit",
                     "question": "Line 11 has a quantity of 1210 but no unit. Which unit was it?",
                     "evidence": "Every other row in Block 3 that carries a unit says kg (6 rows). ...",
                     "options": [ { "label": "kg", "row_becomes_kg": "1210.000",
                                    "answer_becomes_kg": "4380.000" }, ... ] }, ... ],
  "source": { "file": "harvest-records-2026.csv", "rows_read": 26, "rows_in_scope": 7 }
}
```

`rows_in_scope` is 7: three counted, three parked, one superseded. The customer
can add those up and see that no row disappeared between the file and the
answer.

## Why the answer is 3,170 and not something else

The file does not settle this question. Depending on which parsing rules you
apply, the honest answer is anywhere between 2,180 and 6,710 kg.

So the endpoint counts only what the file settles, and hands back everything it
does not as a question with priced options:

| Line | What is wrong | What the customer is asked |
|---|---|---|
| 5 | date written `03/04/2026` | 4 March 2026 (answer becomes 4,350.000) or 3 April 2026 (stays 3,170.000) |
| 6 | quantity says `record lost` | free text - nobody can pick a weight from a list |
| 11 | quantity 1210, no unit at all | kg (4,380.000), lb (3,718.847) or g (3,171.210) |

The two priced parks are independent, so each carries its own delta. Confirming
both gives 5,560.000.

## Why a wrong number cannot reach the customer

Four things, in the order they act.

**The model never touches a number.** It turns English into a filter and
nothing else. It does not see a harvest row. Postgres does every piece of
arithmetic, including each parked option's delta, so there is no path by which
an invented figure becomes an answer.

**A filter naming something that does not exist is refused.** Ask about Block 9
and the reply is a refusal listing the blocks that do exist. It is not 0 kg. An
empty result and a wrong filter look identical to a customer, and 0 kg reads as
an answer.

**Postgres refuses to count an incomplete row.** A check constraint says a row
cannot have status `counted` unless block, variety, date and kilograms are all
present. That rule is in the database, not in TypeScript, so no code path goes
around it. Line 11 has no `quantity_kg` at all until somebody names the unit.

**Nothing is thrown away.** Every one of the 26 lines becomes a row, including
the blank line 13 and the `TOTAL` line 27. A row that is not counted is
returned with the reason it was not counted. A missing row nobody mentioned is
a wrong number.

## Documents

- [`01-data-analysis.md`](01-data-analysis.md) - what the raw file contains, before any code existed
- [`02-decisions.md`](02-decisions.md) - one choice per problem, one line of reason each
- [`03-build-plan.md`](03-build-plan.md) - order of work, schema, response shape, what was cut
- [`DECISIONS.md`](DECISIONS.md) - the short version the task asked for

## Layout

```
src/
  db/pool.ts                     one pg pool, DATE returned as a string
  db/migrations/001_init.sql     one enum, three tables, two check constraints
  import/rules.ts                every lookup table in the project
  import/parse.ts                readers: settled, ambiguous, or unreadable
  import/import.ts               26 lines in, 26 rows out
  ask/intent.schema.ts           the filter shape and the guards
  ask/llm.ts                     the model, the prompt, the canary
  ask/queries.ts                 the statements that produce every number
  ask/ask.service.ts             model, then guard, then Postgres
  ask/ask.controller.ts          POST /ask
scripts/
  import.ts                      npm run import
  verify.ts                      npm run verify
```

Stack: NestJS, Postgres 16, TypeScript. Raw SQL through the `pg` driver, no
ORM. Migrations are plain `.sql` applied with `psql`. No auth, no deployment,
no CI - the task says those are not assessed.
