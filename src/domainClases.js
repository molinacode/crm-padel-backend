const { withClient } = require('./db');
const { requireAdmin } = require('./authz');
const { requireUser } = require('./session');

/**
 * Cascade atómico al borrar una clase (C2).
 * Orden: hijos → clase. Tablas sin FK se limpian explícitamente.
 */
function mountDomainClases(app) {
  app.delete(
    '/api/clases/:id',
    requireUser,
    requireAdmin,
    async (req, res) => {
      try {
        const id = String(req.params.id || '');
        if (!id) return res.status(400).json({ error: 'id obligatorio' });

        const deleted = await withClient(async client => {
          await client.query('BEGIN');
          try {
            const exists = await client.query(
              `SELECT id, nombre FROM clases WHERE id = $1 FOR UPDATE`,
              [id]
            );
            if (!exists.rows[0]) {
              const err = new Error('Clase no encontrada');
              err.status = 404;
              throw err;
            }

            // Dependientes conocidos (idempotente si la tabla no existe en installs viejos).
            const limpia = async sql => {
              try {
                await client.query(sql, [id]);
              } catch (e) {
                if (e.code !== '42P01') throw e;
              }
            };

            await limpia(`DELETE FROM asistencias WHERE clase_id = $1`);
            await limpia(`DELETE FROM recuperaciones_clase WHERE clase_id = $1`);
            await limpia(`DELETE FROM pagos_clases_internas WHERE clase_id = $1`);
            await limpia(`DELETE FROM clases_ejercicios WHERE clase_id = $1`);
            await limpia(`DELETE FROM tematicas_clase WHERE clase_id = $1`);
            await limpia(`DELETE FROM liberaciones_plaza WHERE clase_id = $1`);
            await limpia(
              `UPDATE grupos SET clase_id = NULL WHERE clase_id = $1`
            );
            await limpia(`DELETE FROM alumnos_clases WHERE clase_id = $1`);
            await limpia(`DELETE FROM eventos_clase WHERE clase_id = $1`);

            const del = await client.query(
              `DELETE FROM clases WHERE id = $1 RETURNING id, nombre`,
              [id]
            );
            await client.query('COMMIT');
            return del.rows[0];
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });

        res.json({ data: deleted, ok: true });
      } catch (error) {
        console.error('[clases] delete', error);
        res.status(error.status || 500).json({ error: error.message || 'Error' });
      }
    }
  );
}

module.exports = { mountDomainClases };
