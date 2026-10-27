const { query } = require('./db');
const { requireAdmin } = require('./authz');
const { requireUser } = require('./session');

function parseCantidad(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function normalizarBodyPago(body) {
  const alumnoId = String(body.alumno_id || '').trim();
  const tipo = String(body.tipo_pago || '').trim();
  const cantidad = parseCantidad(body.cantidad);
  if (!alumnoId) {
    const err = new Error('alumno_id obligatorio');
    err.status = 400;
    throw err;
  }
  if (cantidad == null) {
    const err = new Error('cantidad inválida');
    err.status = 400;
    throw err;
  }
  if (tipo !== 'mensual' && tipo !== 'clases') {
    const err = new Error('tipo_pago debe ser mensual o clases');
    err.status = 400;
    throw err;
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

function mountDomainPagos(app) {
  app.post('/api/pagos', requireUser, requireAdmin, async (req, res) => {
    try {
      const p = normalizarBodyPago(req.body || {});
      const { rows } = await query(
        `INSERT INTO pagos (
           alumno_id, cantidad, tipo_pago, mes_cubierto,
           fecha_inicio, fecha_fin, clases_cubiertas, metodo, fecha_pago
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
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
      res.status(201).json({ data: rows[0] });
    } catch (error) {
      console.error('[pagos] create', error);
      res.status(error.status || (error.code === '23503' ? 400 : 500)).json({
        error: error.message || 'Error',
      });
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
      console.error('[pagos] patch', error);
      res.status(error.status || 500).json({ error: error.message || 'Error' });
    }
  });

  app.delete('/api/pagos/:id', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const { rowCount } = await query(`DELETE FROM pagos WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Pago no encontrado' });
      res.json({ ok: true });
    } catch (error) {
      console.error('[pagos] delete', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });
}

module.exports = { mountDomainPagos };
