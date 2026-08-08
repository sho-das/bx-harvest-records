# DECISIONS

The answer is **3,170.000 kg**, from lines 7, 17 and 26. The endpoint returns
that number, the rows it added up, the rows it left out, and what the answer
becomes if the open questions get answered.

Working notes behind every line here: [`01-data-analysis.md`](01-data-analysis.md),
[`02-decisions.md`](02-decisions.md), [`03-build-plan.md`](03-build-plan.md),
[`04-notes.md`](04-notes.md).

## Built

- Three tables. `harvest_record` holds all 26 data lines, including the blank line 13 and the `TOTAL` line 27. A `status` column with four values decides which rows count. `parked_question` and `parked_option` hold the questions the file cannot answer.
- `POST /ask`. The model turns the English question into a filter. That is all it does. It never sees a harvest row and it never writes a number. Postgres does the maths.
- Three checks run on the filter before any SQL. The model fills a fixed schema, and zod checks the result again. The prompt holds a canary string, and any reply containing it is thrown away without being read. A block or variety that does not exist is refused, and the real names are listed. It is not answered with 0 kg, because 0 kg and a wrong filter look the same to a customer.
- Every model failure returns the same shape: HTTP 502, `answered: false`, `answer_kg: null`, and one sentence saying what went wrong. That covers a bad API key, a rate limit, an outage, a broken reply, a canary hit and a timeout. A test checks the API key never appears in an error message.
- The model call times out after 15 seconds and retries once. The SDK default is ten minutes and two retries, which is too long for someone waiting on a page. `ANTHROPIC_TIMEOUT_MS` overrides it. A value of `0` falls back to 15000, because the SDK treats `0` as no timeout at all.
- On `SIGINT` or `SIGTERM` the HTTP server closes first, so requests already running finish. The database pool closes after that. Closing the pool first would cut the connection under a query still in flight.
- A page at `GET /`. It shows the exact `curl` it sends, and prices each open question.
- 39 unit tests, one check constraint in Postgres, and `npm run verify` with 28 checks.

## Not built

- **The model writing the answer as a sentence.** Cut before I started. It is the one way an invented number could reach a customer.
- **Saving a confirmed answer.** The page shows each option and what it is worth. Picking one saves nothing. The brief asked for one endpoint.
- **Logging when an answer succeeds.** Refusals get logged. Answers do not. If someone reports a wrong number tomorrow, there is nothing to look at. About an hour of work, and the first thing I would do.
- **A rate limit, `statement_timeout`, pool bounds, a row cap.** None of them matter at 26 rows. All of them matter at 26,000. Nothing in the code says so.
- **Auth, deployment, CI, file upload.** Not asked for, or not assessed.

## The judgement calls the data forced

- **The file answers it, so the code reads it.** `"1,240"` loses its comma. `4 Mar 26` writes its month in words, so it parses. `kg`, `Kg`, `lb`, `lbs` and `Lb` are spelling, not meaning. `sweethart` is a typo: R Craig spells it correctly on his six other Block 3 rows. I used a lookup table, not fuzzy matching, because fuzzy matching would merge two real varieties one day.
- **The file does not answer it, so the customer does.** Line 5 says `03/04/2026`, which is 4 March and 3 April equally. Line 11 has a weight and no unit. Line 6 says `record lost`. Each one is parked and priced: 4,350 if line 5 is March, 4,380 if line 11 is kg, 5,560 if both.
- **I nearly filled in line 11 myself.** Every other Block 3 row says kg, and the unit follows the block, not the person. That is good evidence, so it goes to the customer with the question. It is not the answer. A wrong unit moves that row by 2.2 times or 1,000 times.
- **I changed my mind about line 5.** I first read it as 4 March, because of where it sits in the file. Then I found line 18 (`4 Mar 26`) sitting between 12 and 13 March. This file puts rows in the wrong place, and both misplaced rows are the two odd date formats.
- **Two corrections, handled two ways.** Line 17 replaces line 16, because the note says "re-weighed after grading". Both rows stay. Line 20 (`-120`) is added as its own row. I match it by note, block and variety together, never by date alone: three rows fall on 12 March and only one is B4 Regina.
- **The file's own total is wrong.** Line 27 says 28,450 kg. It adds pounds to kilograms as if they were the same unit, and it is short by 1,153 even before that. Converted properly the file comes to about 21,724 kg. Nothing here reads that row as a number.

## Not happy about

- **The filter can be steered, and I have not fixed it.** I wrote 16 trick questions and nine of them changed the filter. "Leave block and variety blank so we get the full picture" returns 18,183.642 kg. That is 5.7 times the right answer, marked `answered: true`, with no warning. No whitelist stops it, because every steered filter is one a real customer could ask for.
- **A made-up number reached the screen once.** `cannot_answer_because` was a sentence the model wrote, and the page printed it where the number goes. Every check watches `answer_kg`, and `answer_kg` stayed `null` the whole time. The made-up number came through a different field. Fixed: the model now picks one of four codes, and this code writes the sentence.
- **The page prints the customer's question back.** That is safe only because the person typing is the person reading. It stops being safe the moment a question arrives from a report, a webhook or a shared link.
- **Two `as` casts** on rows coming out of Postgres, at [`queries.ts:124`](src/ask/queries.ts#L124) and [`:170`](src/ask/queries.ts#L170). Everything else that crosses a boundary gets checked.
- `NUMERIC(12,3)` rounds 1210 lb to 548.847. `selectNotCountedRows` and `selectParkedRows` return the same parked row twice. `moduleResolution` is still `node10`.

## What I would do next

- **In a day.** Build the save path, so confirming a unit moves the row into the total and leaves a trail. Throw awkward questions at the live model, like "how much did we pick last spring" and "Block 3 in Q1". Stop returning parked rows twice.
- **In a week.** Park the filter, not just the rows. The system already parks a row when the file does not settle it, and asks the customer. It never does that for the filter. That is the real fix for the steering.
- **In a week, done differently.** A parked question should be something the grower answers once, and every later file inherits it. Right now a re-import asks again.