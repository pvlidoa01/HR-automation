# Connecting the app to the Notion Skill Base

The questions for each skill are written in Notion, in the **Skill Base** database
(Strategy → Obsidian - Scorecard Control Tower → Skill Base). HR updates the app's copy with
**HR admin → Cycles → Skill questionnaires → Check Notion for changes**. For that, the app needs
read-only access to the Skill Base. This is done once, by someone who is a Notion workspace owner.

## 1. Create the connection (Notion workspace owner)

1. Go to https://www.notion.so/profile/integrations and choose **New integration**.
2. Name: `R3 Performance Review`. Workspace: R3 Robotics. Type: **Internal**.
3. Capabilities: tick **Read content** only. Untick insert/update content, comments and user
   information.
4. Save, then copy the **Internal Integration Secret** (starts with `ntn_`). Treat it like a password.

## 2. Share the Skill Base with it

1. Open the Skill Base database in Notion.
2. Click **•••** (top right) → **Connections** → add **R3 Performance Review**.

The app can then read the skill pages and nothing else.

## 3. Add the key to the app (Replit)

1. In Replit, open **Secrets** and add `NOTION_TOKEN` with the secret from step 1.
2. Restart the app (Stop, Run).

`NOTION_SKILL_BASE_ID` only needs setting if the Skill Base database is ever moved or replaced; the
default is the current database (`1fbc1d7015dc808ca3a3d9827d848040`).

## How skill pages must look

- **Title**: the skill name. Put `DRAFT ` in front for a skill that is not final yet.
- **Definition**: a callout under a heading called "Definition" (may be empty).
- **Questionnaire**: one table with two columns, **Level** and **Behavior**, one row per
  statement. Levels: POOR, BASIC, INTERMEDIATE, ADVANCED, EXCEPTIONAL. A level can have several
  rows. A row with an empty Level is counted under the level above it.

Pages without statements are shown as problems and never applied. Skills removed from Notion stay
in the app (old reviews use them); they are listed as "Not in Notion".

## When changes take effect

Each cycle keeps the questionnaire it had when HR initiated it, so answers already given never get
mixed up. An update applies to cycles initiated afterwards, including cycles still being set up.
