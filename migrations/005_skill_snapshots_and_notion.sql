-- 20 Nov 2026: skill questionnaires can be updated from the Notion Skill Base by HR.
-- Each cycle keeps the questionnaire it started with, so answers already given never get mixed up:
-- checklist answers are stored by the statement's position.

ALTER TABLE skills
  ADD COLUMN notion_page_id   TEXT UNIQUE,
  ADD COLUMN notion_edited_at TIMESTAMPTZ,
  ADD COLUMN updated_at       TIMESTAMPTZ;

-- The questionnaire of each skill as it was when the cycle was initiated.
CREATE TABLE cycle_skills (
  cycle_id   INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skills(id),
  name       TEXT NOT NULL,
  definition TEXT,
  levels     JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (cycle_id, skill_id)
);

-- Cycles already initiated keep today's questionnaires.
INSERT INTO cycle_skills (cycle_id, skill_id, name, definition, levels, draft)
SELECT DISTINCT r.cycle_id, s.id, s.name, s.definition, s.levels, s.draft
  FROM reviews r
  JOIN cycles c ON c.id = r.cycle_id AND c.status <> 'setup'
  JOIN skills s ON s.id IN (r.skill1_id, r.skill2_id, r.skill3_id);
