const crypto = require('crypto');

const COOKIE = 'crm_session';
const OIDC_COOKIE = 'crm_oidc';
const ID_TOKEN_COOKIE = 'crm_idt';
/** Sesión normal: 8 h. */
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
/** Con «mantener sesión»: 30 días. */
const MAX_AGE_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET debe tener al menos 16 caracteres');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function open(token) {
  if (!token) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function cookieBase() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

function sessionTtlMs(remember) {
  return remember ? MAX_AGE_REMEMBER_MS : MAX_AGE_MS;
}

function setSessionCookie(res, session, { remember = false } = {}) {
  const maxAge = sessionTtlMs(remember);
  const idToken = session.id_token;
  const payload = {
    ...session,
    iat: Date.now(),
    maxAge,
    remember: !!remember,
  };
  delete payload.id_token;
  res.cookie(COOKIE, seal(payload), {
    ...cookieBase(),
    maxAge,
  });
  if (idToken) {
    res.cookie(ID_TOKEN_COOKIE, seal({ id_token: idToken, iat: Date.now(), maxAge }), {
      ...cookieBase(),
      maxAge,
    });
  }
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, cookieBase());
  res.clearCookie(OIDC_COOKIE, cookieBase());
  res.clearCookie(ID_TOKEN_COOKIE, cookieBase());
}

function getIdToken(req) {
  return open(req.cookies?.[ID_TOKEN_COOKIE])?.id_token || null;
}

function setOidcCookie(res, payload) {
  res.cookie(OIDC_COOKIE, seal(payload), {
    ...cookieBase(),
    maxAge: 10 * 60 * 1000,
  });
}

function getOidcCookie(req) {
  return open(req.cookies?.[OIDC_COOKIE]);
}

function getSession(req) {
  const data = open(req.cookies?.[COOKIE]);
  if (!data || !data.sub) return null;
  const maxAge = typeof data.maxAge === 'number' ? data.maxAge : MAX_AGE_MS;
  if (data.iat && Date.now() - data.iat > maxAge) return null;
  return data;
}

function requireUser(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  req.user = session;
  return next();
}

/**
 * Relee staff.rol en BD para no confiar solo en la cookie (democión / cambio de rol).
 * Usar en rutas sensibles tras requireUser.
 */
async function requireFreshRole(req, res, next) {
  try {
    const { query } = require('./db');
    const result = await query(
      `SELECT rol FROM staff WHERE zitadel_sub = $1 LIMIT 1`,
      [req.user.sub]
    );
    const staff = result.rows[0];
    const rol = staff?.rol;
    if (!rol || (rol !== 'admin' && rol !== 'profesor')) {
      return res.status(403).json({ error: 'Sin rol válido en el CRM' });
    }
    if (rol !== req.user.rol) {
      req.user.rol = rol;
      setSessionCookie(
        res,
        {
          sub: req.user.sub,
          email: req.user.email,
          nombre: req.user.nombre,
          rol,
        },
        { remember: !!req.user.remember }
      );
    }
    return next();
  } catch (error) {
    console.error('[auth] requireFreshRole:', error.message);
    return res.status(503).json({ error: 'No se pudo verificar el rol' });
  }
}

module.exports = {
  COOKIE,
  MAX_AGE_MS,
  MAX_AGE_REMEMBER_MS,
  getSession,
  requireUser,
  requireFreshRole,
  setSessionCookie,
  clearSessionCookie,
  setOidcCookie,
  getOidcCookie,
  getIdToken,
};
