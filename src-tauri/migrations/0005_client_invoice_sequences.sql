-- Each client gets a short code and its own invoice sequence.
--
-- The printed invoice ID becomes `<code>-<number>` (just the number when the
-- client has no code), so numbers only need to be unique within a client.

ALTER TABLE clients ADD COLUMN code TEXT;

-- Like names, a code is only unique among live clients.
CREATE UNIQUE INDEX clients_active_code ON clients (lower(code))
    WHERE archived_at IS NULL AND code IS NOT NULL;

-- The number the client's next invoice takes. Stored rather than derived from
-- the highest issued, so it can be set by hand when invoices were also issued
-- somewhere else and the sequence has drifted.
ALTER TABLE clients ADD COLUMN next_invoice_number INTEGER NOT NULL DEFAULT 1
    CHECK (next_invoice_number > 0);

UPDATE clients SET next_invoice_number = 1 + coalesce(
    (SELECT max(number) FROM invoices WHERE invoices.client_id = clients.id), 0);

-- The number's UNIQUE was declared inline, which SQLite cannot drop, so the
-- table is rebuilt. invoice_lines references it with ON DELETE CASCADE: it is
-- rebuilt first, against the new table, and the old pair dropped lines-first,
-- so dropping the old invoices table has nothing left to cascade into.
CREATE TABLE invoices_new (
    id           INTEGER PRIMARY KEY,
    -- The running sequence printed on the document, one per client.
    number       INTEGER NOT NULL CHECK (number > 0),
    client_id    INTEGER NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
    -- The client's code when issued, so renaming the code later cannot relabel
    -- a document already sent.
    client_code  TEXT,
    issue_date   TEXT NOT NULL,
    -- Billing period, inclusive start and exclusive end, matching entry queries.
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    total_cents  INTEGER NOT NULL CHECK (total_cents >= 0),
    file_path    TEXT NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'USD',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    UNIQUE (client_id, number),
    CHECK (period_start < period_end)
);

INSERT INTO invoices_new
    (id, number, client_id, client_code, issue_date, period_start, period_end, total_cents,
     file_path, currency, created_at)
SELECT id, number, client_id, NULL, issue_date, period_start, period_end, total_cents,
       file_path, currency, created_at
FROM invoices;

CREATE TABLE invoice_lines_new (
    id           INTEGER PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices_new (id) ON DELETE CASCADE,
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
DROP TABLE invoices;

-- Renaming rewrites invoice_lines_new's foreign key to follow.
ALTER TABLE invoices_new RENAME TO invoices;
ALTER TABLE invoice_lines_new RENAME TO invoice_lines;

CREATE INDEX invoices_client_period ON invoices (client_id, period_start);
CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
