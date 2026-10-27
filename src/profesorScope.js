const { query } = require('./db');

/**
 * Resuelve el alcance de un profesor a partir del email de sesión.
 * Vinculo: staff/session.email → profesores.email → clases.profesor (texto).
 */
async function resolveProfesorScope(email) {
  const mail = String(email || '')
    .trim()
    .toLowerCase();
  if (!mail) {
    return { profesorId: null, nombres: [], claseIds: [], alumnoIds: [] };
  }

  const prof = await query(
    `SELECT id, nombre, apellidos
     FROM profesores
     WHERE lower(trim(email)) = $1
     LIMIT 1`,
    [mail]
  );
  const row = prof.rows[0];
  if (!row) {
    return { profesorId: null, nombres: [], claseIds: [], alumnoIds: [] };
  }

  const completo = [row.nombre, row.apellidos].filter(Boolean).join(' ').trim();
  const nombres = [...new Set([row.nombre, completo].filter(Boolean))];

  const clases = await query(
    `SELECT id FROM clases WHERE profesor = ANY($1::text[])`,
    [nombres]
  );
  const claseIds = clases.rows.map(r => r.id);

  let alumnoIds = [];
  if (claseIds.length) {
    const alumnos = await query(
      `SELECT DISTINCT alumno_id AS id
       FROM alumnos_clases
       WHERE clase_id = ANY($1::uuid[])`,
      [claseIds]
    );
    alumnoIds = alumnos.rows.map(r => r.id);
  }

  return {
    profesorId: row.id,
    nombres,
    claseIds,
    alumnoIds,
  };
}

function forceIn(filters, column, values) {
  filters.push({ type: 'in', column, value: values });
}

function forceEq(filters, column, value) {
  filters.push({ type: 'eq', column, value });
}

/**
 * Inyecta filtros de fila para /api/query. Las restricciones se AND-ean
 * con las del cliente (solo pueden estrechar, no ampliar).
 */
function scopePlanForProfesor(plan, scope) {
  const table = plan?.table;
  const op = plan?.op || 'select';
  const next = {
    ...plan,
    filters: Array.isArray(plan.filters) ? [...plan.filters] : [],
  };

  switch (table) {
    case 'profesores':
      if (scope.profesorId) forceEq(next.filters, 'id', scope.profesorId);
      else next.filters.push({ type: 'in', column: 'id', value: [] });
      break;
    case 'clases':
      forceIn(next.filters, 'id', scope.claseIds);
      break;
    case 'eventos_clase':
    case 'alumnos_clases':
    case 'asistencias':
    case 'recuperaciones_clase':
    case 'tematicas_clase':
    case 'clases_ejercicios':
      forceIn(next.filters, 'clase_id', scope.claseIds);
      break;
    case 'alumnos':
      forceIn(next.filters, 'id', scope.alumnoIds);
      break;
    case 'ejercicios':
      // Catálogo de referencia compartido (solo select vía authz).
      break;
    case 'cursos':
      // Solo el curso abierto: evita filtrar histórico de cursos cerrados.
      forceEq(next.filters, 'estado', 'abierto');
      break;
    default:
      break;
  }

  if (op === 'insert' || op === 'upsert') {
    assertInsertInScope(table, plan.data, scope);
  }

  return next;
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

function assertInsertInScope(table, data, scope) {
  const rows = rowsOf(data);
  const claseSet = new Set(scope.claseIds.map(String));
  const alumnoSet = new Set(scope.alumnoIds.map(String));

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (
      table === 'asistencias' ||
      table === 'recuperaciones_clase' ||
      table === 'tematicas_clase' ||
      table === 'clases_ejercicios' ||
      table === 'alumnos_clases' ||
      table === 'eventos_clase'
    ) {
      if (!claseSet.has(String(row.clase_id || ''))) {
        const err = new Error('No puedes escribir en una clase que no es tuya');
        err.status = 403;
        throw err;
      }
    }
    if (table === 'asistencias' || table === 'recuperaciones_clase') {
      if (row.alumno_id && !alumnoSet.has(String(row.alumno_id))) {
        const err = new Error('No puedes escribir asistencia de un alumno fuera de tu alcance');
        err.status = 403;
        throw err;
      }
    }
  }
}

module.exports = {
  resolveProfesorScope,
  scopePlanForProfesor,
};
