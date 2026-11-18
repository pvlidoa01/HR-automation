import express from 'express';
import crypto from 'node:crypto';
import { one, many } from '../db.js';
import { config } from '../config.js';
import { microsoftRoutes } from './microsoft.js';

export function loadUser() {
  return async (req, res, next) => {
    try {
      req.user = null;
      if (req.session.userId) {
        req.user = await one('SELECT id, email, name, global_role FROM users WHERE id = $1', [req.session.userId]);
        if (!req.user) delete req.session.userId;
      }
      res.locals.user = req.user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

export function requireHr(req, res, next) {
  if (req.user?.global_role === 'hr_admin') return next();
  return res.status(403).render('error', { title: 'Not allowed', message: 'Only HR can open this page.' });
}

// Simple per-session CSRF token. Every form includes it as a hidden "_csrf" field.
export function csrf() {
  return (req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrf;
    if (req.method !== 'POST') return next();
    // The roster upload is the only multipart form; its token is checked after the upload is parsed.
    const isMultipart = (req.get('content-type') || '').startsWith('multipart/form-data');
    if (isMultipart && /^\/hr\/cycles\/\d+\/roster$/.test(req.path)) return next();
    return verifyCsrf(req, res, next);
  };
}

export function verifyCsrf(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session.csrf;
  if (
    token &&
    expected &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    return next();
  }
  return res.status(403).render('error', { title: 'Expired form', message: 'This form expired. Go back, reload the page and try again.' });
}

function signIn(req, user, res) {
  const returnTo = req.session.returnTo || '/';
  const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  // New session id on sign-in (prevents session fixation).
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Could not sign in, please try again.');
    req.session.userId = user.id;
    req.session.save(() => res.redirect(safeReturn));
  });
}

export function authRoutes() {
  const router = express.Router();

  router.get('/login', async (req, res) => {
    if (req.user) return res.redirect('/');
    const users = config.allowTestLogin
      ? await many('SELECT id, email, name, global_role FROM users ORDER BY global_role NULLS LAST, name')
      : [];
    res.render('login', { title: 'Sign in', users, error: req.query.error || null });
  });

  router.post('/login/test', async (req, res) => {
    if (!config.allowTestLogin) return res.status(404).send('Not found');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await one('SELECT id FROM users WHERE email = $1', [email]);
    if (!user) return res.redirect('/login?error=' + encodeURIComponent('No user with that email.'));
    signIn(req, user, res);
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.use(microsoftRoutes(signIn));
  return router;
}
