const crypto = require('crypto');
const { query } = require('./db');
const { requireAdmin } = require('./authz');

const PROJECT_ID = process.env.ZITADEL_PROJECT_ID || '391915717441618690';

async function zitadel(method, path, body) {
  const token = process.env.ZITADEL_PAT;
  if (!token) {
    const error = new Error('Falta ZITADEL_PAT en el servidor');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${process.env.OIDC_ISSUER || 'https://auth.v3sports.es'}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const error = new Error(data.message || `Zitadel respondió ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function listarProfesoresZitadel() {
  const data = await zitadel('POST', '/management/v1/users/grants/_search', {
    queries: [
      { projectIdQuery: { projectId: PROJECT_ID } },
      { roleKeyQuery: { roleKey: 'profesor' } },
    ],
  });
  return (data.result || [])
    .filter(row => row.state !== 'USER_GRANT_STATE_REMOVED')
    .map(row => ({
      userId: row.userId,
      email: String(row.email || row.userName || '').trim(),
      nombre: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.displayName || '',
    }))
    .filter(row => row.email);
}

function mountProfesoresAuth(app) {
  app.get('/api/profesores/conciliacion', requireAdmin, async (_req, res) => {
    try {
      const [zitadelUsers, crm] = await Promise.all([
        listarProfesoresZitadel(),
        query('SELECT id, nombre, apellidos, email FROM profesores ORDER BY nombre'),
      ]);
      const crmRows = crm.rows.map(row => ({
        id: row.id,
        email: String(row.email || '').trim(),
        nombre: [row.nombre, row.apellidos].filter(Boolean).join(' '),
      }));
      const emailsZitadel = new Set(zitadelUsers.map(row => row.email.toLowerCase()));
      const emailsCrm = new Set(crmRows.filter(row => row.email).map(row => row.email.toLowerCase()));
      res.json({
        soloZitadel: zitadelUsers.filter(row => !emailsCrm.has(row.email.toLowerCase())),
        soloCrm: crmRows.filter(row => row.email && !emailsZitadel.has(row.email.toLowerCase())),
        sinEmail: crmRows.filter(row => !row.email),
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/profesores/alta', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const nombre = String(body.nombre || '').trim();
    const apellidos = String(body.apellidos || '').trim();
    if (!email || !nombre) {
      return res.status(400).json({ error: 'Nombre y email son obligatorios' });
    }
    const password = `V3${crypto.randomBytes(6).toString('base64url')}a!`;
    try {
      const created = await zitadel('POST', '/management/v1/users/human', {
        userName: email,
        profile: { firstName: nombre, lastName: apellidos || nombre },
        email: { email, isEmailVerified: true },
        initialPassword: password,
      });
      const userId = created.userId;
      await zitadel('POST', `/management/v1/users/${userId}/grants`, {
        projectId: PROJECT_ID,
        roleKeys: ['profesor'],
      });
      let inserted;
      try {
        inserted = await query(
          `INSERT INTO profesores
             (nombre, apellidos, email, telefono, especialidad, nivel_experiencia, activo, fecha_nacimiento, direccion, observaciones)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            nombre,
            apellidos || '',
            email,
            body.telefono || null,
            body.especialidad || 'Pádel',
            body.nivel_experiencia || 'Intermedio',
            body.activo !== false,
            body.fecha_nacimiento || null,
            body.direccion || null,
            body.observaciones || null,
          ]
        );
      } catch (dbError) {
        // Compensacion best-effort: no dejar usuario huerfano en Zitadel.
        try {
          await zitadel('DELETE', `/management/v1/users/${userId}`);
        } catch (cleanupError) {
          console.error('[profesores] cleanup Zitadel fallo', cleanupError.message);
        }
        throw dbError;
      }
      res.json({ id: inserted.rows[0].id, passwordTemporal: password });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountProfesoresAuth };
