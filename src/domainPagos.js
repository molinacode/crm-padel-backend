const crypto = require('crypto');
const { query, withClient } = require('./db');
const { requireAdmin } = require('./authz');
const { requireUser } = require('./session');
const { calcularAlumnosConDeuda } = require('./domainDeudas');
const {
  normalizarMes,
  mesesConsecutivos,
  parseNumMeses,
  repartirImporte,
  claveParDescartado,
  emparejarDuplicados,
} = require('./pagosDuplicados');

function parseCantidad(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function errorHttp(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) err.extra = extra;
  return err;
}

function normalizarBodyPago(body) {
  const alumnoId = String(body.alumno_id || '').trim();
  const tipo = String(body.tipo_pago || '').trim();
  const cantidad = parseCantidad(body.cantidad);
  if (!alumnoId) throw errorHttp(400, 'alumno_id obligatorio');
  if (cantidad == null) throw errorHttp(400, 'cantidad inválida');
  if (tipo !== 'mensual' && tipo !== 'clases') {
    throw errorHttp(400, 'tipo_pago debe ser mensual o clases');
  }
  return {
    alumno_id: alumnoId,
    cantidad,
    tipo_pago: tipo,
    mes_cubierto: tipo === 'mensual' ? body.mes_cubierto || null : null,
    fecha_inicio:
      tipo === 'clases' && body.fecha_inicio
        ? String(body.fecha_inicio).slice(0, 10)
        : null,
    fecha_fin:
      tipo === 'clases' && body.fecha_fin
        ? String(body.fecha_fin).slice(0, 10)
        : null,
    clases_cubiertas:
      tipo === 'clases' && body.clases_cubiertas != null && body.clases_cubiertas !== ''
        ? Number(body.clases_cubiertas)
        : null,
    metodo: body.metodo || 'transferencia',
    fecha_pago: body.fecha_pago
      ? String(body.fecha_pago)
      : new Date().toISOString(),
  };
}

function enviarError(res, error, etiqueta) {
  if (!error.status) console.error(`[pagos] ${etiqueta}`, error);
  res
    .status(error.status || (error.code === '23503' ? 400 : 500))
    .json({ error: error.message || 'Error', ...(error.extra || {}) });
}

/** Pagos mensuales del alumno que ya cubren alguno de esos meses. */
async function pagosQueCubrenMeses(db, alumnoId, meses) {
  const { rows } = await db.query(
    `SELECT id, cantidad, mes_cubierto, fecha_pago, metodo, origen_registro
       FROM pagos
      WHERE alumno_id = $1 AND tipo_pago = 'mensual' AND mes_cubierto IS NOT NULL`,
    [alumnoId]
  );
  return rows.filter(r => meses.includes(normalizarMes(r.mes_cubierto)));
}

function mesCuota(rows) {
  const cantidades = rows
    .map(r => Number(r.cantidad))
    .filter(n => n > 0)
    .sort((a, b) => a - b);
  if (!cantidades.length) return null;
  return cantidades[Math.floor(cantidades.length / 2)];
}

function sumarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function mountDomainPagos(app) {
  app.post('/api/pagos', requireUser, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const p = normalizarBodyPago(body);
      const numMeses = p.tipo_pago === 'mensual' ? parseNumMeses(body.meses) : 1;
      const meses =
        p.tipo_pago === 'mensual'
          ? mesesConsecutivos(p.mes_cubierto, numMeses)
          : [null];
      if (p.tipo_pago === 'mensual' && !meses.length) {
        throw errorHttp(400, 'Indica el mes cubierto');
      }

      if (p.tipo_pago === 'mensual' && !body.forzar) {
        const existentes = await pagosQueCubrenMeses({ query }, p.alumno_id, meses);
        if (existentes.length) {
          throw errorHttp(409, 'Ese alumno ya tiene pago registrado para ese mes', {
            code: 'mes_ya_pagado',
            existentes,
          });
        }
      }

      const cantidades = repartirImporte(p.cantidad, meses.length);
      const operacionId = meses.length > 1 ? crypto.randomUUID() : null;

      const filas = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const out = [];
          for (let i = 0; i < meses.length; i += 1) {
            const { rows } = await client.query(
              `INSERT INTO pagos (
                 alumno_id, cantidad, tipo_pago, mes_cubierto,
                 fecha_inicio, fecha_fin, clases_cubiertas, metodo, fecha_pago, operacion_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               RETURNING *`,
              [
                p.alumno_id,
                cantidades[i],
                p.tipo_pago,
                meses[i],
                p.fecha_inicio,
                p.fecha_fin,
                p.clases_cubiertas,
                p.metodo,
                p.fecha_pago,
                operacionId,
              ]
            );
            out.push(rows[0]);
          }
          await client.query('COMMIT');
          return out;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      res.status(201).json({ data: filas[0], filas });
    } catch (error) {
      enviarError(res, error, 'create');
    }
  });

  /**
   * Lo que necesita el importador para avisar de duplicados con pagos a mano
   * y proponer pagos de varios meses: pagos no importados cerca de las fechas
   * del extracto, cuota habitual y meses pendientes por alumno.
   */
  app.get(
    '/api/pagos/contexto-importacion',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const desde = String(req.query.desde || '').slice(0, 10);
        const hasta = String(req.query.hasta || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
          throw errorHttp(400, 'desde y hasta (YYYY-MM-DD) obligatorios');
        }
        const ini = sumarDias(desde, -45);
        const fin = sumarDias(hasta, 20);
        const [pagosRes, cuotaRes, deudas] = await Promise.all([
          query(
            `SELECT id, alumno_id, cantidad, tipo_pago, mes_cubierto, fecha_pago,
                    metodo, origen_registro
               FROM pagos
              WHERE origen_registro <> 'import_csv'
                AND alumno_id IS NOT NULL
                AND (
                  fecha_pago::date BETWEEN $1::date AND $2::date
                  OR (tipo_pago = 'mensual' AND mes_cubierto BETWEEN $3 AND $4)
                )`,
            [ini, fin, ini.slice(0, 7), fin.slice(0, 7)]
          ),
          query(
            `SELECT a.id AS alumno_id, a.precio_mes,
                    (SELECT array_agg(x.cantidad) FROM (
                       SELECT p.cantidad FROM pagos p
                        WHERE p.alumno_id = a.id AND p.tipo_pago = 'mensual'
                        ORDER BY p.fecha_pago DESC NULLS LAST LIMIT 6
                     ) x) AS ultimas
               FROM alumnos a`
          ),
          calcularAlumnosConDeuda().catch(() => ({ alumnos: [] })),
        ]);

        const cuotas = {};
        for (const r of cuotaRes.rows) {
          const precio = Number(r.precio_mes || 0);
          const cuota =
            precio > 0
              ? precio
              : mesCuota((r.ultimas || []).map(c => ({ cantidad: c })));
          if (cuota) cuotas[r.alumno_id] = cuota;
        }
        const mesesPendientes = {};
        for (const a of deudas.alumnos || []) {
          mesesPendientes[a.id] = (a.meses || []).map(m => m.mes);
        }

        res.json({ data: { pagos: pagosRes.rows, cuotas, mesesPendientes } });
      } catch (error) {
        enviarError(res, error, 'contexto-importacion');
      }
    }
  );

  app.get(
    '/api/pagos/posibles-duplicados',
    requireUser,
    requireAdmin,
    async (_req, res) => {
      try {
        const [pagosRes, descRes] = await Promise.all([
          query(
            `SELECT p.id, p.alumno_id, a.nombre AS alumno_nombre, p.cantidad, p.tipo_pago,
                    p.mes_cubierto, p.fecha_inicio, p.fecha_fin, p.fecha_pago, p.metodo,
                    p.origen_registro, p.huella_movimiento, p.operacion_id,
                    m.concepto_raw AS concepto_banco
               FROM pagos p
               LEFT JOIN alumnos a ON a.id = p.alumno_id
               LEFT JOIN importaciones_banco_movimientos m
                 ON m.huella_movimiento = split_part(p.huella_movimiento, '#', 1)
              WHERE p.alumno_id IS NOT NULL`
          ),
          query(`SELECT pago_a, pago_b FROM pagos_duplicados_descartados`),
        ]);
        // Descartar un par vale para toda la operación: si no, el mismo pago a mano
        // reaparece emparejado con el otro mes o pagador de esa transferencia.
        const hermanos = new Map();
        for (const p of pagosRes.rows) {
          if (!p.operacion_id) continue;
          const lista = hermanos.get(p.operacion_id) || [];
          lista.push(p.id);
          hermanos.set(p.operacion_id, lista);
        }
        const opPorId = new Map(pagosRes.rows.map(p => [p.id, p.operacion_id]));
        const grupo = id => hermanos.get(opPorId.get(id)) || [id];
        const descartados = new Set();
        for (const r of descRes.rows) {
          for (const a of grupo(r.pago_a)) {
            for (const b of grupo(r.pago_b)) descartados.add(claveParDescartado(a, b));
          }
        }
        const pares = emparejarDuplicados(pagosRes.rows, descartados).map(p => ({
          id: claveParDescartado(p.manual.id, p.importado.id),
          manual: p.manual,
          importado: p.importado,
          mismo_mes: p.mismoMes,
          dias: p.dias,
        }));
        pares.sort(
          (a, b) =>
            String(b.importado.fecha_pago).localeCompare(String(a.importado.fecha_pago))
        );
        res.json({ data: pares });
      } catch (error) {
        enviarError(res, error, 'posibles-duplicados');
      }
    }
  );

  app.post(
    '/api/pagos/duplicados/descartar',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const a = String(req.body?.pago_a || '');
        const b = String(req.body?.pago_b || '');
        if (!a || !b || a === b) throw errorHttp(400, 'pago_a y pago_b obligatorios');
        const [x, y] = a < b ? [a, b] : [b, a];
        await query(
          `INSERT INTO pagos_duplicados_descartados (pago_a, pago_b, actor_email)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [x, y, req.user?.email || null]
        );
        res.json({ ok: true });
      } catch (error) {
        enviarError(res, error, 'descartar-duplicado');
      }
    }
  );

  /** Reparte un pago mensual ya guardado en varios meses consecutivos. */
  app.post('/api/pagos/:id/repartir', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const numMeses = parseNumMeses(req.body?.meses);
      if (numMeses < 2) throw errorHttp(400, 'Indica al menos 2 meses');

      const filas = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(
            `SELECT * FROM pagos WHERE id = $1 FOR UPDATE`,
            [id]
          );
          const pago = rows[0];
          if (!pago) throw errorHttp(404, 'Pago no encontrado');
          if (pago.tipo_pago !== 'mensual') {
            throw errorHttp(400, 'Solo se pueden repartir pagos mensuales');
          }
          const desde =
            normalizarMes(req.body?.desde) || normalizarMes(pago.mes_cubierto);
          if (!desde) throw errorHttp(400, 'Indica desde qué mes');
          const meses = mesesConsecutivos(desde, numMeses);
          const cantidades = repartirImporte(pago.cantidad, numMeses);
          const operacionId = pago.operacion_id || crypto.randomUUID();

          const actualizado = await client.query(
            `UPDATE pagos SET mes_cubierto = $2, cantidad = $3, operacion_id = $4
              WHERE id = $1 RETURNING *`,
            [id, meses[0], cantidades[0], operacionId]
          );
          const out = [actualizado.rows[0]];
          for (let i = 1; i < meses.length; i += 1) {
            const ins = await client.query(
              `INSERT INTO pagos (
                 alumno_id, cantidad, tipo_pago, mes_cubierto, metodo, fecha_pago,
                 origen_registro, clases_cubiertas, operacion_id
               ) VALUES ($1,$2,'mensual',$3,$4,$5,$6,$7,$8)
               RETURNING *`,
              [
                pago.alumno_id,
                cantidades[i],
                meses[i],
                pago.metodo,
                pago.fecha_pago,
                pago.origen_registro,
                pago.clases_cubiertas,
                operacionId,
              ]
            );
            out.push(ins.rows[0]);
          }
          await client.query('COMMIT');
          return out;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      res.json({ data: filas });
    } catch (error) {
      enviarError(res, error, 'repartir');
    }
  });

  app.patch('/api/pagos/:id', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const p = normalizarBodyPago(req.body || {});
      const { rows } = await query(
        `UPDATE pagos SET
           alumno_id = $2,
           cantidad = $3,
           tipo_pago = $4,
           mes_cubierto = $5,
           fecha_inicio = $6,
           fecha_fin = $7,
           clases_cubiertas = $8,
           metodo = $9,
           fecha_pago = $10
         WHERE id = $1
         RETURNING *`,
        [
          id,
          p.alumno_id,
          p.cantidad,
          p.tipo_pago,
          p.mes_cubierto,
          p.fecha_inicio,
          p.fecha_fin,
          p.clases_cubiertas,
          p.metodo,
          p.fecha_pago,
        ]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Pago no encontrado' });
      res.json({ data: rows[0] });
    } catch (error) {
      enviarError(res, error, 'patch');
    }
  });

  app.delete('/api/pagos/:id', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const { rowCount } = await query(`DELETE FROM pagos WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Pago no encontrado' });
      res.json({ ok: true });
    } catch (error) {
      enviarError(res, error, 'delete');
    }
  });
}

module.exports = { mountDomainPagos };
