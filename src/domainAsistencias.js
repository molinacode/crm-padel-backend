const { query, withClient } = require('./db');
const { requireUser } = require('./session');

const ESTADOS = new Set([
  'asistio',
  'falta',
  'justificada',
  'lesionado',
  'recuperacion',
]);

function mountDomainAsistencias(app) {
  /**
   * Upsert de asistencia + lógica de recuperación.
   * La sincronización de plazas (liberar/restaurar) sigue en el cliente por ahora.
   */
  app.post('/api/asistencias/marcar', requireUser, async (req, res) => {
    try {
      const body = req.body || {};
      const claseId = String(body.clase_id || '');
      const alumnoId = String(body.alumno_id || '');
      const fecha = String(body.fecha || '').slice(0, 10);
      const estadoRaw = String(body.estado || '');
      if (!claseId || !alumnoId || !fecha || !ESTADOS.has(estadoRaw)) {
        return res.status(400).json({
          error: 'clase_id, alumno_id, fecha y estado válidos son obligatorios',
        });
      }

      const cursoRes = await query(
        `SELECT c.estado AS curso_estado
         FROM clases cl
         LEFT JOIN cursos c ON c.id = cl.curso_id
         WHERE cl.id = $1`,
        [claseId]
      );
      if (cursoRes.rows[0]?.curso_estado === 'cerrado') {
        return res.status(403).json({
          error: 'Este curso está cerrado. La lista se consulta, no se modifica.',
          cerrado: true,
        });
      }

      const estadoFinal = estadoRaw === 'recuperacion' ? 'asistio' : estadoRaw;

      const result = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const existente = await client.query(
            `SELECT id FROM asistencias
             WHERE alumno_id = $1 AND clase_id = $2 AND fecha = $3
             LIMIT 1`,
            [alumnoId, claseId, fecha]
          );

          let asistencia;
          if (existente.rows[0]) {
            const upd = await client.query(
              `UPDATE asistencias SET estado = $2 WHERE id = $1 RETURNING *`,
              [existente.rows[0].id, estadoFinal]
            );
            asistencia = upd.rows[0];
          } else {
            const ins = await client.query(
              `INSERT INTO asistencias (alumno_id, clase_id, fecha, estado)
               VALUES ($1,$2,$3,$4)
               RETURNING *`,
              [alumnoId, claseId, fecha, estadoFinal]
            );
            asistencia = ins.rows[0];
          }

          let recuperacion = null;
          let mensaje = null;

          if (estadoRaw === 'recuperacion') {
            const pend = await client.query(
              `SELECT id FROM recuperaciones_clase
               WHERE alumno_id = $1 AND estado = 'pendiente'
               ORDER BY fecha_falta ASC
               LIMIT 1`,
              [alumnoId]
            );
            if (pend.rows[0]) {
              const upd = await client.query(
                `UPDATE recuperaciones_clase
                 SET estado = 'recuperada',
                     fecha_recuperacion = $2,
                     observaciones = 'Marcada como recuperación desde asistencias',
                     updated_at = now()
                 WHERE id = $1
                 RETURNING *`,
                [pend.rows[0].id, fecha]
              );
              recuperacion = upd.rows[0];
              mensaje =
                'Recuperación registrada y asistencia marcada como asistió';
            } else {
              const falta = await client.query(
                `SELECT id, fecha FROM asistencias
                 WHERE alumno_id = $1 AND estado = 'justificada'
                 ORDER BY fecha ASC
                 LIMIT 1`,
                [alumnoId]
              );
              if (falta.rows[0]) {
                const created = await client.query(
                  `INSERT INTO recuperaciones_clase (
                     alumno_id, clase_id, falta_justificada_id, fecha_falta,
                     fecha_recuperacion, estado, observaciones, tipo_recuperacion, updated_at
                   ) VALUES ($1,$2,$3,$4,$5,'recuperada',$6,'automatica', now())
                   RETURNING *`,
                  [
                    alumnoId,
                    claseId,
                    falta.rows[0].id,
                    falta.rows[0].fecha,
                    fecha,
                    'Creada automáticamente desde falta justificada y marcada como recuperada',
                  ]
                );
                recuperacion = created.rows[0];
                mensaje =
                  'Recuperación creada desde falta justificada y registrada';
              } else {
                mensaje =
                  'No hay faltas justificadas pendientes. Se registró como asistió.';
              }
            }
          }

          await client.query('COMMIT');
          return { asistencia, recuperacion, mensaje, estado_solicitado: estadoRaw };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });

      res.json({ data: result });
    } catch (error) {
      console.error('[asistencias] marcar', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });
}

module.exports = { mountDomainAsistencias };
