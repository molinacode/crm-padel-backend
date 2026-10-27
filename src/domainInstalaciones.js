const { query } = require('./db');
const { requireUser } = require('./session');

/**
 * Ledger de Instalaciones vía dominio (C2): deja de depender de /api/query
 * para la pantalla principal de instalaciones.
 */
function mountDomainInstalaciones(app) {
  app.get('/api/instalaciones/ledger', requireUser, async (req, res) => {
    try {
      const desde = req.query?.desde ? String(req.query.desde).slice(0, 10) : null;
      const hasta = req.query?.hasta ? String(req.query.hasta).slice(0, 10) : null;

      const paramsEventos = [];
      let whereEventos = '';
      if (desde) {
        paramsEventos.push(desde);
        whereEventos += ` AND ec.fecha >= $${paramsEventos.length}`;
      }
      if (hasta) {
        paramsEventos.push(hasta);
        whereEventos += ` AND ec.fecha <= $${paramsEventos.length}`;
      }

      const paramsPagos = [];
      let wherePagos = '';
      if (desde) {
        paramsPagos.push(desde);
        wherePagos += ` AND fecha_pago >= $${paramsPagos.length}`;
      }
      if (hasta) {
        paramsPagos.push(hasta);
        wherePagos += ` AND fecha_pago <= $${paramsPagos.length}`;
      }

      const paramsGastos = [];
      let whereGastos = '';
      if (desde) {
        paramsGastos.push(desde);
        whereGastos += ` AND fecha_gasto >= $${paramsGastos.length}`;
      }
      if (hasta) {
        paramsGastos.push(hasta);
        whereGastos += ` AND fecha_gasto <= $${paramsGastos.length}`;
      }

      const paramsMovs = [];
      let whereMovs = 'WHERE m.impacto_instalaciones = true';
      if (desde) {
        paramsMovs.push(desde);
        whereMovs += ` AND m.fecha >= $${paramsMovs.length}`;
      }
      if (hasta) {
        paramsMovs.push(hasta);
        whereMovs += ` AND m.fecha <= $${paramsMovs.length}`;
      }

      const [eventosRes, pagosRes, gastosRes, movsRes, internasRes] =
        await Promise.all([
          query(
            `SELECT ec.id, ec.fecha, ec.estado, ec.excluir_alquiler, ec.clase_id,
                    c.id AS clase_id_join, c.nombre AS clase_nombre, c.tipo_clase
             FROM eventos_clase ec
             LEFT JOIN clases c ON c.id = ec.clase_id
             WHERE 1=1 ${whereEventos}
             ORDER BY ec.fecha ASC`,
            paramsEventos
          ).catch(async err => {
            if (err && err.code === '42703') {
              return query(
                `SELECT ec.id, ec.fecha, ec.estado, ec.clase_id,
                        c.id AS clase_id_join, c.nombre AS clase_nombre, c.tipo_clase
                 FROM eventos_clase ec
                 LEFT JOIN clases c ON c.id = ec.clase_id
                 WHERE 1=1 ${whereEventos}
                 ORDER BY ec.fecha ASC`,
                paramsEventos
              );
            }
            throw err;
          }),
          query(
            `SELECT id, cantidad, fecha_pago, tipo_pago, mes_cubierto
             FROM pagos
             WHERE 1=1 ${wherePagos}
             ORDER BY fecha_pago ASC`,
            paramsPagos
          ),
          query(
            `SELECT *
             FROM gastos_material
             WHERE 1=1 ${whereGastos}
             ORDER BY fecha_gasto DESC`,
            paramsGastos
          ).catch(() => ({ rows: [] })),
          query(
            `SELECT m.id, m.tipo, m.concepto, m.cantidad_centimos, m.fecha, m.edicion_id,
                    e.nombre AS edicion_nombre, t.nombre AS tipo_nombre
             FROM evento_movimientos m
             JOIN evento_ediciones e ON e.id = m.edicion_id
             JOIN evento_tipos t ON t.id = e.tipo_id
             ${whereMovs}
             ORDER BY m.fecha ASC`,
            paramsMovs
          ).catch(() => ({ rows: [] })),
          (() => {
            const p = [];
            let w = 'WHERE 1=1';
            if (desde) {
              p.push(desde);
              w += ` AND fecha >= $${p.length}`;
            }
            if (hasta) {
              p.push(hasta);
              w += ` AND fecha <= $${p.length}`;
            }
            return query(
              `SELECT id, clase_id, fecha, estado
               FROM pagos_clases_internas
               ${w}
               ORDER BY fecha ASC`,
              p
            ).catch(() => ({ rows: [] }));
          })(),
        ]);

      const eventos = (eventosRes.rows || []).map(row => ({
        id: row.id,
        fecha: row.fecha,
        estado: row.estado,
        excluir_alquiler: row.excluir_alquiler === true,
        clase_id: row.clase_id,
        clases: row.clase_id_join
          ? {
              id: row.clase_id_join,
              nombre: row.clase_nombre,
              tipo_clase: row.tipo_clase,
            }
          : null,
      }));

      res.json({
        data: {
          eventos,
          pagos: pagosRes.rows || [],
          gastos_material: gastosRes.rows || [],
          movimientos_evento: movsRes.rows || [],
          pagos_internas: internasRes.rows || [],
        },
      });
    } catch (error) {
      console.error('[instalaciones] ledger', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });
}

module.exports = { mountDomainInstalaciones };
