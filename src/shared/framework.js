// The R3 performance framework, taken from the Notion page
// "Scorecard Help Sheet for Leads" (Performance management).
// This file is shared by the server and the browser, so keep it free of Node-only imports.

export const LEVELS = [
  { value: 1, key: 'POOR', label: 'Poor' },
  { value: 2, key: 'BASIC', label: 'Basic' },
  { value: 3, key: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 4, key: 'ADVANCED', label: 'Advanced' },
  { value: 5, key: 'EXCEPTIONAL', label: 'Exceptional' },
];

export const LEVEL_KEYS = LEVELS.map((l) => l.key);

export function levelLabel(value) {
  const level = LEVELS.find((l) => l.value === Number(value));
  return level ? level.label : '';
}

export const SENIORITIES = ['Junior', 'Mid', 'Senior', 'Lead', 'Head', 'VP'];

export const CATEGORIES = [
  { key: 'culture', label: 'Culture' },
  { key: 'deliverables', label: 'Deliverables' },
  { key: 'skills', label: 'Skills' },
];

// Order matches the review Excel (H1 2026).
export const DIMENSIONS = [
  { key: 'radical_transparency', category: 'culture', label: 'Radical Transparency' },
  { key: 'impact', category: 'culture', label: 'Impact' },
  { key: 'ownership', category: 'culture', label: "Everyone's an owner" },
  { key: 'complexity', category: 'deliverables', label: 'Complexity' },
  { key: 'quality', category: 'deliverables', label: 'Quality' },
  { key: 'speed', category: 'deliverables', label: 'Speed' },
  { key: 'skill1', category: 'skills', label: 'Skill 1' },
  { key: 'skill2', category: 'skills', label: 'Skill 2' },
  { key: 'skill3', category: 'skills', label: 'Skill 3' },
];

export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key);

// Talent Bar from the Notion help sheet (decided: Notion wins over the Excel).
// Values are levels 1-5. Complexity, Quality and Speed all use the Deliverables column.
const B = 2, I = 3, A = 4, E = 5;
const NOTION_BAR = {
  //          impact owner  RT  deliv  s1  s2  s3
  Junior: [B, B, B, B, B, B, B],
  Mid: [I, B, B, B, I, I, I],
  Senior: [I, I, I, I, A, I, I],
  Lead: [A, I, I, A, A, A, I],
  Head: [A, A, A, E, E, A, A],
  VP: [E, E, E, E, E, E, E],
};

function barFromColumns(cols) {
  const out = {};
  for (const [seniority, [impact, owner, rt, deliv, s1, s2, s3]] of Object.entries(cols)) {
    out[seniority] = {
      radical_transparency: rt,
      impact,
      ownership: owner,
      complexity: deliv,
      quality: deliv,
      speed: deliv,
      skill1: s1,
      skill2: s2,
      skill3: s3,
    };
  }
  return out;
}

export const TALENT_BAR = barFromColumns(NOTION_BAR);

// Behaviour statements per level for culture values and deliverables.
// Radical Transparency's extra "Expert" level from Notion is not used (the scale is 1-5).
export const STATEMENTS = {
  radical_transparency: {
    POOR: [
      'Visibly defensive or dismissive when receiving factual and constructive feedback',
      'Blames others or tries to cover themselves',
      'Regularly withholds critical information from team members',
      'Fails to acknowledge mistakes',
    ],
    BASIC: [
      'Raises issues or concerns in a professional manner',
      'Responds to feedback with openness and willingness to learn',
      'Openly acknowledges mistakes and takes responsibility for fixing them',
    ],
    INTERMEDIATE: [
      'Communicates clearly and efficiently on the status of deliverables and next steps of action.',
      'Is Master of their own agenda and actively flags when own priorities and work changes',
      'Regularly seeks, provides and acts on feedback',
    ],
    ADVANCED: [
      "Delivers difficult feedback in a professional way that measurably improves teams performance",
      'Directly addresses complex issues that others avoid discussing',
      'Honors all commitments and promises made both formally and informally',
    ],
    EXCEPTIONAL: [
      "Act as a role model via one's transparent behaviour, communication, and mentoring",
    ],
  },
  impact: {
    POOR: [
      'Does not respect deadlines',
      'Delivers poor quality deliverables or requires extensive support to get things done',
      'Shys away from taking decisions',
      'Does not use AI to speed tasks up',
    ],
    BASIC: [
      'Independently delivers expected results within established timelines',
      'Constantly looks for opportunities to improve and lean more',
      'Proves an understanding of 80/20 approach',
      'Uses AI consistently to drive tasks forward',
    ],
    INTERMEDIATE: [
      'Demonstrates clear bias for action and push others to adopt the same behavior',
      'Ties deliverables back to North Star and company goals and prioritizes which tasks are important',
      'Autonomously develops efficient plans focused on high-value outcomes',
      'Dives deep in complex areas, simplifies them, reasons for best action in a numbers-driven manner',
    ],
    ADVANCED: [
      'Delivers complex deliverables within the timeframe given',
      'Strong with both logical and creative thinking and understands in which situation to use either',
      'Takes ownership of mission-critical OKRs and drives the team to deliver them',
      'Discovers new AI use cases, and drives clear action plan to implement them to accelerate entire company',
    ],
    EXCEPTIONAL: [
      'Overcomes seemingly impossible constraints to deliver critical outcomes',
      'Has the big picture, connects dots across multiple products, teams, departments, industries to drive company impact and speed',
      'Relentlessly pushes themselves and other team members to play to win',
      'Is the go-to source for AI usage in the company',
    ],
  },
  ownership: {
    POOR: [
      'Only considers their own work without any implications for others',
      'Blames others for setbacks',
      "Doesn't share wins with the team",
    ],
    BASIC: [
      "Makes decisions considering company's long-term interests",
      'Takes full ownership for the setting of the goal to the execution of the task',
    ],
    INTERMEDIATE: [
      'Excellent work ethic: works hard and goes the extra mile to deliver outstanding results',
      'Ensures projects reach completion even when facing obstacles',
      'Strives for more responsibility',
    ],
    ADVANCED: [
      'Embraces and is positively challenged by new responsibilities',
      'Rallies team members and peers to embrace their objectives and consistently act in the interests of the company',
      "Takes ownership of complex problems with an exceptional Do'er attitude",
      'Develops systems or processes that drive accountability across the organization',
    ],
    EXCEPTIONAL: [
      'Wants to be the owner of high-risk initiatives with outsized impact and regularly manages to beat the odds',
      'Takes the lead in problem solving: can align and structure the troops to take risks and pushes for decisions',
    ],
  },
  complexity: {
    POOR: ['Delivers standard tasks, done many times before within the organisation'],
    BASIC: ['Delivers standard tasks autonomously and non-standard tasks with limited manager iterations'],
    INTERMEDIATE: ['Delivers non-standard tasks, with few comparisons available within the organisation'],
    ADVANCED: ['Delivers highly complex tasks, with no / rare precedents'],
    EXCEPTIONAL: ['Delivers exceptionally difficult and complex tasks requiring inventions of new methods'],
  },
  quality: {
    POOR: ['Completed work does not meet the company quality standard'],
    BASIC: ['Tasks are delivered to an acceptable standard with minimal iterations required'],
    INTERMEDIATE: ['Tasks are delivered to a high standard, typically require only 1 iteration'],
    ADVANCED: ['Tasks are always delivered to high standard, and require no iterations'],
    EXCEPTIONAL: ['Able to create a vision for the business, translate into actionable plan and build a machine to execute.'],
  },
  speed: {
    POOR: ['Usually delivers tasks late, misses important deadlines'],
    BASIC: ['Usually completes tasks on time, rarely misses deadlines'],
    INTERMEDIATE: ['Always meets deadlines, often beats them'],
    ADVANCED: ['Delivers very fast, habitually beats deadlines'],
    EXCEPTIONAL: ['Self-guided missile - finds important targets, executes with exceptional standard beating deadlines by huge margins'],
  },
};

export const DIMENSION_INTROS = {
  radical_transparency:
    'We practice radical transparency by openly sharing information, earning trust, and encouraging honest communication among our team.',
  impact:
    "We cultivate a culture of action and pragmatism. We embrace bias for action to be sure that we don't just discuss ideas but also execute.",
  ownership:
    'We set ambitious and challenging goals, embrace challenges and take them head-on without deferring to others.',
  complexity: 'What kind of tasks are tackled and how hard it was to figure out an approach to the task.',
  quality: 'Whether the work delivered can be used immediately or requires loops for review.',
  speed: 'Whether deliveries promised to others arrive on time.',
};
