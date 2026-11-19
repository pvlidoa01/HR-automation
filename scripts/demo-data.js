// Fills the database with fictional people and a demo cycle, for trying the app in test mode.
// Structure: Elena Head (not reviewed) -> Alex Lead -> Kim, Lee, Sam
//            Omar Head (not reviewed)  -> Billie Lead -> Pat, Robin
// So Alex writes Kim's review and Elena confirms it; Elena writes Alex's review alone.
// Run: npm run demo   (never against the real database once real reviews exist)
import { pool, one, query } from '../src/db.js';
import { TALENT_BAR } from '../src/shared/framework.js';
import { validateRoster } from '../src/roster.js';
import { saveRoster, initiateCycle } from '../src/cycles.js';

const D = (name) => `${name.toLowerCase().replace(/\s+/g, '.')}@demo.r3.test`;

const people = {
  hr: 'Hana HR',
  ceo: 'Chris CEO',
  engHead: 'Elena Head',
  opsHead: 'Omar Head',
  mgrA: 'Alex Lead',
  mgrB: 'Billie Lead',
};
const employees = [
  ['Sam Junior', 'Engineering', 'Mechanical Engineer', 'Junior', people.mgrA, ['Machine/ System Design', 'Product Development', 'Problem Solving']],
  ['Kim Mid', 'Engineering', 'Software Engineer', 'Mid', people.mgrA, ['System Design & Integration', 'Software & Hardware Development Quality', 'Problem Solving']],
  ['Lee Senior', 'Engineering', 'Robotics & AI Engineer', 'Senior', people.mgrA, ['System Design & Integration', 'Software & Hardware Development Quality', 'Project Management']],
  ['Pat Mid', 'Operations', 'Operations Engineer', 'Mid', people.mgrB, ['Production Planning & Scheduling', 'Process Knowledge', 'Lean/ Continuous Improvement']],
  ['Robin Senior', 'Operations', 'Logistics & Procurement Manager', 'Senior', people.mgrB, ['Procurement', 'Quality, Risk & Compliance', 'Supply Chain Communication & Collaboration']],
  ['Alex Lead', 'Engineering', 'Lead Software Engineer', 'Lead', people.engHead, ['System Design & Integration', 'Project Management', 'Problem Solving']],
  ['Billie Lead', 'Operations', 'Operations Manager', 'Lead', people.opsHead, ['Production Planning & Scheduling', 'Process Knowledge', 'Project Management']],
];

async function main() {
  const name = 'Demo cycle';
  if (await one('SELECT 1 FROM cycles WHERE name = $1', [name])) {
    console.log('Demo data already exists. Delete the "Demo cycle" first to recreate it.');
    return;
  }
  await query(`INSERT INTO users (email, name, global_role) VALUES ($1, $2, 'hr_admin') ON CONFLICT (email) DO NOTHING`, [D(people.hr), people.hr]);
  await query(`INSERT INTO users (email, name, global_role) VALUES ($1, $2, 'viewer_all') ON CONFLICT (email) DO NOTHING`, [D(people.ceo), people.ceo]);
  const hr = await one('SELECT id FROM users WHERE email = $1', [D(people.hr)]);
  const cycle = await one(
    `INSERT INTO cycles (name, deadline, talent_bar, created_by) VALUES ($1, current_date + 30, $2, $3) RETURNING id`,
    [name, JSON.stringify(TALENT_BAR), hr.id],
  );
  const rows = employees.map(([n, dept, pos, sen, rev, skills], i) => ({
    rowNumber: i + 2, employeeName: n, employeeEmail: D(n), department: dept, position: pos, seniority: sen,
    reviewerName: rev, reviewerEmail: D(rev), skill1: skills[0], skill2: skills[1], skill3: skills[2],
  }));
  const skillNames = (await pool.query('SELECT name FROM skills')).rows.map((r) => r.name);
  const v = validateRoster({ employees: rows }, skillNames);
  if (v.errorCount) throw new Error('Demo roster has errors: ' + JSON.stringify(v.rows.flatMap((r) => r.errors)));
  await saveRoster(cycle.id, v, 'demo');
  await initiateCycle(cycle.id);
  console.log(`Demo cycle created with ${rows.length} reviews. Sign in (test mode) as ${D(people.hr)} for HR.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
