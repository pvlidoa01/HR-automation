// The organisation tree of a cycle, built from reporting lines: each review's reviewer is the
// employee's manager. People who manage someone but are not reviewed in the cycle (the heads)
// are the top of the tree.
import { reviewAccess } from './access.js';

/**
 * @param {Array} rows review rows from listReviews (one cycle)
 * @param {{id:number}} user  the viewer
 * @param {{status:string}} cycle
 * @param {{rootUserId?:number}} opts  show only this person's branch
 * @returns {{roots:Array, count:number}}
 */
export function buildTree(rows, user, cycle, opts = {}) {
  const byEmployee = new Map(rows.map((r) => [r.employee_id, r]));
  const nodes = new Map();
  const nodeFor = (userId, name, email) => {
    if (!nodes.has(userId)) nodes.set(userId, { userId, name, email, review: null, children: [] });
    return nodes.get(userId);
  };
  for (const r of rows) {
    const n = nodeFor(r.employee_id, r.employee_name, r.employee_email);
    n.review = r;
    nodeFor(r.reviewer_id, r.reviewer_name, r.reviewer_email);
  }
  for (const r of rows) nodes.get(r.reviewer_id).children.push(nodes.get(r.employee_id));

  for (const n of nodes.values()) {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    if (n.review) {
      // The reviewer's own manager confirms, unless that is the CEO (not part of the steps).
      const up = byEmployee.get(n.review.reviewer_id);
      const confirmerId = up && up.reviewer_role !== 'viewer_all' ? up.reviewer_id : null;
      n.review.confirmerId = confirmerId;
      n.review.confirmerName = confirmerId ? nodes.get(confirmerId)?.name : null;
      n.access = reviewAccess(user, n.review, cycle, { confirmerId });
      n.review.access = n.access;
    }
  }
  const total = (n, seen = new Set()) => {
    if (seen.has(n.userId)) return 0; // guards against a loop in the reporting lines
    seen.add(n.userId);
    return n.children.reduce((s, c) => s + 1 + total(c, seen), 0);
  };
  for (const n of nodes.values()) {
    n.direct = n.children.length;
    n.total = total(n);
  }

  let roots;
  if (opts.rootUserId) {
    const me = nodes.get(opts.rootUserId);
    roots = me ? me.children : [];
  } else {
    roots = [...nodes.values()].filter((n) => !n.review).sort((a, b) => a.name.localeCompare(b.name));
  }
  return { roots, count: rows.length };
}

/** Finds loops in reporting lines (A manages B, B manages A). Returns a list of emails per loop. */
export function findLoops(edges) {
  // edges: Map employeeEmail -> managerEmail
  const loops = [];
  const done = new Set();
  for (const start of edges.keys()) {
    const path = [];
    const onPath = new Set();
    let cur = start;
    while (cur && edges.has(cur) && !done.has(cur)) {
      if (onPath.has(cur)) {
        loops.push(path.slice(path.indexOf(cur)));
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = edges.get(cur);
    }
    for (const p of path) done.add(p);
  }
  return loops;
}
