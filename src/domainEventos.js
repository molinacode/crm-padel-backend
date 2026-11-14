const fs = require('fs');
const crypto = require('crypto');
const { query, withClient } = require('./db');
const { requireAdmin, requireStaff } = require('./authz');
const { requireUser } = require('./session');
const { normalizarTelefonoE164 } = require('./telefono');
const { cartelPublicUrl, uploadCartel, resolveCartel } = require('./storage');

const ESTADOS_INSCRIPCION = new Set([
  'nuevo',
  'revisado',
  'confirmado',
  'pagado',
  'espera',
  'rechazado',
]);

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function parsePrecioCentimos(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function normalizeLinea(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const concepto = String(raw.concepto || '').trim();
  if (!concepto) return null;
  const precio =
    parsePrecioCentimos(raw.precio_centimos) ??
    parsePrecioCentimos(
      raw.precio_euros != null ? Number(raw.precio_euros) * 100 : null
    ) ??
    0;
  const unidadesRaw = Number(raw.unidades);
  const unidades =
    Number.isFinite(unidadesRaw) && unidadesRaw >= 0 ? unidadesRaw : 1;
  return {
    concepto,
    precio_centimos: precio,
    unidades,
    variable: Boolean(raw.variable),
  };
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const escenariosIn =
    src.escenarios && typeof src.escenarios === 'object' ? src.escenarios : {};
  let aforoPct = Number(escenariosIn.aforo_pct);
  if (!Number.isFinite(aforoPct) || aforoPct < 0) aforoPct = 100;
  if (aforoPct > 100) aforoPct = 100;
  const ingresos = Array.isArray(src.ingresos)
    ? src.ingresos.map(normalizeLinea).filter(Boolean)
    : [];
  const gastos = Array.isArray(src.gastos)
    ? src.gastos.map(normalizeLinea).filter(Boolean)
    : [];
  return {
    escenarios: { aforo_pct: aforoPct },
    ingresos,
    gastos,
  };
}

function proyectarConfig(configRaw, aforo) {
  const config = normalizeConfig(configRaw);
  const aforoBase =
    aforo != null && Number.isFinite(Number(aforo)) ? Number(aforo) : 0;
  const factor = (config.escenarios.aforo_pct || 100) / 100;
  const proyectarLineas = lineas =>
    lineas.map(l => {
      const unidadesEfectivas = l.variable
        ? Math.round(l.unidades * aforoBase * factor)
        : l.unidades;
      const total_centimos = Math.round(l.precio_centimos * unidadesEfectivas);
      return { ...l, unidades_efectivas: unidadesEfectivas, total_centimos };
    });
  const ingresos = proyectarLineas(config.ingresos);
  const gastos = proyectarLineas(config.gastos);
  const totalIngresos = ingresos.reduce((s, l) => s + l.total_centimos, 0);
  const totalGastos = gastos.reduce((s, l) => s + l.total_centimos, 0);
  return {
    aforo_base: aforoBase,
    aforo_pct: config.escenarios.aforo_pct,
    ingresos,
    gastos,
    total_ingresos_centimos: totalIngresos,
    total_gastos_centimos: totalGastos,
    resultado_centimos: totalIngresos - totalGastos,
  };
}

function publicEdicion(row) {
  const cartel_path = row.cartel_path || null;
  return {
    id: row.id,
    nombre: row.nombre,
    temporada: row.temporada,
    fecha_inicio: row.fecha_inicio,
    fecha_fin: row.fecha_fin,
    inscripcion_abierta: row.inscripcion_abierta,
    aforo: row.aforo,
    precio_centimos: row.precio_centimos,
    cartel_path,
    cartel_url: cartel_path ? cartelPublicUrl(cartel_path) : null,
    tipo: {
      id: row.tipo_id,
      slug: row.tipo_slug,
      nombre: row.tipo_nombre,
      subtitle: row.tipo_subtitle,
      theme: row.tipo_theme,
      color: row.tipo_color,
      accent: row.tipo_accent,
      form_schema: row.form_schema,
      marketing: row.marketing,
    },
  };
}

async function listTipos() {
  const { rows } = await query(
    `SELECT id, slug, nombre, subtitle, theme, color, accent, form_schema, marketing, orden, activo
     FROM evento_tipos
     WHERE activo = true
     ORDER BY orden, nombre`
  );
  return rows;
}

async function listEdicionesAdmin() {
  const { rows } = await query(
    `SELECT e.*,
            t.slug AS tipo_slug,
            t.nombre AS tipo_nombre,
            t.subtitle AS tipo_subtitle,
            t.theme AS tipo_theme,
            t.color AS tipo_color,
            t.accent AS tipo_accent,
            (SELECT count(*)::int FROM evento_inscripciones i
              WHERE i.edicion_id = e.id AND i.estado NOT IN ('rechazado','espera')) AS inscritos,
            (SELECT count(*)::int FROM evento_inscripciones i
              WHERE i.edicion_id = e.id AND i.estado = 'espera') AS en_espera,
            (SELECT count(*)::int FROM evento_inscripciones i
              WHERE i.edicion_id = e.id AND i.importe_pagado_centimos IS NOT NULL) AS pagados,
            (SELECT coalesce(sum(i.importe_pagado_centimos),0)::int FROM evento_inscripciones i
              WHERE i.edicion_id = e.id) AS cobrado_centimos,
            (SELECT count(*)::int FROM evento_inscripciones i
              WHERE i.edicion_id = e.id AND i.estado = 'nuevo') AS inscritos_nuevos
     FROM evento_ediciones e
     JOIN evento_tipos t ON t.id = e.tipo_id
     ORDER BY e.fecha_inicio DESC NULLS LAST, e.created_at DESC`
  );
  return rows;
}

async function getEdicionJoin(edicionId) {
  const { rows } = await query(
    `SELECT e.*,
            t.id AS tipo_id,
            t.slug AS tipo_slug,
            t.nombre AS tipo_nombre,
            t.subtitle AS tipo_subtitle,
            t.theme AS tipo_theme,
            t.color AS tipo_color,
            t.accent AS tipo_accent,
            t.form_schema,
            t.marketing
     FROM evento_ediciones e
     JOIN evento_tipos t ON t.id = e.tipo_id
     WHERE e.id = $1`,
    [edicionId]
  );
  return rows[0] || null;
}

function parseHora(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 8);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

function horaToMinutes(raw) {
  const parsed = parseHora(raw);
  if (!parsed) return null;
  const [h, m] = parsed.split(':').map(Number);
  return h * 60 + m;
}

function franjasSolapan(aInicio, aFin, bInicio, bFin) {
  const aHi = horaToMinutes(aInicio);
  const aHf = horaToMinutes(aFin);
  const bHi = horaToMinutes(bInicio);
  const bHf = horaToMinutes(bFin);
  if (aHi == null || aHf == null || bHi == null || bHf == null) return false;
  return aHi < bHf && bHi < aHf;
}

async function conflictosClaseEnFranja(fecha, horaInicio, horaFin, excludeReservaId) {
  const { rows } = await query(
    `SELECT ec.id, ec.fecha, ec.hora_inicio, ec.hora_fin, ec.estado,
            c.id AS clase_id, c.nombre AS clase_nombre, c.profesor, c.tipo_clase
     FROM eventos_clase ec
     LEFT JOIN clases c ON c.id = ec.clase_id
     WHERE ec.fecha = $1
       AND ec.hora_inicio IS NOT NULL
       AND ec.hora_fin IS NOT NULL
       AND lower(coalesce(ec.estado, '')) NOT IN
           ('cancelada','cancelado','eliminada','eliminado','anulada','anulado')`,
    [fecha]
  );
  return rows.filter(ev =>
    franjasSolapan(horaInicio, horaFin, ev.hora_inicio, ev.hora_fin)
  );
}

async function conflictosReservaEnFranja(
  fecha,
  horaInicio,
  horaFin,
  instalacionId,
  excludeReservaId
) {
  const params = [fecha];
  let sql = `
    SELECT r.id, r.fecha, r.hora_inicio, r.hora_fin, r.pista_nombre,
           r.instalacion_id, r.edicion_id, e.nombre AS edicion_nombre
    FROM evento_reservas r
    JOIN evento_ediciones e ON e.id = r.edicion_id
    WHERE r.fecha = $1
      AND r.estado = 'reservada'`;
  if (excludeReservaId) {
    params.push(excludeReservaId);
    sql += ` AND r.id <> $${params.length}`;
  }
  if (instalacionId != null) {
    params.push(instalacionId);
    sql += ` AND r.instalacion_id = $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows.filter(r =>
    franjasSolapan(horaInicio, horaFin, r.hora_inicio, r.hora_fin)
  );
}

async function resolverPistaNombre(instalacionId, pistaNombre) {
  if (pistaNombre && String(pistaNombre).trim()) return String(pistaNombre).trim();
  if (instalacionId == null) return null;
  const { rows } = await query(
    `SELECT nombre FROM instalaciones WHERE id = $1`,
    [instalacionId]
  );
  return rows[0]?.nombre || null;
}

/** Registra un hecho del evento. Nunca rompe la operación principal. */
async function registrarBitacora(db, edicionId, tipo, descripcion, datos, req) {
  try {
    const run = db ? db.query.bind(db) : query;
    await run(
      `INSERT INTO evento_bitacora
         (edicion_id, tipo, descripcion, datos, actor_email, actor_rol)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        edicionId,
        tipo,
        descripcion,
        JSON.stringify(datos || {}),
        req?.user?.email || null,
        req?.user?.rol || (req ? 'publico' : null),
      ]
    );
  } catch (error) {
    console.error('[eventos] bitacora', error.message);
  }
}

async function alumnoIdPorTelefono(db, telefonoE164) {
  if (!telefonoE164) return null;
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT id FROM alumnos WHERE telefono_e164 = $1 LIMIT 1`,
    [telefonoE164]
  );
  return rows[0]?.id || null;
}

/**
 * Inserta una inscripción dentro de una TX abierta. Si el aforo está completo,
 * entra en lista de espera (salvo forzar). Enlaza alumno_id por teléfono.
 */
async function insertarInscripcion(
  client,
  edicionId,
  { nombre, apellidos, telefono, nivel, payload, estado },
  { forzar = false, requireAbierta = false } = {}
) {
  const lock = await client.query(
    `SELECT id, aforo, inscripcion_abierta
     FROM evento_ediciones WHERE id = $1 FOR UPDATE`,
    [edicionId]
  );
  const ed = lock.rows[0];
  if (!ed) {
    const err = new Error('Evento no encontrado');
    err.status = 404;
    throw err;
  }
  if (requireAbierta && !ed.inscripcion_abierta) {
    const err = new Error('Inscripción cerrada');
    err.status = 403;
    throw err;
  }
  let estadoFinal = estado || 'nuevo';
  let listaEspera = false;
  if (ed.aforo != null && !forzar && estadoFinal !== 'rechazado') {
    const count = await client.query(
      `SELECT count(*)::int AS n FROM evento_inscripciones
       WHERE edicion_id = $1 AND estado NOT IN ('rechazado','espera')`,
      [edicionId]
    );
    if (count.rows[0].n >= ed.aforo) {
      estadoFinal = 'espera';
      listaEspera = true;
    }
  }
  const alumnoId = await alumnoIdPorTelefono(client, telefono);
  const inserted = await client.query(
    `INSERT INTO evento_inscripciones
       (edicion_id, nombre, apellidos, telefono_e164, nivel, payload, estado, alumno_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      edicionId,
      nombre,
      apellidos,
      telefono,
      nivel || null,
      JSON.stringify(payload || {}),
      estadoFinal,
      alumnoId,
    ]
  );
  return { row: inserted.rows[0], listaEspera };
}

function formatEuros(centimos) {
  if (centimos == null) return '—';
  return `${(centimos / 100).toFixed(2).replace('.', ',')} €`;
}

function nuevoToken() {
  return crypto.randomBytes(8).toString('hex');
}

function ganadorDeResultado(m) {
  if (m.ganador) return m.ganador;
  if (m.sets_a > m.sets_b) return 'a';
  if (m.sets_b > m.sets_a) return 'b';
  return 'empate';
}

async function computarClasificacion(edicionId) {
  const [insc, res] = await Promise.all([
    query(
      `SELECT id, nombre, apellidos, nivel
       FROM evento_inscripciones
       WHERE edicion_id = $1 AND estado <> 'rechazado'`,
      [edicionId]
    ),
    query(`SELECT * FROM evento_resultados WHERE edicion_id = $1`, [edicionId]),
  ]);
  const tabla = new Map();
  for (const i of insc.rows) {
    tabla.set(i.id, {
      inscripcion_id: i.id,
      nombre: i.nombre,
      apellidos: i.apellidos,
      nivel: i.nivel,
      pj: 0,
      pg: 0,
      pe: 0,
      pp: 0,
      sf: 0,
      sc: 0,
      jf: 0,
      jc: 0,
      puntos: 0,
    });
  }
  for (const m of res.rows) {
    const a = tabla.get(m.inscripcion_a);
    const b = tabla.get(m.inscripcion_b);
    const g = ganadorDeResultado(m);
    if (a) {
      a.pj++;
      a.sf += m.sets_a;
      a.sc += m.sets_b;
      a.jf += m.juegos_a;
      a.jc += m.juegos_b;
    }
    if (b) {
      b.pj++;
      b.sf += m.sets_b;
      b.sc += m.sets_a;
      b.jf += m.juegos_b;
      b.jc += m.juegos_a;
    }
    if (g === 'a') {
      if (a) {
        a.pg++;
        a.puntos += 3;
      }
      if (b) b.pp++;
    } else if (g === 'b') {
      if (b) {
        b.pg++;
        b.puntos += 3;
      }
      if (a) a.pp++;
    } else {
      if (a) {
        a.pe++;
        a.puntos += 1;
      }
      if (b) {
        b.pe++;
        b.puntos += 1;
      }
    }
  }
  const arr = [...tabla.values()];
  arr.sort(
    (x, y) =>
      y.puntos - x.puntos ||
      y.sf - y.sc - (x.sf - x.sc) ||
      y.jf - y.jc - (x.jf - x.jc) ||
      String(x.apellidos).localeCompare(String(y.apellidos))
  );
  return arr.map((r, i) => ({
    ...r,
    pos: i + 1,
    dif_sets: r.sf - r.sc,
    dif_juegos: r.jf - r.jc,
  }));
}

// Rate limit en memoria muy simple para el voto público (anti-abuso básico).
const votoRateMap = new Map();
function votoRateLimited(ip, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const entry = votoRateMap.get(ip);
  if (!entry || now - entry.start > windowMs) {
    votoRateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

function mountDomainEventos(app) {
  // ——— Staff ———
  app.get('/api/eventos/tipos', requireUser, requireStaff, async (_req, res) => {
    try {
      res.json({ data: await listTipos() });
    } catch (error) {
      console.error('[eventos] tipos', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.get('/api/eventos/ediciones', requireUser, requireStaff, async (_req, res) => {
    try {
      res.json({ data: await listEdicionesAdmin() });
    } catch (error) {
      console.error('[eventos] ediciones', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.post('/api/eventos/ediciones', requireUser, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const tipoId = String(body.tipo_id || '');
      const nombre = String(body.nombre || '').trim();
      if (!tipoId || !nombre) {
        return res.status(400).json({ error: 'tipo_id y nombre son obligatorios' });
      }
      const { rows } = await query(
        `INSERT INTO evento_ediciones (
           tipo_id, nombre, temporada, fecha_inicio, fecha_fin,
           publicado, inscripcion_abierta, aforo, precio_centimos, notas
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          tipoId,
          nombre,
          body.temporada || null,
          body.fecha_inicio || null,
          body.fecha_fin || null,
          parseBool(body.publicado, false),
          parseBool(body.inscripcion_abierta, false),
          body.aforo != null && body.aforo !== '' ? Number(body.aforo) : null,
          parsePrecioCentimos(
            body.precio_centimos ??
              (body.precio_euros != null ? Number(body.precio_euros) * 100 : null)
          ),
          body.notas || null,
        ]
      );
      res.status(201).json({ data: rows[0] });
    } catch (error) {
      console.error('[eventos] crear edicion', error);
      res.status(error.code === '23503' ? 400 : 500).json({
        error: error.message || 'Error',
      });
    }
  });

  app.patch('/api/eventos/ediciones/:id', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const body = req.body || {};
      if (!id) return res.status(400).json({ error: 'id obligatorio' });

      const fields = [];
      const params = [];
      const set = (col, value) => {
        params.push(value);
        fields.push(`${col} = $${params.length}`);
      };

      if (body.nombre !== undefined) set('nombre', String(body.nombre).trim());
      if (body.temporada !== undefined) set('temporada', body.temporada || null);
      if (body.fecha_inicio !== undefined) set('fecha_inicio', body.fecha_inicio || null);
      if (body.fecha_fin !== undefined) set('fecha_fin', body.fecha_fin || null);
      if (body.publicado !== undefined) set('publicado', parseBool(body.publicado));
      if (body.inscripcion_abierta !== undefined) {
        set('inscripcion_abierta', parseBool(body.inscripcion_abierta));
      }
      if (body.aforo !== undefined) {
        set('aforo', body.aforo === '' || body.aforo == null ? null : Number(body.aforo));
      }
      if (body.precio_centimos !== undefined || body.precio_euros !== undefined) {
        set(
          'precio_centimos',
          parsePrecioCentimos(
            body.precio_centimos !== undefined
              ? body.precio_centimos
              : Number(body.precio_euros) * 100
          )
        );
      }
      if (body.cartel_path !== undefined) set('cartel_path', body.cartel_path || null);
      if (body.notas !== undefined) set('notas', body.notas || null);

      if (!fields.length) {
        return res.status(400).json({ error: 'Nada que actualizar' });
      }
      fields.push('updated_at = now()');
      params.push(id);
      const { rows } = await query(
        `UPDATE evento_ediciones SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!rows[0]) return res.status(404).json({ error: 'Edición no encontrada' });
      res.json({ data: rows[0] });
    } catch (error) {
      console.error('[eventos] patch edicion', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.get(
    '/api/eventos/ediciones/:id/inscripciones',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT * FROM evento_inscripciones
           WHERE edicion_id = $1
           ORDER BY created_at DESC`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] inscripciones', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/inscripciones',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};

        const edicion = await getEdicionJoin(edicionId);
        if (!edicion) {
          return res.status(404).json({ error: 'Evento no encontrado' });
        }

        const nombre = String(body.nombre || '').trim();
        const apellidos = String(body.apellidos || '').trim();
        const telefono = normalizarTelefonoE164(
          body.telefono || body.telefono_e164
        );
        const nivel = body.nivel != null ? String(body.nivel).trim() : null;

        if (!nombre || !apellidos || !telefono) {
          return res.status(400).json({
            error: 'nombre, apellidos y teléfono válido son obligatorios',
          });
        }

        const estado = ESTADOS_INSCRIPCION.has(String(body.estado || ''))
          ? String(body.estado)
          : 'confirmado';

        const schema = Array.isArray(edicion.form_schema)
          ? edicion.form_schema
          : [];
        const payload = {};
        for (const field of schema) {
          const key = field?.key;
          if (
            !key ||
            key === 'nombre' ||
            key === 'apellidos' ||
            key === 'telefono' ||
            key === 'nivel'
          ) {
            continue;
          }
          if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
            payload[key] = body[key];
          }
        }

        const forzar = parseBool(body.forzar, false);

        const { row, listaEspera } = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const result = await insertarInscripcion(
              client,
              edicionId,
              { nombre, apellidos, telefono, nivel, payload, estado },
              { forzar }
            );
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });

        await registrarBitacora(
          null,
          edicionId,
          'inscripcion',
          `Alta manual: ${nombre} ${apellidos}${listaEspera ? ' (lista de espera)' : ''}`,
          { inscripcion_id: row.id, estado: row.estado },
          req
        );

        res.status(201).json({ data: row, lista_espera: listaEspera });
      } catch (error) {
        console.error('[eventos] admin inscribir', error);
        res
          .status(error.status || 500)
          .json({ error: error.message || 'No se pudo crear la inscripción' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/inscripciones/import',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
        if (!filas.length) return res.status(400).json({ error: 'No hay filas' });
        if (filas.length > 500) {
          return res.status(400).json({ error: 'Máximo 500 filas por importación' });
        }
        const existentes = await query(
          `SELECT lower(nombre) AS n, lower(apellidos) AS a, telefono_e164 AS t
           FROM evento_inscripciones WHERE edicion_id = $1`,
          [edicionId]
        );
        const claves = new Set(
          existentes.rows.map(r => `${r.n}|${r.a}|${r.t}`)
        );
        const resumen = { creados: 0, espera: 0, duplicados: 0, errores: [] };

        for (let i = 0; i < filas.length; i++) {
          const f = filas[i] || {};
          const nombre = String(f.nombre || '').trim();
          const apellidos = String(f.apellidos || '').trim();
          const telefono = normalizarTelefonoE164(f.telefono);
          if (!nombre || !apellidos || !telefono) {
            resumen.errores.push({ fila: i + 1, error: 'Faltan nombre, apellidos o teléfono válido' });
            continue;
          }
          const clave = `${nombre.toLowerCase()}|${apellidos.toLowerCase()}|${telefono}`;
          if (claves.has(clave)) {
            resumen.duplicados++;
            continue;
          }
          try {
            const { listaEspera } = await withClient(async client => {
              await client.query('BEGIN');
              try {
                const r = await insertarInscripcion(client, edicionId, {
                  nombre,
                  apellidos,
                  telefono,
                  nivel: f.nivel ? String(f.nivel).trim() : null,
                  payload: {},
                  estado: 'confirmado',
                });
                await client.query('COMMIT');
                return r;
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              }
            });
            claves.add(clave);
            if (listaEspera) resumen.espera++;
            else resumen.creados++;
          } catch (error) {
            resumen.errores.push({ fila: i + 1, error: error.message });
          }
        }

        await registrarBitacora(
          null,
          edicionId,
          'inscripcion',
          `Importación CSV: ${resumen.creados} altas, ${resumen.espera} en espera, ${resumen.duplicados} duplicados, ${resumen.errores.length} errores`,
          resumen,
          req
        );
        res.json({ data: resumen });
      } catch (error) {
        console.error('[eventos] import inscripciones', error);
        res.status(error.status || 500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.patch(
    '/api/eventos/inscripciones/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const estado = String(req.body?.estado || '');
        if (!ESTADOS_INSCRIPCION.has(estado)) {
          return res.status(400).json({ error: 'estado inválido' });
        }
        const row = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const updated = await client.query(
              `UPDATE evento_inscripciones
               SET estado = $2, updated_at = now()
               WHERE id = $1
               RETURNING *`,
              [id, estado]
            );
            const ins = updated.rows[0];
            if (!ins) {
              const err = new Error('Inscripción no encontrada');
              err.status = 404;
              throw err;
            }
            if (estado === 'pagado') {
              const exists = await client.query(
                `SELECT id FROM evento_movimientos
                 WHERE inscripcion_id = $1 AND origen = 'inscripcion' LIMIT 1`,
                [id]
              );
              if (!exists.rows[0]) {
                const ed = await client.query(
                  `SELECT precio_centimos FROM evento_ediciones WHERE id = $1`,
                  [ins.edicion_id]
                );
                const precio = ed.rows[0]?.precio_centimos;
                if (precio != null && precio > 0) {
                  await client.query(
                    `INSERT INTO evento_movimientos
                       (edicion_id, tipo, concepto, cantidad_centimos, fecha, origen, inscripcion_id, impacto_instalaciones)
                     VALUES ($1,'ingreso',$2,$3,current_date,'inscripcion',$4,true)`,
                    [
                      ins.edicion_id,
                      `Inscripción ${ins.nombre} ${ins.apellidos}`.trim(),
                      precio,
                      ins.id,
                    ]
                  );
                }
              }
              const conImporte = await client.query(
                `UPDATE evento_inscripciones
                 SET importe_pagado_centimos = coalesce(
                       importe_pagado_centimos,
                       (SELECT precio_centimos FROM evento_ediciones WHERE id = $2)),
                     pagado_at = coalesce(pagado_at, now())
                 WHERE id = $1
                 RETURNING *`,
                [id, ins.edicion_id]
              );
              await client.query('COMMIT');
              return conImporte.rows[0];
            }
            await client.query('COMMIT');
            return ins;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
        await registrarBitacora(
          null,
          row.edicion_id,
          'estado',
          `${row.nombre} ${row.apellidos} → ${estado}`,
          { inscripcion_id: row.id, estado },
          req
        );
        res.json({ data: row });
      } catch (error) {
        console.error('[eventos] patch inscripcion', error);
        res.status(error.status || 500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/ediciones/:id/config',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT id, config_pyl, aforo, precio_centimos FROM evento_ediciones WHERE id = $1`,
          [id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Edición no encontrada' });
        res.json({
          data: {
            edicion_id: rows[0].id,
            aforo: rows[0].aforo,
            precio_centimos: rows[0].precio_centimos,
            config: rows[0].config_pyl || {},
            proyeccion: proyectarConfig(rows[0].config_pyl, rows[0].aforo),
          },
        });
      } catch (error) {
        console.error('[eventos] get config', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.put(
    '/api/eventos/ediciones/:id/config',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const config = normalizeConfig(req.body?.config ?? req.body);
        const { rows } = await query(
          `UPDATE evento_ediciones
           SET config_pyl = $2::jsonb, updated_at = now()
           WHERE id = $1
           RETURNING id, config_pyl, aforo, precio_centimos`,
          [id, JSON.stringify(config)]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Edición no encontrada' });
        res.json({
          data: {
            edicion_id: rows[0].id,
            aforo: rows[0].aforo,
            precio_centimos: rows[0].precio_centimos,
            config: rows[0].config_pyl,
            proyeccion: proyectarConfig(rows[0].config_pyl, rows[0].aforo),
          },
        });
      } catch (error) {
        console.error('[eventos] put config', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/ediciones/:id/movimientos',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT * FROM evento_movimientos
           WHERE edicion_id = $1
           ORDER BY fecha DESC, created_at DESC`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] movimientos', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/movimientos',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};
        const tipo = String(body.tipo || '');
        const concepto = String(body.concepto || '').trim();
        const cantidad = parsePrecioCentimos(
          body.cantidad_centimos ??
            (body.cantidad_euros != null ? Number(body.cantidad_euros) * 100 : null)
        );
        const fecha = body.fecha || new Date().toISOString().slice(0, 10);
        if (tipo !== 'ingreso' && tipo !== 'gasto') {
          return res.status(400).json({ error: 'tipo debe ser ingreso o gasto' });
        }
        if (!concepto || cantidad == null) {
          return res.status(400).json({ error: 'concepto y cantidad son obligatorios' });
        }
        const { rows } = await query(
          `INSERT INTO evento_movimientos
             (edicion_id, tipo, concepto, cantidad_centimos, fecha, origen, impacto_instalaciones)
           VALUES ($1,$2,$3,$4,$5,'manual',$6)
           RETURNING *`,
          [
            edicionId,
            tipo,
            concepto,
            cantidad,
            fecha,
            body.impacto_instalaciones === false ? false : true,
          ]
        );
        res.status(201).json({ data: rows[0] });
      } catch (error) {
        console.error('[eventos] crear movimiento', error);
        res.status(error.code === '23503' ? 400 : 500).json({
          error: error.message || 'Error',
        });
      }
    }
  );

  app.delete(
    '/api/eventos/movimientos/:id',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rowCount } = await query(`DELETE FROM evento_movimientos WHERE id = $1`, [
          id,
        ]);
        if (!rowCount) return res.status(404).json({ error: 'Movimiento no encontrado' });
        res.json({ ok: true });
      } catch (error) {
        console.error('[eventos] delete movimiento', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get('/api/eventos/movimientos-instalaciones', requireUser, async (req, res) => {
    try {
      const desde = req.query?.desde ? String(req.query.desde).slice(0, 10) : null;
      const hasta = req.query?.hasta ? String(req.query.hasta).slice(0, 10) : null;
      const params = [];
      let where = 'WHERE m.impacto_instalaciones = true';
      if (desde) {
        params.push(desde);
        where += ` AND m.fecha >= $${params.length}`;
      }
      if (hasta) {
        params.push(hasta);
        where += ` AND m.fecha <= $${params.length}`;
      }
      const { rows } = await query(
        `SELECT m.id, m.tipo, m.concepto, m.cantidad_centimos, m.fecha, m.edicion_id,
                e.nombre AS edicion_nombre, t.nombre AS tipo_nombre
         FROM evento_movimientos m
         JOIN evento_ediciones e ON e.id = m.edicion_id
         JOIN evento_tipos t ON t.id = e.tipo_id
         ${where}
         ORDER BY m.fecha ASC`,
        params
      );
      res.json({ data: rows });
    } catch (error) {
      console.error('[eventos] movimientos instalaciones', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  // ——— Jornadas + reservas pista ———
  app.get('/api/eventos/pistas', requireUser, requireStaff, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, nombre, tipo, capacidad, precio_hora
         FROM instalaciones
         ORDER BY nombre`
      );
      res.json({ data: rows });
    } catch (error) {
      console.error('[eventos] pistas', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.get(
    '/api/eventos/ediciones/:id/jornadas',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT j.*,
                  (SELECT count(*)::int FROM evento_reservas r
                    WHERE r.jornada_id = j.id AND r.estado = 'reservada') AS reservas_count
           FROM evento_jornadas j
           WHERE j.edicion_id = $1
           ORDER BY j.fecha ASC, j.hora_inicio ASC NULLS LAST`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] jornadas', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/jornadas',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};
        const fecha = body.fecha ? String(body.fecha).slice(0, 10) : null;
        if (!fecha) return res.status(400).json({ error: 'fecha obligatoria' });
        const horaInicio = parseHora(body.hora_inicio);
        const horaFin = parseHora(body.hora_fin);
        if (
          (horaInicio && !horaFin) ||
          (!horaInicio && horaFin) ||
          (horaInicio && horaFin && horaToMinutes(horaInicio) >= horaToMinutes(horaFin))
        ) {
          return res.status(400).json({ error: 'hora_inicio/hora_fin inválidas' });
        }
        const { rows } = await query(
          `INSERT INTO evento_jornadas
             (edicion_id, nombre, fecha, hora_inicio, hora_fin, notas)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING *`,
          [
            edicionId,
            body.nombre ? String(body.nombre).trim() : null,
            fecha,
            horaInicio,
            horaFin,
            body.notas || null,
          ]
        );
        res.status(201).json({ data: rows[0] });
      } catch (error) {
        console.error('[eventos] crear jornada', error);
        res.status(error.code === '23503' ? 400 : 500).json({
          error: error.message || 'Error',
        });
      }
    }
  );

  app.delete(
    '/api/eventos/jornadas/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rowCount } = await query(`DELETE FROM evento_jornadas WHERE id = $1`, [
          id,
        ]);
        if (!rowCount) return res.status(404).json({ error: 'Jornada no encontrada' });
        res.json({ ok: true });
      } catch (error) {
        console.error('[eventos] delete jornada', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/ediciones/:id/reservas',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT r.*, i.nombre AS instalacion_nombre
           FROM evento_reservas r
           LEFT JOIN instalaciones i ON i.id = r.instalacion_id
           WHERE r.edicion_id = $1
           ORDER BY r.fecha ASC, r.hora_inicio ASC`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] reservas', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/reservas',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};
        const fecha = body.fecha ? String(body.fecha).slice(0, 10) : null;
        const horaInicio = parseHora(body.hora_inicio);
        const horaFin = parseHora(body.hora_fin);
        const instalacionId =
          body.instalacion_id != null && body.instalacion_id !== ''
            ? Number(body.instalacion_id)
            : null;
        const force = parseBool(body.force, false);
        if (!fecha || !horaInicio || !horaFin) {
          return res.status(400).json({
            error: 'fecha, hora_inicio y hora_fin son obligatorios',
          });
        }
        if (horaToMinutes(horaInicio) >= horaToMinutes(horaFin)) {
          return res.status(400).json({ error: 'hora_fin debe ser posterior a hora_inicio' });
        }

        const pistaNombre = await resolverPistaNombre(instalacionId, body.pista_nombre);
        const [clases, otras] = await Promise.all([
          conflictosClaseEnFranja(fecha, horaInicio, horaFin),
          conflictosReservaEnFranja(fecha, horaInicio, horaFin, instalacionId, null),
        ]);
        if ((clases.length || otras.length) && !force) {
          return res.status(409).json({
            error: 'Conflicto de franja',
            conflictos: {
              clases: clases.map(c => ({
                id: c.id,
                clase: c.clase_nombre,
                profesor: c.profesor,
                hora_inicio: c.hora_inicio,
                hora_fin: c.hora_fin,
              })),
              reservas: otras.map(r => ({
                id: r.id,
                edicion: r.edicion_nombre,
                pista: r.pista_nombre,
                hora_inicio: r.hora_inicio,
                hora_fin: r.hora_fin,
              })),
            },
          });
        }

        const { rows } = await query(
          `INSERT INTO evento_reservas
             (edicion_id, jornada_id, instalacion_id, pista_nombre,
              fecha, hora_inicio, hora_fin, notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [
            edicionId,
            body.jornada_id || null,
            instalacionId,
            pistaNombre,
            fecha,
            horaInicio,
            horaFin,
            body.notas || null,
          ]
        );
        res.status(201).json({
          data: rows[0],
          advertencias: force
            ? { clases: clases.length, reservas: otras.length }
            : undefined,
        });
      } catch (error) {
        console.error('[eventos] crear reserva', error);
        res.status(error.code === '23503' ? 400 : 500).json({
          error: error.message || 'Error',
        });
      }
    }
  );

  app.post(
    '/api/eventos/reservas/check',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const body = req.body || {};
        const fecha = body.fecha ? String(body.fecha).slice(0, 10) : null;
        const horaInicio = parseHora(body.hora_inicio);
        const horaFin = parseHora(body.hora_fin);
        const instalacionId =
          body.instalacion_id != null && body.instalacion_id !== ''
            ? Number(body.instalacion_id)
            : null;
        if (!fecha || !horaInicio || !horaFin) {
          return res.status(400).json({ error: 'fecha y horas obligatorias' });
        }
        const [clases, reservas] = await Promise.all([
          conflictosClaseEnFranja(fecha, horaInicio, horaFin),
          conflictosReservaEnFranja(
            fecha,
            horaInicio,
            horaFin,
            instalacionId,
            body.exclude_id || null
          ),
        ]);
        res.json({
          data: {
            ok: clases.length === 0 && reservas.length === 0,
            clases,
            reservas,
          },
        });
      } catch (error) {
        console.error('[eventos] check reserva', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.patch(
    '/api/eventos/reservas/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const body = req.body || {};
        if (body.estado !== undefined) {
          const estado = String(body.estado);
          if (estado !== 'reservada' && estado !== 'cancelada') {
            return res.status(400).json({ error: 'estado inválido' });
          }
          const { rows } = await query(
            `UPDATE evento_reservas
             SET estado = $2, updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, estado]
          );
          if (!rows[0]) return res.status(404).json({ error: 'Reserva no encontrada' });
          return res.json({ data: rows[0] });
        }
        return res.status(400).json({ error: 'Nada que actualizar' });
      } catch (error) {
        console.error('[eventos] patch reserva', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.delete(
    '/api/eventos/reservas/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rowCount } = await query(`DELETE FROM evento_reservas WHERE id = $1`, [
          id,
        ]);
        if (!rowCount) return res.status(404).json({ error: 'Reserva no encontrada' });
        res.json({ ok: true });
      } catch (error) {
        console.error('[eventos] delete reserva', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/cartel',
    requireUser,
    requireAdmin,
    (req, res, next) => {
      uploadCartel.single('file')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      });
    },
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
        const { rows: prev } = await query(
          `SELECT cartel_path FROM evento_ediciones WHERE id = $1`,
          [id]
        );
        if (!prev[0]) {
          fs.unlinkSync(req.file.path);
          return res.status(404).json({ error: 'Edición no encontrada' });
        }
        const { rows } = await query(
          `UPDATE evento_ediciones
           SET cartel_path = $2, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [id, req.file.filename]
        );
        const old = prev[0].cartel_path;
        if (old && old !== req.file.filename) {
          const oldFile = resolveCartel(old);
          if (oldFile && fs.existsSync(oldFile)) {
            try {
              fs.unlinkSync(oldFile);
            } catch {
              /* ignore */
            }
          }
        }
        res.json({
          data: {
            ...rows[0],
            cartel_url: cartelPublicUrl(rows[0].cartel_path),
          },
        });
      } catch (error) {
        console.error('[eventos] upload cartel', error);
        if (req.file?.path && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch {
            /* ignore */
          }
        }
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  /** C2: marcar pagado + movimiento instalaciones en una TX (idempotente). */
  app.post(
    '/api/eventos/inscripciones/:id/pago',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const body = req.body || {};
        const row = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const cur = await client.query(
              `SELECT * FROM evento_inscripciones WHERE id = $1 FOR UPDATE`,
              [id]
            );
            const ins = cur.rows[0];
            if (!ins) {
              const err = new Error('Inscripción no encontrada');
              err.status = 404;
              throw err;
            }
            const ed = await client.query(
              `SELECT precio_centimos FROM evento_ediciones WHERE id = $1`,
              [ins.edicion_id]
            );
            const importe =
              parsePrecioCentimos(
                body.cantidad_centimos ??
                  (body.cantidad_euros != null && body.cantidad_euros !== ''
                    ? Math.round(Number(body.cantidad_euros) * 100)
                    : null)
              ) ??
              ins.importe_pagado_centimos ??
              ed.rows[0]?.precio_centimos ??
              0;
            const metodo = body.metodo
              ? String(body.metodo).trim().slice(0, 40)
              : ins.metodo_pago || null;
            await client.query(
              `UPDATE evento_inscripciones
               SET estado = 'pagado',
                   importe_pagado_centimos = $2,
                   metodo_pago = $3,
                   pagado_at = coalesce(pagado_at, now()),
                   updated_at = now()
               WHERE id = $1`,
              [id, importe, metodo]
            );
            const exists = await client.query(
              `SELECT id FROM evento_movimientos
               WHERE inscripcion_id = $1 AND origen = 'inscripcion' LIMIT 1`,
              [id]
            );
            let movimiento = exists.rows[0] || null;
            if (movimiento) {
              const upd = await client.query(
                `UPDATE evento_movimientos SET cantidad_centimos = $2
                 WHERE id = $1 RETURNING *`,
                [movimiento.id, importe]
              );
              movimiento = upd.rows[0];
            } else if (importe > 0) {
              const inserted = await client.query(
                `INSERT INTO evento_movimientos
                   (edicion_id, tipo, concepto, cantidad_centimos, fecha,
                    origen, inscripcion_id, impacto_instalaciones)
                 VALUES ($1,'ingreso',$2,$3,current_date,'inscripcion',$4,true)
                 RETURNING *`,
                [
                  ins.edicion_id,
                  body.concepto ||
                    `Inscripción ${ins.nombre} ${ins.apellidos}`.trim(),
                  importe,
                  ins.id,
                ]
              );
              movimiento = inserted.rows[0];
            }
            const updated = await client.query(
              `SELECT * FROM evento_inscripciones WHERE id = $1`,
              [id]
            );
            await client.query('COMMIT');
            return { inscripcion: updated.rows[0], movimiento };
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
        const ins = row.inscripcion;
        await registrarBitacora(
          null,
          ins.edicion_id,
          'pago',
          `Pago de ${ins.nombre} ${ins.apellidos}: ${formatEuros(ins.importe_pagado_centimos)}${ins.metodo_pago ? ` (${ins.metodo_pago})` : ''}`,
          {
            inscripcion_id: ins.id,
            importe_centimos: ins.importe_pagado_centimos,
            metodo: ins.metodo_pago,
          },
          req
        );
        res.json({ data: row });
      } catch (error) {
        console.error('[eventos] pago inscripcion', error);
        res.status(error.status || 500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.delete(
    '/api/eventos/inscripciones/:id/pago',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const row = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const updated = await client.query(
              `UPDATE evento_inscripciones
               SET estado = CASE WHEN estado = 'pagado' THEN 'confirmado' ELSE estado END,
                   importe_pagado_centimos = NULL,
                   metodo_pago = NULL,
                   pagado_at = NULL,
                   updated_at = now()
               WHERE id = $1
               RETURNING *`,
              [id]
            );
            if (!updated.rows[0]) {
              const err = new Error('Inscripción no encontrada');
              err.status = 404;
              throw err;
            }
            await client.query(
              `DELETE FROM evento_movimientos
               WHERE inscripcion_id = $1 AND origen = 'inscripcion'`,
              [id]
            );
            await client.query('COMMIT');
            return updated.rows[0];
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
        await registrarBitacora(
          null,
          row.edicion_id,
          'pago',
          `Pago anulado de ${row.nombre} ${row.apellidos}`,
          { inscripcion_id: row.id },
          req
        );
        res.json({ data: row });
      } catch (error) {
        console.error('[eventos] anular pago', error);
        res.status(error.status || 500).json({ error: error.message || 'Error' });
      }
    }
  );

  // ——— Bitácora del evento ———
  app.get(
    '/api/eventos/ediciones/:id/bitacora',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const { rows } = await query(
          `SELECT * FROM evento_bitacora
           WHERE edicion_id = $1
           ORDER BY created_at DESC
           LIMIT 500`,
          [String(req.params.id || '')]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] bitacora get', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/bitacora',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const descripcion = String(req.body?.descripcion || '').trim();
        if (!descripcion) return res.status(400).json({ error: 'Escribe la nota' });
        const tipo = req.body?.tipo === 'incidencia' ? 'incidencia' : 'nota';
        const { rows } = await query(
          `INSERT INTO evento_bitacora
             (edicion_id, tipo, descripcion, actor_email, actor_rol)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [edicionId, tipo, descripcion.slice(0, 2000), req.user?.email || null, req.user?.rol || null]
        );
        res.status(201).json({ data: rows[0] });
      } catch (error) {
        console.error('[eventos] bitacora post', error);
        res.status(error.code === '23503' ? 400 : 500).json({
          error: error.message || 'Error',
        });
      }
    }
  );

  // ——— Resultados + clasificación ———
  app.get(
    '/api/eventos/ediciones/:id/resultados',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT r.*,
                  ia.nombre AS a_nombre, ia.apellidos AS a_apellidos,
                  ib.nombre AS b_nombre, ib.apellidos AS b_apellidos
           FROM evento_resultados r
           JOIN evento_inscripciones ia ON ia.id = r.inscripcion_a
           JOIN evento_inscripciones ib ON ib.id = r.inscripcion_b
           WHERE r.edicion_id = $1
           ORDER BY r.created_at DESC`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] resultados', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/resultados',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};
        const a = String(body.inscripcion_a || '');
        const b = String(body.inscripcion_b || '');
        if (!a || !b || a === b) {
          return res.status(400).json({ error: 'Elige dos inscritos distintos' });
        }
        const toInt = v => {
          const n = Math.trunc(Number(v));
          return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        const setsA = toInt(body.sets_a);
        const setsB = toInt(body.sets_b);
        const walkover = parseBool(body.walkover, false);
        let ganador = ['a', 'b', 'empate'].includes(body.ganador)
          ? body.ganador
          : null;
        if (!ganador) {
          ganador = setsA > setsB ? 'a' : setsB > setsA ? 'b' : 'empate';
        }
        const { rows } = await query(
          `INSERT INTO evento_resultados
             (edicion_id, jornada_id, inscripcion_a, inscripcion_b,
              sets_a, sets_b, juegos_a, juegos_b, walkover, ganador, notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [
            edicionId,
            body.jornada_id ? String(body.jornada_id) : null,
            a,
            b,
            setsA,
            setsB,
            toInt(body.juegos_a),
            toInt(body.juegos_b),
            walkover,
            ganador,
            body.notas ? String(body.notas).trim() : null,
          ]
        );
        const nombres = await query(
          `SELECT id, nombre, apellidos FROM evento_inscripciones WHERE id = ANY($1::uuid[])`,
          [[a, b]]
        );
        const nom = idIns => {
          const r = nombres.rows.find(x => x.id === idIns);
          return r ? `${r.nombre} ${r.apellidos}` : '?';
        };
        await registrarBitacora(
          null,
          edicionId,
          'resultado',
          `Resultado: ${nom(a)} ${setsA}–${setsB} ${nom(b)}${walkover ? ' (W.O.)' : ''}`,
          { resultado_id: rows[0].id },
          req
        );
        res.status(201).json({ data: rows[0] });
      } catch (error) {
        console.error('[eventos] crear resultado', error);
        res.status(error.code === '23503' ? 400 : 500).json({
          error: error.message || 'Error',
        });
      }
    }
  );

  app.delete(
    '/api/eventos/resultados/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const { rows } = await query(
          `DELETE FROM evento_resultados WHERE id = $1 RETURNING edicion_id, sets_a, sets_b`,
          [String(req.params.id || '')]
        );
        if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
        await registrarBitacora(
          null,
          rows[0].edicion_id,
          'resultado',
          `Resultado borrado (${rows[0].sets_a}–${rows[0].sets_b})`,
          {},
          req
        );
        res.json({ ok: true });
      } catch (error) {
        console.error('[eventos] borrar resultado', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/ediciones/:id/clasificacion',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const tabla = await computarClasificacion(String(req.params.id || ''));
        res.json({ data: tabla });
      } catch (error) {
        console.error('[eventos] clasificacion', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  // ——— Votaciones (QR premios) ———
  app.get(
    '/api/eventos/ediciones/:id/votaciones',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT v.*,
                  (SELECT count(*)::int FROM evento_votacion_opciones o
                    WHERE o.votacion_id = v.id) AS opciones_count,
                  (SELECT count(*)::int FROM evento_votos t
                    WHERE t.votacion_id = v.id) AS votos_count
           FROM evento_votaciones v
           WHERE v.edicion_id = $1
           ORDER BY v.created_at DESC`,
          [id]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] votaciones', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/votaciones',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const body = req.body || {};
        const titulo = String(body.titulo || '').trim();
        if (!titulo) return res.status(400).json({ error: 'Título obligatorio' });
        const opciones = Array.isArray(body.opciones)
          ? body.opciones
              .map(o => ({
                etiqueta: String(o?.etiqueta || '').trim(),
                inscripcion_id: o?.inscripcion_id
                  ? String(o.inscripcion_id)
                  : null,
              }))
              .filter(o => o.etiqueta)
          : [];
        if (opciones.length < 2) {
          return res.status(400).json({ error: 'Añade al menos 2 opciones' });
        }
        const row = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const v = await client.query(
              `INSERT INTO evento_votaciones (edicion_id, titulo, descripcion, token)
               VALUES ($1,$2,$3,$4) RETURNING *`,
              [
                edicionId,
                titulo,
                body.descripcion ? String(body.descripcion).trim() : null,
                nuevoToken(),
              ]
            );
            const votacion = v.rows[0];
            for (let i = 0; i < opciones.length; i++) {
              await client.query(
                `INSERT INTO evento_votacion_opciones
                   (votacion_id, etiqueta, inscripcion_id, orden)
                 VALUES ($1,$2,$3,$4)`,
                [votacion.id, opciones[i].etiqueta, opciones[i].inscripcion_id, i]
              );
            }
            await client.query('COMMIT');
            return votacion;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
        await registrarBitacora(
          null,
          edicionId,
          'votacion',
          `Votación creada: ${titulo} (${opciones.length} opciones)`,
          { votacion_id: row.id },
          req
        );
        res.status(201).json({ data: row });
      } catch (error) {
        console.error('[eventos] crear votacion', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.patch(
    '/api/eventos/votaciones/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const body = req.body || {};
        const fields = [];
        const params = [];
        if (body.abierta !== undefined) {
          params.push(parseBool(body.abierta, true));
          fields.push(`abierta = $${params.length}`);
        }
        if (body.titulo !== undefined) {
          params.push(String(body.titulo).trim());
          fields.push(`titulo = $${params.length}`);
        }
        if (body.descripcion !== undefined) {
          params.push(body.descripcion ? String(body.descripcion).trim() : null);
          fields.push(`descripcion = $${params.length}`);
        }
        if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
        params.push(id);
        const { rows } = await query(
          `UPDATE evento_votaciones SET ${fields.join(', ')}, updated_at = now()
           WHERE id = $${params.length} RETURNING *`,
          params
        );
        if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
        if (body.abierta !== undefined) {
          await registrarBitacora(
            null,
            rows[0].edicion_id,
            'votacion',
            `Votación ${rows[0].abierta ? 'abierta' : 'cerrada'}: ${rows[0].titulo}`,
            { votacion_id: rows[0].id },
            req
          );
        }
        res.json({ data: rows[0] });
      } catch (error) {
        console.error('[eventos] patch votacion', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.delete(
    '/api/eventos/votaciones/:id',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const { rows } = await query(
          `DELETE FROM evento_votaciones WHERE id = $1 RETURNING edicion_id, titulo`,
          [String(req.params.id || '')]
        );
        if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
        await registrarBitacora(
          null,
          rows[0].edicion_id,
          'votacion',
          `Votación eliminada: ${rows[0].titulo}`,
          {},
          req
        );
        res.json({ ok: true });
      } catch (error) {
        console.error('[eventos] borrar votacion', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/votaciones/:id/resultados',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        const { rows } = await query(
          `SELECT o.id, o.etiqueta, o.orden,
                  (SELECT count(*)::int FROM evento_votos t WHERE t.opcion_id = o.id) AS votos
           FROM evento_votacion_opciones o
           WHERE o.votacion_id = $1
           ORDER BY votos DESC, o.orden ASC`,
          [id]
        );
        const total = rows.reduce((s, r) => s + r.votos, 0);
        res.json({ data: { opciones: rows, total } });
      } catch (error) {
        console.error('[eventos] resultados votacion', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.post(
    '/api/eventos/ediciones/:id/votacion-qr',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const edicionId = String(req.params.id || '');
        const regenerar = parseBool(req.body?.regenerar, false);
        const cur = await query(
          `SELECT votacion_token FROM evento_ediciones WHERE id = $1`,
          [edicionId]
        );
        if (!cur.rows[0]) return res.status(404).json({ error: 'Evento no encontrado' });
        let token = cur.rows[0].votacion_token;
        if (!token || regenerar) {
          token = nuevoToken();
          await query(
            `UPDATE evento_ediciones SET votacion_token = $2, updated_at = now() WHERE id = $1`,
            [edicionId, token]
          );
          await registrarBitacora(
            null,
            edicionId,
            'votacion',
            regenerar
              ? 'QR de votación regenerado (el anterior deja de funcionar)'
              : 'QR de votación generado',
            {},
            req
          );
        }
        res.json({ data: { token } });
      } catch (error) {
        console.error('[eventos] votacion qr', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  app.get(
    '/api/eventos/votaciones/:id/votos',
    requireUser,
    requireStaff,
    async (req, res) => {
      try {
        const { rows } = await query(
          `SELECT t.id, t.votante_nombre, t.votante_telefono, t.created_at,
                  o.etiqueta AS opcion
           FROM evento_votos t
           JOIN evento_votacion_opciones o ON o.id = t.opcion_id
           WHERE t.votacion_id = $1
           ORDER BY t.created_at DESC`,
          [String(req.params.id || '')]
        );
        res.json({ data: rows });
      } catch (error) {
        console.error('[eventos] votos', error);
        res.status(500).json({ error: error.message || 'Error' });
      }
    }
  );

  // ——— Público (landing) ———
  app.get('/api/public/eventos', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT e.id, e.nombre, e.temporada, e.fecha_inicio, e.fecha_fin,
                e.inscripcion_abierta, e.aforo, e.precio_centimos, e.cartel_path,
                t.id AS tipo_id, t.slug AS tipo_slug, t.nombre AS tipo_nombre,
                t.subtitle AS tipo_subtitle, t.theme AS tipo_theme,
                t.color AS tipo_color, t.accent AS tipo_accent,
                t.form_schema, t.marketing
         FROM evento_ediciones e
         JOIN evento_tipos t ON t.id = e.tipo_id
         WHERE e.publicado = true AND t.activo = true
         ORDER BY e.fecha_inicio NULLS LAST, t.orden`
      );
      res.json({ data: rows.map(publicEdicion) });
    } catch (error) {
      console.error('[eventos] public list', error);
      res.status(500).json({ error: 'Error' });
    }
  });

  /** Edición publicada vigente para un tipo (slug landing). Prioriza inscripción abierta. */
  app.get('/api/public/eventos/tipo/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      if (!slug) return res.status(400).json({ error: 'slug obligatorio' });
      const { rows } = await query(
        `SELECT e.id, e.nombre, e.temporada, e.fecha_inicio, e.fecha_fin,
                e.inscripcion_abierta, e.aforo, e.precio_centimos, e.cartel_path,
                t.id AS tipo_id, t.slug AS tipo_slug, t.nombre AS tipo_nombre,
                t.subtitle AS tipo_subtitle, t.theme AS tipo_theme,
                t.color AS tipo_color, t.accent AS tipo_accent,
                t.form_schema, t.marketing
         FROM evento_ediciones e
         JOIN evento_tipos t ON t.id = e.tipo_id
         WHERE e.publicado = true AND t.activo = true AND t.slug = $1
         ORDER BY e.inscripcion_abierta DESC, e.fecha_inicio DESC NULLS LAST, e.created_at DESC
         LIMIT 1`,
        [slug]
      );
      if (!rows[0]) {
        return res.status(404).json({ error: 'No hay edición publicada' });
      }
      res.json({ data: publicEdicion(rows[0]) });
    } catch (error) {
      console.error('[eventos] public por tipo', error);
      res.status(500).json({ error: 'Error' });
    }
  });

  app.get('/api/public/eventos/:id', async (req, res) => {
    try {
      const row = await getEdicionJoin(String(req.params.id || ''));
      if (!row || !row.publicado) {
        return res.status(404).json({ error: 'Evento no encontrado' });
      }
      res.json({ data: publicEdicion(row) });
    } catch (error) {
      console.error('[eventos] public get', error);
      res.status(500).json({ error: 'Error' });
    }
  });

  app.post('/api/public/eventos/:id/inscripciones', async (req, res) => {
    try {
      const edicionId = String(req.params.id || '');
      const body = req.body || {};
      // Honeypot anti-bots
      if (body.website || body.company) {
        return res.status(201).json({ data: { ok: true } });
      }

      const edicion = await getEdicionJoin(edicionId);
      if (!edicion || !edicion.publicado) {
        return res.status(404).json({ error: 'Evento no encontrado' });
      }
      if (!edicion.inscripcion_abierta) {
        return res.status(403).json({ error: 'Inscripción cerrada' });
      }

      const nombre = String(body.nombre || '').trim();
      const apellidos = String(body.apellidos || '').trim();
      const telefono = normalizarTelefonoE164(body.telefono || body.telefono_e164);
      const nivel = body.nivel != null ? String(body.nivel).trim() : null;

      if (!nombre || !apellidos || !telefono) {
        return res.status(400).json({
          error: 'nombre, apellidos y teléfono válido son obligatorios',
        });
      }

      const schema = Array.isArray(edicion.form_schema) ? edicion.form_schema : [];
      const payload = {};
      for (const field of schema) {
        const key = field?.key;
        if (!key || key === 'nombre' || key === 'apellidos' || key === 'telefono' || key === 'nivel') {
          continue;
        }
        if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
          payload[key] = body[key];
        } else if (field.required) {
          return res.status(400).json({ error: `Falta el campo ${field.label || key}` });
        }
      }
      if (schema.some(f => f.key === 'nivel' && f.required) && !nivel) {
        return res.status(400).json({ error: 'nivel es obligatorio' });
      }

      const { row, listaEspera } = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const result = await insertarInscripcion(
            client,
            edicionId,
            { nombre, apellidos, telefono, nivel, payload, estado: 'nuevo' },
            { requireAbierta: true }
          );
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });

      await registrarBitacora(
        null,
        edicionId,
        'inscripcion',
        `Inscripción web: ${nombre} ${apellidos}${listaEspera ? ' (lista de espera)' : ''}`,
        { inscripcion_id: row.id },
        {}
      );

      res.status(201).json({
        data: { id: row.id, created_at: row.created_at, estado: row.estado },
        lista_espera: listaEspera,
      });
    } catch (error) {
      console.error('[eventos] public inscribir', error);
      res.status(error.status || 500).json({
        error: error.status ? error.message : 'No se pudo registrar la inscripción',
      });
    }
  });

  // Ranking público de una edición publicada.
  app.get('/api/public/eventos/:id/clasificacion', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const ed = await query(
        `SELECT id, nombre, publicado FROM evento_ediciones WHERE id = $1`,
        [id]
      );
      if (!ed.rows[0] || !ed.rows[0].publicado) {
        return res.status(404).json({ error: 'No disponible' });
      }
      const tabla = await computarClasificacion(id);
      // En público solo exponemos nombre + inicial del apellido.
      const data = tabla.map(r => ({
        pos: r.pos,
        nombre: r.nombre,
        apellido_inicial: r.apellidos ? `${String(r.apellidos).charAt(0)}.` : '',
        pj: r.pj,
        pg: r.pg,
        pe: r.pe,
        pp: r.pp,
        dif_sets: r.dif_sets,
        dif_juegos: r.dif_juegos,
        puntos: r.puntos,
      }));
      res.json({ data: { edicion: ed.rows[0].nombre, tabla: data } });
    } catch (error) {
      console.error('[eventos] public clasificacion', error);
      res.status(500).json({ error: 'Error' });
    }
  });

  // Votación pública del evento (token del QR de la edición).
  app.get('/api/public/votaciones/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      const ed = await query(
        `SELECT id, nombre FROM evento_ediciones WHERE votacion_token = $1`,
        [token]
      );
      const edicion = ed.rows[0];
      if (!edicion) {
        return res.status(404).json({ error: 'Este QR no es válido o ha sido regenerado' });
      }
      const vs = await query(
        `SELECT id, titulo, descripcion FROM evento_votaciones
         WHERE edicion_id = $1 AND abierta = true
         ORDER BY created_at ASC`,
        [edicion.id]
      );
      const ids = vs.rows.map(v => v.id);
      const ops = ids.length
        ? await query(
            `SELECT id, votacion_id, etiqueta, orden FROM evento_votacion_opciones
             WHERE votacion_id = ANY($1::uuid[]) ORDER BY orden ASC`,
            [ids]
          )
        : { rows: [] };
      res.json({
        data: {
          edicion: edicion.nombre,
          votaciones: vs.rows.map(v => ({
            ...v,
            opciones: ops.rows
              .filter(o => o.votacion_id === v.id)
              .map(o => ({ id: o.id, etiqueta: o.etiqueta })),
          })),
        },
      });
    } catch (error) {
      console.error('[eventos] public votacion get', error);
      res.status(500).json({ error: 'Error' });
    }
  });

  app.post('/api/public/votaciones/:token/voto', async (req, res) => {
    try {
      const ip =
        (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        req.ip ||
        'anon';
      if (votoRateLimited(ip)) {
        return res.status(429).json({ error: 'Demasiados votos, inténtalo luego' });
      }
      const token = String(req.params.token || '');
      const body = req.body || {};
      const nombre = String(body.nombre || '').trim().slice(0, 120);
      const telefono = normalizarTelefonoE164(body.telefono);
      if (!nombre || !telefono) {
        return res.status(400).json({ error: 'Pon tu nombre y un teléfono válido' });
      }
      const votos = Array.isArray(body.votos) ? body.votos : [];
      if (!votos.length) return res.status(400).json({ error: 'Elige al menos una opción' });

      const ed = await query(
        `SELECT id FROM evento_ediciones WHERE votacion_token = $1`,
        [token]
      );
      const edicion = ed.rows[0];
      if (!edicion) {
        return res.status(404).json({ error: 'Este QR no es válido o ha sido regenerado' });
      }

      const registrados = [];
      const yaVotados = [];
      for (const v of votos.slice(0, 50)) {
        const votacionId = String(v?.votacion_id || '');
        const opcionId = String(v?.opcion_id || '');
        const ok = await query(
          `SELECT o.id FROM evento_votacion_opciones o
           JOIN evento_votaciones vt ON vt.id = o.votacion_id
           WHERE o.id = $1 AND vt.id = $2 AND vt.edicion_id = $3 AND vt.abierta = true`,
          [opcionId, votacionId, edicion.id]
        );
        if (!ok.rows[0]) continue;
        const ins = await query(
          `INSERT INTO evento_votos
             (votacion_id, opcion_id, huella, votante_nombre, votante_telefono)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (votacion_id, huella) DO NOTHING
           RETURNING id`,
          [votacionId, opcionId, telefono, nombre, telefono]
        );
        if (ins.rows[0]) registrados.push(votacionId);
        else yaVotados.push(votacionId);
      }
      if (!registrados.length && !yaVotados.length) {
        return res.status(400).json({ error: 'Las votaciones elegidas ya no están abiertas' });
      }
      res.status(201).json({
        data: { registrados: registrados.length, ya_votados: yaVotados },
      });
    } catch (error) {
      console.error('[eventos] public voto', error);
      res.status(500).json({ error: 'No se pudo registrar el voto' });
    }
  });
}

module.exports = { mountDomainEventos };
