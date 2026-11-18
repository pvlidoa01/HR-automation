-- People who can sign in. Created from the roster upload and from Settings.
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name         TEXT NOT NULL,
  -- hr_admin: sees and edits everything (Daria + one backup)
  -- viewer_all: sees everything, read-only (CEO)
  global_role  TEXT CHECK (global_role IN ('hr_admin', 'viewer_all')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Skill list HR picks from. Seeded from the Notion Skill Base; HR can add more.
CREATE TABLE skills (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  definition  TEXT,
  levels      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- behaviour statements per level
  source      TEXT NOT NULL DEFAULT 'hr' CHECK (source IN ('notion', 'hr', 'import')),
  draft       BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cycles (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  deadline      DATE,
  -- setup: HR is preparing the list; open: managers review + HR calibrates; released: employees see results
  status        TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'open', 'released')),
  talent_bar    JSONB NOT NULL,            -- the bar used for this cycle, kept for history
  roster_file   TEXT,                      -- name of the last uploaded Excel
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  initiated_at  TIMESTAMPTZ,
  released_at   TIMESTAMPTZ
);

CREATE TABLE cycle_departments (
  id            SERIAL PRIMARY KEY,
  cycle_id      INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  head_user_id  INTEGER REFERENCES users(id),
  UNIQUE (cycle_id, name)
);

CREATE TABLE reviews (
  id                 SERIAL PRIMARY KEY,
  cycle_id           INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  employee_id        INTEGER NOT NULL REFERENCES users(id),
  reviewer_id        INTEGER NOT NULL REFERENCES users(id),
  department         TEXT NOT NULL,
  position           TEXT NOT NULL,
  seniority          TEXT NOT NULL CHECK (seniority IN ('Junior', 'Mid', 'Senior', 'Lead', 'Head', 'VP')),
  skill1_id          INTEGER REFERENCES skills(id),
  skill2_id          INTEGER REFERENCES skills(id),
  skill3_id          INTEGER REFERENCES skills(id),
  status             TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'draft', 'submitted')),
  action_plan        TEXT NOT NULL DEFAULT '',   -- visible to the employee after release
  hr_action_points   TEXT NOT NULL DEFAULT '',   -- salary / equity / promotion: never shown to the employee
  submitted_at       TIMESTAMPTZ,
  employee_read_at   TIMESTAMPTZ,
  employee_comment   TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id),
  CHECK (employee_id <> reviewer_id)
);
CREATE INDEX reviews_reviewer_idx ON reviews (reviewer_id);
CREATE INDEX reviews_employee_idx ON reviews (employee_id);

CREATE TABLE review_dimensions (
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  dimension  TEXT NOT NULL,
  rating     SMALLINT CHECK (rating BETWEEN 1 AND 5),
  feedback   TEXT NOT NULL DEFAULT '',
  checklist  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- answers[levelKey][index] = 'yes' | 'no'
  PRIMARY KEY (review_id, dimension)
);

-- Every change HR makes to a submitted review, plus submit / reopen events.
CREATE TABLE change_log (
  id         SERIAL PRIMARY KEY,
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT
);
CREATE INDEX change_log_review_idx ON change_log (review_id);

-- Sessions (connect-pg-simple)
CREATE TABLE "session" (
  "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
