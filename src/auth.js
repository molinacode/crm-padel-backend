const { Issuer, generators } = require('openid-client');
const { query } = require('./db');
const {
  getSession,
  requireUser,
  setSessionCookie,
  clearSessionCookie,
  setOidcCookie,
  getOidcCookie,
  getIdToken,
} = require('./session');
const { roleFromClaims } = require('./authz');

let clientPromise = null;

function issuerUrl() {
  return process.env.OIDC_ISSUER;
}

async function getClient() {
  if (!issuerUrl()) {
    throw new Error('Falta OIDC_ISSUER');
  }
  if (!clientPromise) {
    clientPromise = Issuer.discover(issuerUrl())
      .then(
        issuer =>
          new issuer.Client({
            client_id: process.env.OIDC_CLIENT_ID,
            client_secret: process.env.OIDC_CLIENT_SECRET,
            redirect_uris: [process.env.OIDC_REDIRECT_URI],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
          })
      )
      .catch(error => {
        // Sin esto una caída puntual de Zitadel deja el descubrimiento fallido
        // cacheado y ningún login vuelve a funcionar hasta reiniciar.
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}

async function upsertStaff(session) {
  try {
    const result = await query(
      `INSERT INTO staff (zitadel_sub, email, nombre, rol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (zitadel_sub) DO UPDATE SET
         email = EXCLUDED.email,
         nombre = COALESCE(staff.nombre, EXCLUDED.nombre),
         rol = EXCLUDED.rol,
         updated_at = now()
       RETURNING *`,
      [session.sub, session.email || null, session.nombre || null, session.rol]
    );
    return result.rows[0];
  } catch (error) {
    console.warn('[staff] no se pudo guardar (¿falta 001_staff.sql?):', error.message);
    return null;
  }
}

function publicProfile(session, staff) {
  return {
    id: staff?.id || session.sub,
    nombre: staff?.nombre || session.nombre || session.email?.split('@')[0] || 'Usuario',
    email: staff?.email || session.email,
    rol: staff?.rol || session.rol || null,
    foto_url: staff?.foto_url || null,
    telefono: staff?.telefono || null,
    created_at: staff?.created_at || null,
  };
}

function mountAuth(app) {
  app.get('/api/auth/login', async (req, res) => {
    try {
      const client = await getClient();
      const code_verifier = generators.codeVerifier();
      const state = generators.state();
      const nonce = generators.nonce();
      const remember =
        req.query.remember === '1' ||
        req.query.remember === 'true' ||
        req.query.remember === 'yes';
      const project = process.env.ZITADEL_PROJECT_ID;
      const scope = [
        'openid',
        'email',
        'profile',
        project ? `urn:zitadel:iam:org:project:id:${project}:aud` : null,
      ]
        .filter(Boolean)
        .join(' ');
      setOidcCookie(res, { code_verifier, state, nonce, remember });
      const url = client.authorizationUrl({
        scope,
        state,
        nonce,
        code_challenge: generators.codeChallenge(code_verifier),
        code_challenge_method: 'S256',
      });
      res.redirect(url);
    } catch (error) {
      console.error('[auth] login', error);
      res.status(500).send('Error iniciando sesión en Zitadel');
    }
  });

  app.get('/api/auth/callback', async (req, res) => {
    try {
      const pending = getOidcCookie(req);
      if (!pending?.code_verifier || !pending?.state) {
        return res.status(400).send('Sesión OIDC caducada. Vuelve a entrar.');
      }
      const redirectUri = process.env.OIDC_REDIRECT_URI;
      const client = await getClient();
      const current = `${redirectUri.split('?')[0]}?${new URLSearchParams(req.query).toString()}`;
      const params = client.callbackParams(current);
      const tokenSet = await client.callback(redirectUri, params, {
        code_verifier: pending.code_verifier,
        state: pending.state,
        nonce: pending.nonce,
      });
      const claims = tokenSet.claims();
      const rol = roleFromClaims(claims);
      if (!rol) {
        clearSessionCookie(res);
        return res
          .status(403)
          .send('Tu cuenta no tiene rol en el CRM (admin o profesor). Contacta con un administrador.');
      }
      const session = {
        sub: claims.sub,
        email: claims.email || claims.preferred_username,
        nombre: claims.name || claims.given_name || claims.preferred_username,
        rol,
        id_token: tokenSet.id_token,
      };
      await upsertStaff(session);
      setSessionCookie(res, session, { remember: !!pending.remember });
      res.redirect(process.env.PUBLIC_URL || '/');
    } catch (error) {
      console.error('[auth] callback', error);
      res.status(401).send('No se pudo completar el login');
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = getSession(req);
    clearSessionCookie(res);
    const issuer = issuerUrl();
    if (!issuer) return res.json({ redirect: '/' });
    // Zitadel solo respeta post_logout_redirect_uri si puede identificar al
    // cliente: con id_token_hint o, si la sesión ya no lo tiene, con client_id.
    const publicUrl = (process.env.PUBLIC_URL || 'https://app.v3sports.es').replace(/\/$/, '');
    const params = new URLSearchParams({
      post_logout_redirect_uri: `${publicUrl}/`,
      client_id: process.env.OIDC_CLIENT_ID || '',
    });
    const idToken = session?.id_token || getIdToken(req);
    if (idToken) params.set('id_token_hint', idToken);
    res.json({ redirect: `${issuer}/oidc/v1/end_session?${params.toString()}` });
  });

  app.get('/api/auth/me', async (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ user: null });
    let staff = null;
    try {
      const result = await query('SELECT * FROM staff WHERE zitadel_sub = $1', [session.sub]);
      staff = result.rows[0] || null;
    } catch {
      staff = null;
    }
    const profile = publicProfile(session, staff);
    res.json({
      user: { id: profile.id, email: profile.email },
      userData: profile,
    });
  });

  app.patch('/api/auth/profile', requireUser, async (req, res) => {
    const { nombre, telefono } = req.body || {};
    try {
      const result = await query(
        `UPDATE staff SET
           nombre = COALESCE($2, nombre),
           telefono = COALESCE($3, telefono),
           updated_at = now()
         WHERE zitadel_sub = $1
         RETURNING *`,
        [req.user.sub, nombre || null, telefono || null]
      );
      const staff = result.rows[0];
      res.json({ userData: publicProfile(req.user, staff) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { mountAuth, getClient };
