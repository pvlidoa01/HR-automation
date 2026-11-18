-- Microsoft account object id, linked on first Microsoft sign-in.
ALTER TABLE users ADD COLUMN ms_oid TEXT UNIQUE;
