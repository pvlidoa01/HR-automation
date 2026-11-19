-- 19 Nov 2026: the CEO (global_role 'viewer_all') can edit every review but is never part of the
-- approval steps, and every review gets a discussion next to it.

-- Messages between the people involved in a review (manager, second level, HR, CEO).
-- Never shown to the employee.
CREATE TABLE review_comments (
  id         SERIAL PRIMARY KEY,
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_review ON review_comments (review_id, created_at);

-- When each person last opened a review, to show "N new" next to it.
CREATE TABLE review_seen (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, review_id)
);

CREATE INDEX change_log_review ON change_log (review_id, at);

-- Reviews that were waiting for the CEO to confirm them are now complete.
WITH waiting AS (
  SELECT r.id FROM reviews r
    JOIN cycles c ON c.id = r.cycle_id AND c.status = 'open'
    JOIN reviews mr ON mr.cycle_id = r.cycle_id AND mr.employee_id = r.reviewer_id
    JOIN users s ON s.id = mr.reviewer_id AND s.global_role = 'viewer_all'
   WHERE r.status = 'submitted'
), closed AS (
  UPDATE reviews SET status = 'closed', closed_at = now(), updated_at = now()
   WHERE id IN (SELECT id FROM waiting) RETURNING id
)
INSERT INTO change_log (review_id, user_id, field)
SELECT id, NULL, 'Completed: the CEO is not part of the approval steps' FROM closed;
