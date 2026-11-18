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

test('Notion talent bar changes employee 1 culture from A-Player to Above the Bar', () => {
  const g = computeGrades(toRatings(sample[0].r), 'Mid', TALENT_BAR);
  assert.equal(g.areas.culture, 'ABOVE_BAR');
  assert.equal(g.dimensions.impact.expected, 3);
  assert.equal(g.dimensions.radical_transparency.expected, 2);
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

test('checklist: any Poor yes gives Poor', () => {
  assert.equal(suggestLevel(S, { POOR: { 1: 'yes' }, BASIC: { 0: 'yes', 1: 'yes' } }), 1);
});

test('checklist: all Basic no gives Poor', () => {
  assert.equal(suggestLevel(S, { POOR: { 0: 'no', 1: 'no' }, BASIC: { 0: 'no', 1: 'no' } }), 1);
});

test('checklist: some Basic yes and no Poor gives Basic', () => {
  assert.equal(suggestLevel(S, { POOR: { 0: 'no', 1: 'no' }, BASIC: { 0: 'no', 1: 'yes' } }), 2);
});

test('checklist: level counts only when every statement is yes', () => {
  const answers = { POOR: { 0: 'no', 1: 'no' }, BASIC: { 0: 'yes', 1: 'yes' }, INTERMEDIATE: { 0: 'yes', 1: 'no' } };
  assert.equal(suggestLevel(S, answers), 2);
  answers.INTERMEDIATE[1] = 'yes';
  assert.equal(suggestLevel(S, answers), 3);
  answers.ADVANCED = { 0: 'yes' };
  answers.EXCEPTIONAL = { 0: 'no' };
  assert.equal(suggestLevel(S, answers), 4);
});

test('checklist: nothing answered gives no suggestion', () => {
  assert.equal(suggestLevel(S, {}), null);
});
