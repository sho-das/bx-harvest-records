-- 001_init.sql
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/001_init.sql
-- Safe to run more than once.
--
-- One enum, three tables. Section letters refer to 02-decisions.md.

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

CREATE INDEX IF NOT EXISTS harvest_record_counted_idx
  ON harvest_record (block, variety, harvest_date)
  WHERE status = 'counted';

-- B4. A parked row carries a question with options, not a yes/no.
CREATE TABLE IF NOT EXISTS parked_question (
  id          BIGSERIAL PRIMARY KEY,
  record_id   BIGINT  NOT NULL REFERENCES harvest_record(id) ON DELETE CASCADE,
  field       TEXT    NOT NULL,   -- 'unit', 'harvest_date', 'quantity'
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

CREATE INDEX IF NOT EXISTS parked_question_record_idx ON parked_question (record_id);
CREATE INDEX IF NOT EXISTS parked_option_question_idx ON parked_option (question_id);

COMMIT;
