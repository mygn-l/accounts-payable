-- Brings a database created before returned payments up to db/schema.sql: a statement line can be a payment the bank sent back.
-- Safe to run more than once; keeps all data.
--   psql -v ON_ERROR_STOP=1 -d <database> -f db/migrations/005_statement_returns.sql
ALTER TABLE statement_lines DROP CONSTRAINT IF EXISTS statement_lines_kind_check;
ALTER TABLE statement_lines ADD CONSTRAINT statement_lines_kind_check CHECK (kind IN ('eft','cheque','card','return','other'));
