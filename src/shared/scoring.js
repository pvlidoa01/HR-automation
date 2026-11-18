// Grade rules, copied from the H1 2026 Excel formulas (decided: keep the formula behaviour).
//
// Per area (Culture, Deliverables, Skills):
//   - any rating of 1                      -> Values Concern (label kept for every area)
//   - any rating below the Talent Bar (-1)  -> Underperformer
//   - every rating at least 1 above the bar -> A-Player
//   - otherwise                             -> Above the Bar
// Overall:
//   - any area Values Concern  -> Values Concern
//   - 2 or more areas A-Player -> A-Player (wins over Underperformer)
//   - any area Underperformer  -> Underperformer
//   - otherwise                -> Above the Bar

import { DIMENSIONS, CATEGORIES, TALENT_BAR } from './framework.js';

export const GRADES = {
  VALUES_CONCERN: 'Values Concern',
  UNDERPERFORMER: 'Underperformer',
  ABOVE_BAR: 'Above the Bar',
  A_PLAYER: 'A-Player',
};

export function expectedLevel(talentBar, seniority, dimensionKey) {
  const row = (talentBar || TALENT_BAR)[seniority];
  return row ? row[dimensionKey] ?? null : null;
}

function areaGrade(ratings, bars) {
  if (ratings.some((r) => r == null) || bars.some((b) => b == null)) return null;
  if (ratings.some((r) => r === 1)) return 'VALUES_CONCERN';
  const diffs = ratings.map((r, i) => r - bars[i]);
  const min = Math.min(...diffs);
  if (min < 0) return 'UNDERPERFORMER';
  if (min >= 1) return 'A_PLAYER';
  return 'ABOVE_BAR';
}

function overallGrade(areaGrades) {
  if (areaGrades.some((g) => g == null)) return null;
  if (areaGrades.includes('VALUES_CONCERN')) return 'VALUES_CONCERN';
  if (areaGrades.filter((g) => g === 'A_PLAYER').length >= 2) return 'A_PLAYER';
  if (areaGrades.includes('UNDERPERFORMER')) return 'UNDERPERFORMER';
  return 'ABOVE_BAR';
}

/**
 * @param {Record<string, number|null>} ratings  rating 1-5 per dimension key
 * @param {string} seniority  Junior | Mid | Senior | Lead | Head | VP
 * @param {object} [talentBar]  the bar stored with the cycle; defaults to the Notion bar
 */
export function computeGrades(ratings, seniority, talentBar = TALENT_BAR) {
  const dimensions = {};
  for (const d of DIMENSIONS) {
    const raw = ratings[d.key];
    const rating = raw == null || raw === '' ? null : Number(raw);
    const expected = expectedLevel(talentBar, seniority, d.key);
    dimensions[d.key] = {
      rating,
      expected,
      diff: rating != null && expected != null ? rating - expected : null,
    };
  }
  const areas = {};
  for (const c of CATEGORIES) {
    const keys = DIMENSIONS.filter((d) => d.category === c.key).map((d) => d.key);
    areas[c.key] = areaGrade(
      keys.map((k) => dimensions[k].rating),
      keys.map((k) => dimensions[k].expected),
    );
  }
  const overall = overallGrade(CATEGORIES.map((c) => areas[c.key]));
  return { dimensions, areas, overall };
}

export function gradeLabel(code) {
  return code ? GRADES[code] : 'Not complete';
}
