-- Billing: client details that appear on an invoice, app settings, and a record
-- of every invoice issued.

-- The address is one freeform block rather than structured fields. An invoice
-- reproduces it verbatim, line for line as typed, and countries disagree too
-- much about what the parts of an address are for the structure to earn its
-- keep here.
ALTER TABLE clients ADD COLUMN ein TEXT;
ALTER TABLE clients ADD COLUMN address TEXT;

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Issued invoices. The lines are stored rather than recomputed: a project's rate
-- can change later, and an invoice already sent must keep saying what it said.
CREATE TABLE invoices (
    id           INTEGER PRIMARY KEY,
    -- The running sequence printed on the document. Unique so two invoices can
    -- never share a number, whatever the UI does.
    number       INTEGER NOT NULL UNIQUE CHECK (number > 0),
    client_id    INTEGER NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
    issue_date   TEXT NOT NULL,
    -- Billing period, inclusive start and exclusive end, matching entry queries.
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),
    file_path    TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CHECK (period_start < period_end)
);

CREATE INDEX invoices_client_period ON invoices (client_id, period_start);

CREATE TABLE invoice_lines (
    id           INTEGER PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    -- Nullable: an invoice outlives the project it billed for.
    project_id   INTEGER REFERENCES projects (id) ON DELETE SET NULL,
    description  TEXT NOT NULL,
    minutes      INTEGER NOT NULL CHECK (minutes > 0),
    rate_cents   INTEGER NOT NULL CHECK (rate_cents >= 0),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);

CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
