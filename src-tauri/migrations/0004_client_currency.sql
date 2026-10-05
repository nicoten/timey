-- Each client is billed in one currency. Amounts everywhere stay integer cents
-- (minor units); the currency says what they are cents of. Existing clients
-- were all billed in dollars.
ALTER TABLE clients ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'
    CHECK (currency IN ('USD', 'EUR'));

-- An issued invoice keeps the currency it was issued in, so changing a client's
-- currency later cannot relabel a document already sent.
ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
