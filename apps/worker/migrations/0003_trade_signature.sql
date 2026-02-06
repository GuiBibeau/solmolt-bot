ALTER TABLE trade_index ADD COLUMN signature TEXT;

CREATE INDEX IF NOT EXISTS trade_index_signature_idx ON trade_index (signature);

