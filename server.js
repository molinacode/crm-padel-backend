require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { runQuery } = require('./src/query');
const { requireUser, requireFreshRole } = require('./src/session');
const { mountAuth } = require('./src/auth');
const { mountProfesoresAuth } = require('./src/profesoresAuth');
const { mountStorage } = require('./src/storage');
const { mountDomainGrupos } = require('./src/domainGrupos');
const { mountDomainCursos } = require('./src/domainCursos');
const { mountDomainImportacion } = require('./src/domainImportacion');
const { mountDomainFamilia } = require('./src/domainFamilia');
const { mountDomainEventos } = require('./src/domainEventos');
const { mountDomainInstalaciones } = require('./src/domainInstalaciones');
const { mountDomainDeudas } = require('./src/domainDeudas');
const { mountDomainClases } = require('./src/domainClases');
const { mountDomainPagos } = require('./src/domainPagos');
const { mountDomainAsistencias } = require('./src/domainAsistencias');
const { mountDomainDashboard } = require('./src/domainDashboard');
const { profesorPuede } = require('./src/authz');
const { resolveProfesorScope, scopePlanForProfesor } = require('./src/profesorScope');
const { query } = require('./src/db');

const app = express();
const port = Number(process.env.PORT || 3001);
app.set('trust proxy', 1);
app.disable('x-powered-by');

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
].join('; ');

app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  res.setHeader('Content-Security-Policy', process.env.CSP || CSP);
  // Página / API de horarios familiares: token en URL → no caché, no referrer, no index.
  if (
    req.path.startsWith('/h/') ||
    req.path.startsWith('/p/') ||
    req.path.startsWith('/api/familia')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Pragma', 'no-cache');
  } else {
    res.setHeader('Referrer-Policy', 'same-origin');
  }
  next();
});

// Limitador en memoria: un solo contenedor, no hace falta estado compartido.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
    } else if (++entry.count > max) {
      return res.status(429).json({ error: 'Demasiadas peticiones, prueba en un minuto' });
    }
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    return next();
  };
}

const origins = (
  process.env.CORS_ORIGINS ||
  [
    'http://localhost:5175',
    'http://localhost:5173',
    'http://localhost:4321',
    'https://v3sports.es',
    'https://www.v3sports.es',
    'https://preview.v3sports.es',
    'https://app.v3sports.es',
  ].join(',')
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type'],
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, service: 'crm-padel', db: 'ok' });
  } catch (error) {
    res.status(503).json({ ok: false, service: 'crm-padel', db: error.message });
  }
});

app.use('/api/auth/login', rateLimit({ windowMs: 60_000, max: 20 }));
// Público con token en URL: límite más bajo por IP (vista previa WA + abuso).
app.use('/api/familia', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/public/eventos', rateLimit({ windowMs: 60_000, max: 60 }));
app.use('/api/public/carteles', rateLimit({ windowMs: 60_000, max: 120 }));
mountAuth(app);
mountProfesoresAuth(app);
mountDomainGrupos(app);
mountDomainCursos(app);
mountDomainImportacion(app);
mountDomainFamilia(app);
mountDomainEventos(app);
mountDomainInstalaciones(app);
mountDomainDeudas(app);
mountDomainClases(app);
mountDomainPagos(app);
mountDomainAsistencias(app);
mountDomainDashboard(app);
mountStorage(app);

app.post(
  '/api/query',
  rateLimit({ windowMs: 60_000, max: 600 }),
  requireUser,
  requireFreshRole,
  async (req, res) => {
  try {
    let plan = req.body || {};
    if (req.user.rol === 'profesor') {
      const table = plan.table;
      const op = plan.op;
      if (!profesorPuede(table, op)) {
        return res.status(403).json({
          data: null,
          error: { message: 'Esta consulta no está permitida para un profesor' },
        });
      }
      const scope = await resolveProfesorScope(req.user.email);
      plan = scopePlanForProfesor(plan, scope);
    }
    const result = await runQuery(plan);
    res.json(result);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      scope: 'query',
      requestId: req.requestId,
      message: error.message,
    }));
    const status = error.status === 403 ? 403 : 400;
    res.status(status).json({
      data: null,
      error: { message: error.message || 'Error de consulta' },
    });
  }
});

const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const assetsDir = path.join(publicDir, 'assets');
// Chunks con hash: caché larga. Si el hash no existe → 404 texto (no index.html).
app.use(
  '/assets',
  express.static(assetsDir, {
    maxAge: '365d',
    immutable: true,
  })
);
app.use('/assets', (_req, res) => {
  res.status(404).type('text/plain').send('Asset no encontrado. Recarga la página.');
});
app.use(express.static(publicDir, { index: false }));
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  const index = path.join(publicDir, 'index.html');
  // sendFile pisa Cache-Control si cacheControl queda en true (default → max-age=0).
  res.sendFile(
    index,
    {
      cacheControl: false,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
    err => {
      if (err) next();
    }
  );
});

app.listen(port, () => {
  console.log(`CRM pádel API en http://localhost:${port}`);
});
