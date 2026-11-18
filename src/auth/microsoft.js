// "Sign in with Microsoft" through Microsoft Entra ID (OpenID Connect).
// Turned on when MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are set.
// Only people from the company's own tenant can sign in, and only if their
// email is already known to the app (from a roster upload or Settings).
import express from 'express';
import { Issuer, generators } from 'openid-client';
import { config } from '../config.js';
import { one } from '../db.js';

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const { tenantId, clientId, clientSecret } = config.microsoft;
    clientPromise = Issuer.discover(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .then((issuer) => new issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [`${config.baseUrl}/auth/microsoft/callback`],
        response_types: ['code'],
      }))
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

export function microsoftRoutes(signIn) {
  const router = express.Router();

  router.get('/auth/microsoft', async (req, res, next) => {
    if (!config.microsoftEnabled) return res.status(404).send('Microsoft sign-in is not configured.');
    try {
      const client = await getClient();
      const state = generators.state();
      const nonce = generators.nonce();
      const codeVerifier = generators.codeVerifier();
      req.session.oidc = { state, nonce, codeVerifier };
      const url = client.authorizationUrl({
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: generators.codeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      req.session.save(() => res.redirect(url));
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/microsoft/callback', async (req, res, next) => {
    if (!config.microsoftEnabled) return res.status(404).send('Microsoft sign-in is not configured.');
    try {
      const saved = req.session.oidc;
      if (!saved) return res.redirect('/login?error=' + encodeURIComponent('Sign-in expired, please try again.'));
      delete req.session.oidc;
      const client = await getClient();
      const params = client.callbackParams(req);
      const tokens = await client.callback(`${config.baseUrl}/auth/microsoft/callback`, params, {
        state: saved.state,
        nonce: saved.nonce,
        code_verifier: saved.codeVerifier,
      });
      const claims = tokens.claims();
      const fail = (msg) => res.redirect('/login?error=' + encodeURIComponent(msg));
      if (String(claims.tid || '').toLowerCase() !== config.microsoft.tenantId || !claims.oid) {
        return fail('Please use your R3 Microsoft account.');
      }
      // Guests in the tenant have a #EXT# user name; they are not employees.
      if (String(claims.preferred_username || '').toUpperCase().includes('#EXT#')) {
        return fail('Guest accounts cannot sign in. Please use your R3 Microsoft account.');
      }
      const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
      const domain = email.split('@')[1] || '';
      if (config.microsoft.allowedDomains.length && !config.microsoft.allowedDomains.includes(domain)) {
        return fail('Please use your R3 Microsoft account.');
      }
      // Once linked, the Microsoft account id decides who you are; the email is only used for the first link.
      let user = await one('SELECT id FROM users WHERE ms_oid = $1', [claims.oid]);
      if (!user && email) {
        const byEmail = await one('SELECT id, ms_oid FROM users WHERE email = $1', [email]);
        if (byEmail && byEmail.ms_oid && byEmail.ms_oid !== claims.oid) {
          return fail('This email is linked to a different Microsoft account. Ask HR or the app owner.');
        }
        if (byEmail) {
          await one('UPDATE users SET ms_oid = $2 WHERE id = $1 RETURNING id', [byEmail.id, claims.oid]);
          user = byEmail;
        }
      }
      if (!user) return fail(`${email || 'This account'} isn't part of any review cycle yet. Ask HR to add you.`);
      signIn(req, user, res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
