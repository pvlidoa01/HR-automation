-- 23 Nov 2026: one change-log entry per dimension per save. The rating change goes in the field
-- ("Radical Transparency: rating 4 · Advanced → 3 · Intermediate"); which checklist statements
-- changed goes in details, one line each.
ALTER TABLE change_log ADD COLUMN details TEXT;
