-- 26 Nov 2026: the H1 2026 Excel is the source of truth for the Talent Bar (Daria). The first
-- cultural value, held one level higher for Mid and Lead, is Radical Transparency, not Impact.
-- Corrects cycles not released yet that still have the Notion version; released cycles keep theirs.
UPDATE cycles
   SET talent_bar = jsonb_set(jsonb_set(jsonb_set(jsonb_set(talent_bar,
         '{Mid,radical_transparency}', '3'), '{Mid,impact}', '2'),
         '{Lead,radical_transparency}', '4'), '{Lead,impact}', '3')
 WHERE status IN ('setup', 'open')
   AND talent_bar #>> '{Mid,impact}' = '3' AND talent_bar #>> '{Mid,radical_transparency}' = '2'
   AND talent_bar #>> '{Lead,impact}' = '4' AND talent_bar #>> '{Lead,radical_transparency}' = '3';
