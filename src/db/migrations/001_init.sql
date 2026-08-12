-- 001_init.sql
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/001_init.sql
-- Safe to run more than once.
--
-- One enum, four tables. Section letters refer to 02-decisions.md.

BEGIN;

-- A1. Four statuses, not a boolean. `parked` and `superseded` are both
-- "not counted" but need different handling: one asks the customer a
-- question, the other points at a replacement row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_status') THEN
    CREATE TYPE record_status AS ENUM (
      'counted',       -- enters the total
      'parked',        -- readable, not counted, waiting on the customer
      'superseded',    -- replaced by a later row
      'not_a_record'   -- not a harvest at all, kept for the audit trail
    );
  END IF;
END
$$;

-- A5. One table for all four statuses. A parked row becomes counted the
-- moment the customer names the unit, and that must not change its id.
CREATE TABLE IF NOT EXISTS harvest_record (
  id                    BIGSERIAL PRIMARY KEY,
  source_file           TEXT    NOT NULL,
  source_line           INTEGER NOT NULL,

  -- A2. The value as written. Never dropped, so a customer can always be
  -- shown where a figure came from.
  block_raw             TEXT,
  variety_raw           TEXT,
  harvest_date_raw      TEXT,
  quantity_raw          TEXT,
  unit_raw              TEXT,
  grader_raw            TEXT,
  notes                 TEXT,

  -- The value as read. NULL means the file did not settle it.
  block                 TEXT,
  variety               TEXT,
  harvest_date          DATE,             -- A3. DATE, never TIMESTAMP.
  quantity_kg           NUMERIC(12,3),    -- A6. Exact decimal, never float.

  status                record_status NOT NULL,
  superseded_by         BIGINT REFERENCES harvest_record(id),   -- B5
  corrects              BIGINT REFERENCES harvest_record(id),   -- B6
  correction_unmatched  BOOLEAN NOT NULL DEFAULT FALSE,         -- B6

  imported_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The load-bearing line. A row cannot be counted while any field the
  -- total needs is missing. This rule lives in Postgres, so no code path
  -- can go around it.
  CONSTRAINT counted_rows_are_complete CHECK (
    status <> 'counted' OR (
      block        IS NOT NULL AND
      variety      IS NOT NULL AND
      harvest_date IS NOT NULL AND
      quantity_kg  IS NOT NULL
    )
  ),

  -- A row cannot be marked superseded without naming its replacement,
  -- and a row that is not superseded cannot name one.
  CONSTRAINT superseded_rows_name_a_replacement CHECK (
    (status = 'superseded') = (superseded_by IS NOT NULL)
  ),

  CONSTRAINT one_row_per_source_line UNIQUE (source_file, source_line)
);

-- Why a value the lookup tables did not know was read the way it was. Line 7
-- writes `sweethart`, and this says the reading came from R Craig's own rows
-- rather than from a table entry somebody typed. Added after the first version,
-- so it is an ALTER rather than a column above: this file has to stay safe to
-- re-run against a database that already has the table.
ALTER TABLE harvest_record ADD COLUMN IF NOT EXISTS resolved_note TEXT;

-- The row as written, which is what a decision is keyed on. Written by the
-- importer rather than computed here, so the key has one definition and SQL
-- cannot drift from it.
ALTER TABLE harvest_record ADD COLUMN IF NOT EXISTS row_subject TEXT;
CREATE INDEX IF NOT EXISTS harvest_record_subject_idx ON harvest_record (row_subject);

-- The variety as written, in the same lookup form a spelling decision is keyed
-- on. A spelling decision is not tied to a row, so `row_subject` cannot find
-- it, and squashing the raw value in SQL would be a second implementation of
-- `squashed()` in a language that cannot import it. The importer writes it.
ALTER TABLE harvest_record ADD COLUMN IF NOT EXISTS variety_subject TEXT;
CREATE INDEX IF NOT EXISTS harvest_record_variety_subject_idx ON harvest_record (variety_subject);

CREATE INDEX IF NOT EXISTS harvest_record_counted_idx
  ON harvest_record (block, variety, harvest_date)
  WHERE status = 'counted';

-- B4. A parked row carries a question with options, not a yes/no.
CREATE TABLE IF NOT EXISTS parked_question (
  id          BIGSERIAL PRIMARY KEY,
  record_id   BIGINT  NOT NULL REFERENCES harvest_record(id) ON DELETE CASCADE,
  field       TEXT    NOT NULL,   -- 'unit', 'harvest_date', 'quantity', 'duplicate', 'variety'
  question    TEXT    NOT NULL,
  evidence    TEXT,               -- what the file says that points one way
  free_text   BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT one_question_per_field_per_record UNIQUE (record_id, field)
);

-- An option stores what it does to THE ROW, never what it does to THE ANSWER.
-- The answer changes with the question asked. The row does not.
CREATE TABLE IF NOT EXISTS parked_option (
  id            BIGSERIAL PRIMARY KEY,
  question_id   BIGINT NOT NULL REFERENCES parked_question(id) ON DELETE CASCADE,
  label         TEXT   NOT NULL,      -- 'kg', '4 March 2026'
  sort_order    INTEGER NOT NULL DEFAULT 0,
  quantity_kg   NUMERIC(12,3),        -- what the row becomes. NULL = unchanged.
  harvest_date  DATE,                 -- what the date becomes. NULL = unchanged.

  -- An option that changes nothing is not an option.
  CONSTRAINT option_changes_something CHECK (
    quantity_kg IS NOT NULL OR harvest_date IS NOT NULL
  )
);

-- A variety option supplies a name rather than a weight or a date, so the
-- check above has to allow it. Added later, which is why it arrives as an
-- ALTER: this file stays safe to run against a database that already exists.
ALTER TABLE parked_option ADD COLUMN IF NOT EXISTS variety TEXT;

-- "Not a variety in this data" supplies no value at all, and that is the
-- option that makes a variety list honest: a token that is not a typo has no
-- right answer among real varieties. Keeping the row out is a change, so the
-- check counts it as one.
ALTER TABLE parked_option ADD COLUMN IF NOT EXISTS keeps_row_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE parked_option DROP CONSTRAINT IF EXISTS option_changes_something;
ALTER TABLE parked_option ADD CONSTRAINT option_changes_something CHECK (
  quantity_kg IS NOT NULL OR harvest_date IS NOT NULL OR variety IS NOT NULL OR keeps_row_out
);

-- ---------------------------------------------------------------------------
-- What a person decided, so nobody is asked the same question twice
-- ---------------------------------------------------------------------------
--
-- A decision is applied on the next import and the row counts. The question
-- still comes back with that option marked, so it can be changed. Being asked
-- once is a feature; being asked every time is the system forgetting.
--
-- Two scopes, because two kinds of question travel differently:
--
--   'spelling'  the subject is the token as written, lowercased with
--               separators removed. "sweethart means Sweetheart" is true of
--               any file, so this one improves the list for every import.
--
--   'row'       the subject is the row as written: block, variety, date and
--               quantity, exactly as the file spells them. Line numbers were
--               the obvious key and they are the wrong one, because a grower
--               who re-exports with a row inserted moves every line below it
--               and every decision would land on the wrong row.
--
-- Two rows that are identical in all four fields share a decision. That is
-- the duplicate case, and it is the correct answer for it: the same question
-- about the same pair of rows has the same answer.
CREATE TABLE IF NOT EXISTS decision (
  id            BIGSERIAL PRIMARY KEY,
  scope         TEXT    NOT NULL CHECK (scope IN ('spelling', 'row')),
  field         TEXT    NOT NULL,   -- 'unit', 'harvest_date', 'quantity', 'duplicate', 'variety'
  subject       TEXT    NOT NULL,   -- the token, or the row as written
  chosen_label  TEXT    NOT NULL,   -- shown back, so a person can see what they picked

  -- What the chosen option does to the row. The same three columns as an
  -- option, so applying a decision is the same operation as pricing one.
  quantity_kg   NUMERIC(12,3),
  harvest_date  DATE,
  variety       TEXT,

  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT one_decision_per_question UNIQUE (scope, field, subject)
);

CREATE INDEX IF NOT EXISTS decision_lookup_idx ON decision (scope, field, subject);

CREATE INDEX IF NOT EXISTS parked_question_record_idx ON parked_question (record_id);
CREATE INDEX IF NOT EXISTS parked_option_question_idx ON parked_option (question_id);

COMMIT;
