const { getSession } = require('./session');

function roleFromClaims(claims) {
  const roles = (claims && claims['urn:zitadel:iam:org:project:roles']) || {};
  if (roles.admin || roles['admin']) return 'admin';
  if (roles.profesor || roles['profesor']) return 'profesor';
  return null;
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'No autenticado' });
  if (session.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador' });
  req.user = session;
  return next();
}

/** Tablas/ops permitidas a rol profesor en /api/query. */
const TABLAS_PROFESOR = new Set([
  'clases', 'eventos_clase', 'asistencias', 'ejercicios', 'profesores',
  'alumnos', 'alumnos_clases', 'cursos', 'recuperaciones_clase',
  'tematicas_clase', 'clases_ejercicios',
]);
const ESCRITURA_PROFESOR = new Set([
  'asistencias', 'recuperaciones_clase', 'tematicas_clase', 'clases_ejercicios',
]);

function profesorPuede(table, op) {
  if (!TABLAS_PROFESOR.has(table)) return false;
  if (op === 'select') return true;
  return ESCRITURA_PROFESOR.has(table);
}

module.exports = {
  requireAdmin,
  roleFromClaims,
  TABLAS_PROFESOR,
  ESCRITURA_PROFESOR,
  profesorPuede,
};
