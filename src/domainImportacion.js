const { withClient } = require('./db');
const { requireAdmin } = require('./authz');

function splitCantidades(total, n) {
  if (n <= 1) return [total];
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] += cents - base * n;
  return parts.map(c => c / 100);
}

function mountDomainImportacion(app) {
  app.post('/api/importaciones/confirmar', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const nombreArchivo = String(body.nombreArchivo || 'extracto.csv');
    const banco = body.banco || null;
    const totales = body.totales || {};
    const movimientos = Array.isArray(body.movimientos) ? body.movimientos : [];

    if (!movimientos.length) {
      return res.status(400).json({ error: 'No hay movimientos para importar' });
    }

    try {
      const result = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const lote = await client.query(
            `INSERT INTO importaciones_banco (
               nombre_archivo, banco, estado, total_lineas, total_ingresos, total_gastos,
               total_aceptadas, total_duplicadas, total_descartadas, total_creadas_en_pagos
             ) VALUES ($1,$2,'confirmada',$3,$4,$5,$6,$7,$8,0)
             RETURNING id`,
            [
              nombreArchivo,
              banco,
              Number(totales.totalLineas || 0),
              Number(totales.totalIngresos || 0),
              Number(totales.totalGastos || 0),
              Number(totales.totalAceptadas || movimientos.length),
              Number(totales.totalDuplicadas || 0),
              Number(totales.totalDescartadas || 0),
            ]
          );
          const importId = lote.rows[0].id;
          let creados = 0;

          for (const item of movimientos) {
            const mov = item.movimiento || {};
            const pagadores = Array.isArray(item.pagadores)
              ? item.pagadores.map(String).filter(Boolean)
              : item.alumnoId
                ? [String(item.alumnoId)]
                : [];
            if (!pagadores.length) continue;

            const huella = String(item.huella || mov.huella || '');
            if (!huella) {
              const err = new Error('Cada movimiento necesita huella');
              err.status = 400;
              throw err;
            }

            const total = Math.abs(Number(mov.importe || item.importe || 0));
            const cantidades = splitCantidades(total, pagadores.length);
            const esConjunto = pagadores.length > 1;
            const fechaOperacion = String(mov.fechaOperacion || item.fechaOperacion || '');
            const mesCubierto = fechaOperacion.slice(0, 7);
            const fechaIso = new Date(`${fechaOperacion}T12:00:00`).toISOString();

            const movimiento = await client.query(
              `INSERT INTO importaciones_banco_movimientos (
                 import_id, linea_csv, fecha_operacion, importe, tipo_movimiento,
                 concepto_raw, ordenante_raw, referencia_raw, categoria, subcategoria,
                 tipo_origen, estado_origen, moneda, huella_movimiento,
                 alumno_id_sugerido, alumno_id_confirmado, confianza_match, motivo_match,
                 estado_match, es_duplicado
               ) VALUES (
                 $1,$2,$3,$4,'ingreso',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false
               ) RETURNING id`,
              [
                importId,
                item.lineaCsv ?? null,
                fechaOperacion,
                total,
                mov.concepto || item.concepto || '',
                mov.ordenante || null,
                mov.referencia || null,
                mov.categoria || null,
                mov.subcategoria || null,
                mov.tipoOrigen || null,
                mov.estadoOrigen || null,
                mov.moneda || 'EUR',
                huella,
                item.alumnoIdSugerido || null,
                pagadores[0],
                item.score ?? null,
                item.motivoMatch || null,
                item.estadoMatch || 'confirmado',
              ]
            );
            const movimientoId = movimiento.rows[0].id;

            for (let i = 0; i < pagadores.length; i += 1) {
              const huellaPago = i === 0 ? huella : `${huella}#${i + 1}`;
              const cantidad = cantidades[i];
              const pago = await client.query(
                `INSERT INTO pagos (
                   alumno_id, cantidad, tipo_pago, mes_cubierto, metodo, fecha_pago,
                   origen_registro, huella_movimiento, importacion_movimiento_id, clases_cubiertas
                 ) VALUES (
                   $1,$2,'mensual',$3,'transferencia',$4,'import_csv',$5,$6,$7
                 ) RETURNING id`,
                [
                  pagadores[i],
                  cantidad,
                  mesCubierto,
                  fechaIso,
                  huellaPago,
                  i === 0 ? movimientoId : null,
                  esConjunto
                    ? `Pago conjunto (${cantidad} EUR de ${total} EUR; ${pagadores.length} pagadores)`
                    : null,
                ]
              );
              if (i === 0) {
                await client.query(
                  `UPDATE importaciones_banco_movimientos
                   SET pago_id_creado = $1 WHERE id = $2`,
                  [pago.rows[0].id, movimientoId]
                );
              }
              creados += 1;
            }
          }

          await client.query(
            `UPDATE importaciones_banco
             SET total_creadas_en_pagos = $1, total_aceptadas = $2
             WHERE id = $3`,
            [creados, movimientos.length, importId]
          );

          await client.query('COMMIT');
          return { importId, creados };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });

      res.status(201).json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountDomainImportacion };
