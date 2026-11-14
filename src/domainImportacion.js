const crypto = require('crypto');
const { withClient } = require('./db');
const { requireAdmin } = require('./authz');
const {
  normalizarMes,
  mesesConsecutivos,
  parseNumMeses,
  repartirImporte,
} = require('./pagosDuplicados');

function describirOperacion(total, pagadores, meses) {
  const partes = [];
  if (meses > 1) partes.push(`${meses} meses`);
  if (pagadores > 1) partes.push(`${pagadores} pagadores`);
  if (!partes.length) return null;
  return `Operación de ${total} EUR (${partes.join(', ')})`;
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
    for (const item of movimientos) {
      if (!String(item.huella || item.movimiento?.huella || '')) {
        return res.status(400).json({ error: 'Cada movimiento necesita huella' });
      }
    }

    try {
      const result = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const huellas = movimientos.map(i => String(i.huella || i.movimiento?.huella));
          const previas = await client.query(
            `SELECT huella_movimiento FROM pagos WHERE huella_movimiento = ANY($1::text[])
             UNION
             SELECT huella_movimiento FROM importaciones_banco_movimientos
              WHERE huella_movimiento = ANY($1::text[])`,
            [huellas]
          );
          const yaImportadas = new Set(previas.rows.map(r => r.huella_movimiento));

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
          let aceptados = 0;
          let duplicados = 0;
          let sustituidos = 0;

          for (const item of movimientos) {
            const mov = item.movimiento || {};
            const pagadores = Array.isArray(item.pagadores)
              ? [...new Set(item.pagadores.map(String).filter(Boolean))]
              : item.alumnoId
                ? [String(item.alumnoId)]
                : [];
            if (!pagadores.length) continue;

            const huella = String(item.huella || mov.huella);
            if (yaImportadas.has(huella)) {
              duplicados += 1;
              continue;
            }
            yaImportadas.add(huella);

            const total = Math.abs(Number(mov.importe || item.importe || 0));
            const fechaOperacion = String(mov.fechaOperacion || item.fechaOperacion || '');
            const numMeses = parseNumMeses(item.meses);
            const mesDesde = normalizarMes(item.mesDesde) || fechaOperacion.slice(0, 7);
            const meses = mesesConsecutivos(mesDesde, numMeses);
            const fechaIso = new Date(`${fechaOperacion}T12:00:00`).toISOString();
            const porPagador = repartirImporte(total, pagadores.length);
            const nota = describirOperacion(total, pagadores.length, meses.length);
            const operacionId =
              pagadores.length * meses.length > 1 ? crypto.randomUUID() : null;

            const sustituir = Array.isArray(item.sustituirPagoIds)
              ? item.sustituirPagoIds.map(String).filter(Boolean)
              : [];
            if (sustituir.length) {
              const borrados = await client.query(
                `DELETE FROM pagos
                  WHERE id = ANY($1::uuid[])
                    AND origen_registro <> 'import_csv'
                    AND alumno_id = ANY($2::uuid[])`,
                [sustituir, pagadores]
              );
              sustituidos += borrados.rowCount;
            }

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
                item.estadoMatch || 'aceptado',
              ]
            );
            const movimientoId = movimiento.rows[0].id;
            aceptados += 1;

            // Orden pagador→mes: con un solo mes, las huellas #2/#3 coinciden con las de antes.
            let k = 0;
            for (let i = 0; i < pagadores.length; i += 1) {
              const cantidades = repartirImporte(porPagador[i], meses.length);
              for (let j = 0; j < meses.length; j += 1) {
                const huellaPago = k === 0 ? huella : `${huella}#${k + 1}`;
                const pago = await client.query(
                  `INSERT INTO pagos (
                     alumno_id, cantidad, tipo_pago, mes_cubierto, metodo, fecha_pago,
                     origen_registro, huella_movimiento, importacion_movimiento_id,
                     clases_cubiertas, operacion_id
                   ) VALUES (
                     $1,$2,'mensual',$3,'transferencia',$4,'import_csv',$5,$6,$7,$8
                   ) RETURNING id`,
                  [
                    pagadores[i],
                    cantidades[j],
                    meses[j],
                    fechaIso,
                    huellaPago,
                    k === 0 ? movimientoId : null,
                    nota,
                    operacionId,
                  ]
                );
                if (k === 0) {
                  await client.query(
                    `UPDATE importaciones_banco_movimientos
                     SET pago_id_creado = $1 WHERE id = $2`,
                    [pago.rows[0].id, movimientoId]
                  );
                }
                creados += 1;
                k += 1;
              }
            }
          }

          if (!aceptados) {
            const err = new Error('Todos los movimientos seleccionados ya estaban importados.');
            err.status = 409;
            throw err;
          }

          await client.query(
            `UPDATE importaciones_banco
             SET total_creadas_en_pagos = $1, total_aceptadas = $2,
                 total_duplicadas = total_duplicadas + $3
             WHERE id = $4`,
            [creados, aceptados, duplicados, importId]
          );

          await client.query('COMMIT');
          return { importId, creados, aceptados, duplicados, sustituidos };
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
