const { withClient } = require('./db');
const { requireAdmin } = require('./authz');

function mountDomainGrupos(app) {
  app.post('/api/grupos/:grupoId/alumnos', requireAdmin, async (req, res) => {
    const grupoId = String(req.params.grupoId || '');
    const alumnoId = String(req.body?.alumnoId || '');
    if (!grupoId || !alumnoId) {
      return res.status(400).json({ error: 'grupoId y alumnoId son obligatorios' });
    }
    try {
      const row = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const grupo = await client.query(
            'SELECT id, capacidad_maxima FROM grupos WHERE id = $1 FOR UPDATE',
            [grupoId]
          );
          if (!grupo.rows[0]) {
            const err = new Error('Grupo no encontrado');
            err.status = 404;
            throw err;
          }
          const count = await client.query(
            'SELECT COUNT(*)::int AS n FROM alumnos_grupos WHERE grupo_id = $1',
            [grupoId]
          );
          if (count.rows[0].n >= grupo.rows[0].capacidad_maxima) {
            const err = new Error(
              `Grupo lleno (capacidad maxima ${grupo.rows[0].capacidad_maxima})`
            );
            err.status = 409;
            throw err;
          }
          const inserted = await client.query(
            `INSERT INTO alumnos_grupos (grupo_id, alumno_id)
             VALUES ($1, $2)
             ON CONFLICT (grupo_id, alumno_id) DO NOTHING
             RETURNING *`,
            [grupoId, alumnoId]
          );
          // Al asignar horario deja de estar «pendiente de horario».
          await client.query(
            `UPDATE public.alumnos
             SET pendiente_horario = false, updated_at = now()
             WHERE id = $1 AND pendiente_horario = true`,
            [alumnoId]
          );
          await client.query('COMMIT');
          return inserted.rows[0] || null;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      if (!row) {
        return res.status(200).json({ data: null, alreadyMember: true });
      }
      return res.status(201).json({ data: row });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountDomainGrupos };
