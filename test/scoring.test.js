import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGrades } from '../src/shared/scoring.js';
import { suggestLevel } from '../src/shared/checklist.js';
import { TALENT_BAR } from '../src/shared/framework.js';

// The H1 2026 Excel's Talent Bar sheet, with Culture 1 applied to Radical Transparency
// (the version the Excel actually used). Used only to prove the rules match the formulas.
const B = 2, I = 3, A = 4, E = 5;
function excelBar() {
  const rows = {
    //       RT impact owner cx q  sp  s1 s2 s3
    Junior: [B, B, B, B, B, B, B, B, B],
    Mid: [I, B, B, B, B, B, I, I, I],
    Senior: [I, I, I, I, I, I, A, I, I],
    Lead: [A, I, I, A, A, A, A, A, I],
    Head: [A, A, A, E, E, E, E, A, A],
    VP: [E, E, E, E, E, E, E, E, E],
  };
  const keys = ['radical_transparency', 'impact', 'ownership', 'complexity', 'quality', 'speed', 'skill1', 'skill2', 'skill3'];
  const out = {};
  for (const [s, vals] of Object.entries(rows)) out[s] = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  return out;
}

const sample = [
  // Ratings and cached results of the three rows in Performance_cycle_H1_2026.xlsx
  { seniority: 'Mid', r: [4, 3, 4, 3, 2, 2, 3, 3, 3], areas: ['A_PLAYER', 'ABOVE_BAR', 'ABOVE_BAR'], overall: 'ABOVE_BAR' },
  { seniority: 'Senior', r: [3, 3, 3, 2, 4, 3, 4, 4, 3], areas: ['ABOVE_BAR', 'UNDERPERFORMER', 'ABOVE_BAR'], overall: 'UNDERPERFORMER' },
  { seniority: 'Mid', r: [4, 4, 4, 4, 3, 5, 4, 4, 3], areas: ['A_PLAYER', 'A_PLAYER', 'ABOVE_BAR'], overall: 'A_PLAYER' },
];
const keys = ['radical_transparency', 'impact', 'ownership', 'complexity', 'quality', 'speed', 'skill1', 'skill2', 'skill3'];
const toRatings = (r) => Object.fromEntries(keys.map((k, i) => [k, r[i]]));

test('grades match the H1 2026 Excel when using the Excel talent bar', () => {
  for (const row of sample) {
    const g = computeGrades(toRatings(row.r), row.seniority, excelBar());
    assert.deepEqual([g.areas.culture, g.areas.deliverables, g.areas.skills], row.areas);
    assert.equal(g.overall, row.overall);
  }
});

test('the app uses the Excel talent bar (Radical Transparency is the first cultural value)', () => {
  assert.deepEqual(TALENT_BAR, excelBar());
  for (const row of sample) {
    const g = computeGrades(toRatings(row.r), row.seniority);
    assert.equal(g.overall, row.overall);
  }
  assert.equal(TALENT_BAR.Mid.radical_transparency, 3);
  assert.equal(TALENT_BAR.Mid.impact, 2);
  assert.equal(TALENT_BAR.Lead.radical_transparency, 4);
  assert.equal(TALENT_BAR.Lead.impact, 3);
});

test('any 1 gives Values Concern, overall Values Concern wins', () => {
  const r = toRatings([5, 5, 5, 5, 5, 5, 5, 5, 1]);
  const g = computeGrades(r, 'Junior');
  assert.equal(g.areas.skills, 'VALUES_CONCERN');
  assert.equal(g.overall, 'VALUES_CONCERN');
});

test('two A-Player areas beat one Underperformer area', () => {
  // Junior bar is 2 everywhere: culture/deliverables at 3+ are A-Player, a skill at... 2 is fine,
  // so use Senior where skill1 bar is 4.
  const r = toRatings([4, 4, 4, 4, 4, 4, 3, 4, 4]);
  const g = computeGrades(r, 'Senior');
  assert.equal(g.areas.culture, 'A_PLAYER');
  assert.equal(g.areas.deliverables, 'A_PLAYER');
  assert.equal(g.areas.skills, 'UNDERPERFORMER');
  assert.equal(g.overall, 'A_PLAYER');
});

test('incomplete ratings give no grade', () => {
  const r = toRatings([3, 3, 3, 3, 3, 3, 3, 3, null]);
  const g = computeGrades(r, 'Mid');
  assert.equal(g.areas.skills, null);
  assert.equal(g.overall, null);
  assert.notEqual(g.areas.culture, null);
});

const S = {
  POOR: ['p0', 'p1'],
  BASIC: ['b0', 'b1'],
  INTERMEDIATE: ['i0', 'i1'],
  ADVANCED: ['a0'],
  EXCEPTIONAL: ['e0'],
};

const NO_POOR = { 0: 'no', 1: 'no' };

test('checklist: any Poor yes gives Poor', () => {
  assert.equal(suggestLevel(S, { POOR: { 1: 'yes' }, BASIC: { 0: 'yes', 1: 'yes' } }), 1);
});

test('checklist: first Basic statement No gives Poor, even if a later one is Yes', () => {
  assert.equal(suggestLevel(S, { POOR: NO_POOR, BASIC: { 0: 'no', 1: 'yes' } }), 1);
});

test('checklist: a later Basic statement No gives Basic', () => {
  assert.equal(suggestLevel(S, { POOR: NO_POOR, BASIC: { 0: 'yes', 1: 'no' } }), 2);
});

test('checklist: first statement of a level No -> level below; a later one No -> that level', () => {
  const answers = { POOR: NO_POOR, BASIC: { 0: 'yes', 1: 'yes' }, INTERMEDIATE: { 0: 'no', 1: 'yes' } };
  assert.equal(suggestLevel(S, answers), 2);
  answers.INTERMEDIATE = { 0: 'yes', 1: 'no' };
  assert.equal(suggestLevel(S, answers), 3);
  answers.INTERMEDIATE = { 0: 'yes', 1: 'yes' };
  answers.ADVANCED = { 0: 'yes' };
  answers.EXCEPTIONAL = { 0: 'no' };
  assert.equal(suggestLevel(S, answers), 4);
  answers.EXCEPTIONAL = { 0: 'yes' };
  assert.equal(suggestLevel(S, answers), 5);
});

test('checklist: the first No stops it, answers further down do not count', () => {
  const answers = { POOR: NO_POOR, BASIC: { 0: 'yes', 1: 'no' }, INTERMEDIATE: { 0: 'yes', 1: 'yes' }, ADVANCED: { 0: 'yes' } };
  assert.equal(suggestLevel(S, answers), 2);
});

test('checklist: nothing answered (or only Poor) gives no suggestion; half-way gives the level so far', () => {
  assert.equal(suggestLevel(S, {}), null);
  assert.equal(suggestLevel(S, { POOR: NO_POOR }), null);
  assert.equal(suggestLevel(S, { POOR: NO_POOR, BASIC: { 0: 'yes', 1: 'yes' } }), 2);
});

import { parseTypedDate } from '../src/dates.js';
test('typed deadlines: day first, several spellings, bad dates refused', () => {
  assert.equal(parseTypedDate('06/01/2027'), '2027-01-06');
  assert.equal(parseTypedDate('6-1-2027'), '2027-01-06');
  assert.equal(parseTypedDate('06.01.2027'), '2027-01-06');
  assert.equal(parseTypedDate('2027-01-06'), '2027-01-06');
  assert.equal(parseTypedDate('6 Jan 2027'), '2027-01-06');
  assert.equal(parseTypedDate('23-Nov-2026'), '2026-11-23');
  assert.equal(parseTypedDate('6 January 2027'), '2027-01-06');
  assert.equal(parseTypedDate('31/02/2027'), null);
  assert.equal(parseTypedDate('soon'), null);
  assert.equal(parseTypedDate(''), null);
});
