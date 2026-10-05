-- Fixed-price entries: work billed at an agreed amount rather than by the hour.
--
-- A fixed entry has a day and an amount but no time. It is stored at midnight
-- with a zero duration, so range queries and hour totals take it in without
-- special cases: it adds nothing to the hours and its amount to the money.
--
-- SQLite cannot alter a CHECK constraint, so both tables are rebuilt. Nothing
-- holds a foreign key to either, so dropping the old table cascades nowhere.

CREATE TABLE entries_new (
    id               INTEGER PRIMARY KEY,
    -- RESTRICT: deleting a project that holds logged hours must fail loudly.
    project_id       INTEGER NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
    name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
    started_at       TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    -- Integer cents. Non-null makes this a fixed-price entry.
    amount_cents     INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (
        (amount_cents IS NULL
            AND duration_minutes > 0 AND duration_minutes % 15 = 0 AND duration_minutes <= 1440)
        OR
        (amount_cents IS NOT NULL
            AND duration_minutes = 0 AND substr(started_at, 12) = '00:00')
    ),
    CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
    -- Start times sit on the same 15-minute grid as durations.
    CHECK (CAST(substr(started_at, 15, 2) AS INTEGER) % 15 = 0),
    CHECK (CAST(substr(started_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23)
);

INSERT INTO entries_new (id, project_id, name, started_at, duration_minutes, created_at, updated_at)
SELECT id, project_id, name, started_at, duration_minutes, created_at, updated_at FROM entries;

DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

CREATE INDEX entries_started_at ON entries (started_at);
CREATE INDEX entries_project_started ON entries (project_id, started_at);

-- A fixed-price entry becomes its own invoice line with no minutes: a quantity
-- of one, at its amount.
CREATE TABLE invoice_lines_new (
    id           INTEGER PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    -- Nullable: an invoice outlives the project it billed for.
    project_id   INTEGER REFERENCES projects (id) ON DELETE SET NULL,
    description  TEXT NOT NULL,
    -- NULL for a fixed-price line.
    minutes      INTEGER CHECK (minutes IS NULL OR minutes > 0),
    rate_cents   INTEGER NOT NULL CHECK (rate_cents >= 0),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

INSERT INTO invoice_lines_new
SELECT id, invoice_id, project_id, description, minutes, rate_cents, amount_cents FROM invoice_lines;

DROP TABLE invoice_lines;
ALTER TABLE invoice_lines_new RENAME TO invoice_lines;

CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
