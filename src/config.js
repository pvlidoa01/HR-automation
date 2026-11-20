// All settings come from environment variables (Replit "Secrets").
const env = process.env;

const isProduction = env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT === '1';

export const config = {
  isProduction,
  port: Number(env.PORT || 3000),
  baseUrl: (env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL,
  // Replit's managed Postgres requires SSL; a local database usually doesn't.
  databaseSsl: env.DATABASE_SSL ? env.DATABASE_SSL === 'true' : /neon\.tech|sslmode=require/.test(env.DATABASE_URL || ''),
  sessionSecret: env.SESSION_SECRET,
  initialHrAdminEmail: (env.INITIAL_HR_ADMIN_EMAIL || '').trim().toLowerCase(),
  initialHrAdminName: env.INITIAL_HR_ADMIN_NAME || 'HR Admin',
  // Test login lets anyone pick a user without a password. Only for building and testing.
  allowTestLogin: env.ALLOW_TEST_LOGIN === 'true',
  microsoft: {
    tenantId: (env.MS_TENANT_ID || '').trim().toLowerCase(),
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    // Optional, e.g. "r3robotics.ai". When set, only these email domains can sign in.
    allowedDomains: (env.MS_ALLOWED_EMAIL_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  },
  // Mailbox the automatic emails are sent from, e.g. performance-review@r3robotics.ai.
  // Needs the Microsoft secrets above plus IT's permission for the app to send from it.
  mailFrom: (env.MAIL_FROM || '').trim().toLowerCase(),
  // "Update skills from Notion": a Notion integration key with read access to the Skill Base.
  notion: {
    token: (env.NOTION_TOKEN || '').trim(),
    skillBaseId: (env.NOTION_SKILL_BASE_ID || '1fbc1d7015dc808ca3a3d9827d848040').replace(/-/g, '').trim(),
  },
};

config.microsoftEnabled = !!(config.microsoft.tenantId && config.microsoft.clientId && config.microsoft.clientSecret);

export function checkConfig() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set (add a PostgreSQL database in Replit).');
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set to a random string of at least 32 characters.');
  }
  if (!config.allowTestLogin && !config.microsoftEnabled) {
    problems.push('No way to sign in: set the MS_* secrets for Microsoft sign-in, or ALLOW_TEST_LOGIN=true while testing.');
  }
  if (config.allowTestLogin && config.microsoftEnabled) {
    problems.push('Test login must be off once Microsoft sign-in is set up: set ALLOW_TEST_LOGIN=false.');
  }
  if (config.allowTestLogin && isProduction && process.env.ALLOW_TEST_LOGIN_ON_DEPLOYMENT !== 'true') {
    problems.push(
      'Test login is off on the deployed app by default. For a test deployment with fake data only, also set '
      + 'ALLOW_TEST_LOGIN_ON_DEPLOYMENT=true; otherwise set ALLOW_TEST_LOGIN=false.',
    );
  }
  if (config.microsoftEnabled && !process.env.APP_BASE_URL) {
    problems.push('APP_BASE_URL must be set to the app address (used for the Microsoft sign-in redirect).');
  }
  return problems;
}
