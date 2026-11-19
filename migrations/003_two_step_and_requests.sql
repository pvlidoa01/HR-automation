-- Two-step reviews (decided 19 Nov 2026):
--   the reviewer (direct manager) submits -> 'submitted' (waiting for the reviewer's own manager)
--   the reviewer's manager confirms        -> 'closed'
-- When the reviewer has no manager in the cycle (they report to the CEO), the reviewer's submit closes it.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('not_started', 'draft', 'submitted', 'closed'));
ALTER TABLE reviews ADD COLUMN first_submitted_at TIMESTAMPTZ;  -- set once; from then on the second level can see it
ALTER TABLE reviews ADD COLUMN closed_at TIMESTAMPTZ;
UPDATE reviews SET first_submitted_at = submitted_at WHERE submitted_at IS NOT NULL;
UPDATE reviews r SET status = 'closed', closed_at = COALESCE(r.submitted_at, now())
 WHERE r.status = 'submitted'
   AND (NOT EXISTS (SELECT 1 FROM reviews m WHERE m.cycle_id = r.cycle_id AND m.employee_id = r.reviewer_id)
        OR EXISTS (SELECT 1 FROM cycles c WHERE c.id = r.cycle_id AND c.status = 'released'));

-- Access now follows reporting lines; departments are only a label on the review.
DROP TABLE IF EXISTS cycle_departments;

-- A manager asks HR to reopen a submitted review.
CREATE TABLE change_requests (
  id            SERIAL PRIMARY KEY,
  review_id     INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  hr_note       TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX change_requests_one_open ON change_requests (review_id) WHERE status = 'open';

-- Every automatic email, sent or not. Until email sending is set up, emails are only recorded here.
CREATE TABLE email_outbox (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  to_name     TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'not_sent', 'failed', 'off')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX email_outbox_created_idx ON email_outbox (created_at DESC);

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
