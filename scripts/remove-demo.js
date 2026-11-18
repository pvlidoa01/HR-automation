// Removes the demo cycle and the fictional @demo.r3.test people created by `npm run demo`.
import { pool, tx } from '../src/db.js';

await tx(async (client) => {
  const c = await client.query("DELETE FROM cycles WHERE name = 'Demo cycle' RETURNING id");
  const u = await client.query(
    `DELETE FROM users WHERE email LIKE '%@demo.r3.test'
       AND id NOT IN (SELECT employee_id FROM reviews UNION SELECT reviewer_id FROM reviews
                      UNION SELECT head_user_id FROM cycle_departments WHERE head_user_id IS NOT NULL
                      UNION SELECT created_by FROM cycles WHERE created_by IS NOT NULL)`,
  );
  await client.query("DELETE FROM skills WHERE source = 'hr' AND id NOT IN (SELECT unnest(array[skill1_id, skill2_id, skill3_id]) FROM reviews WHERE skill1_id IS NOT NULL)");
  console.log(`Removed ${c.rowCount} demo cycle(s) and ${u.rowCount} demo people.`);
});
await pool.end();
