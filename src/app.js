import express from 'express';
import session from 'express-session';
import connectPg from 'connect-pg-simple';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, one } from './db.js';
import { config } from './config.js';
import { loadUser, requireLogin, csrf, authRoutes } from './auth/index.js';
import { homeRoutes } from './routes/home.js';
import { hrRoutes } from './routes/hr.js';
import { reviewRoutes } from './routes/reviews.js';
import { levelLabel, SENIORITIES } from './shared/framework.js';
import { gradeLabel } from './shared/scoring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.set('trust proxy', 1); // Replit runs behind a proxy

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"], // progress-bar widths

        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'", 'https://login.microsoftonline.com'],
      },
    },
  }));
  app.use('/static', express.static(path.join(root, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));
  app.use('/shared', express.static(path.join(here, 'shared'), { maxAge: config.isProduction ? '1h' : 0 }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  const PgStore = connectPg(session);
  app.use(session({
    store: new PgStore({ pool, tableName: 'session' }),
    name: 'r3review.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  }));

  app.use((req, res, next) => {
    res.locals.testMode = config.allowTestLogin;
    res.locals.microsoftEnabled = config.microsoftEnabled;
    res.locals.levelLabel = levelLabel;
    res.locals.gradeLabel = gradeLabel;
    res.locals.SENIORITIES = SENIORITIES;
    res.locals.path = req.path;
    res.locals.fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    res.locals.fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    res.locals.flash = null;
    res.locals.user = null;
    res.locals.csrfToken = '';
    // Show a flash message on the next rendered page only (not on redirects or stray requests).
    const render = res.render.bind(res);
    res.render = (view, options, callback) => {
      res.locals.flash = req.session.flash || null;
      delete req.session.flash;
      return render(view, options, callback);
    };
    next();
  });
  app.use(loadUser());
  app.use(csrf());

  app.get('/health', (req, res) => res.send('ok'));
  app.use(authRoutes());
  app.use(requireLogin);
  app.use(async (req, res, next) => {
    try {
      const id = req.user.id;
      const isHrAdmin = req.user.global_role === 'hr_admin';
      const [team, requests] = await Promise.all([
        one("SELECT 1 FROM reviews r JOIN cycles c ON c.id = r.cycle_id WHERE r.reviewer_id = $1 AND c.status <> 'setup' LIMIT 1", [id]),
        isHrAdmin ? one("SELECT count(*)::int AS n FROM change_requests WHERE status = 'open'") : null,
      ]);
      res.locals.nav = {
        team: !!team,
        requests: requests?.n || 0,
        hr: req.user.global_role === 'hr_admin',
        all: req.user.global_role === 'viewer_all',
      };
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use(homeRoutes());
  app.use('/hr', hrRoutes());
  app.use(reviewRoutes());

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: "This page doesn't exist." }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again. If it keeps happening, tell the app owner.' });
  });
  return app;
}

export function flash(req, type, message) {
  req.session.flash = { type, message };
}
