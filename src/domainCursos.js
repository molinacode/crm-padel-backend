const { withClient } = require('./db');
const { requireAdmin } = require('./authz');

const DIAS = {
  Domingo: 0,
  Lunes: 1,
  Martes: 2,
  Miércoles: 3,
  Miercoles: 3,
  Jueves: 4,
  Viernes: 5,
  Sábado: 6,
  Sabado: 6,
};

function fechasDeClase(inicio, fin, diaSemana) {
  const dia = DIAS[diaSemana];
  if (dia === undefined) return [];
  const fechas = [];
  const cursor = new Date(`${inicio}T00:00:00`);
  const limite = new Date(`${fin}T00:00:00`);
  while (cursor <= limite) {
    if (cursor.getDay() === dia) {
      const mes = String(cursor.getMonth() + 1).padStart(2, '0');
      const diaMes = String(cursor.getDate()).padStart(2, '0');
      fechas.push(`${cursor.getFullYear()}-${mes}-${diaMes}`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return fechas;
}

function esAlumnoActivo(alumno) {
  if (!alumno) return false;
  if (alumno.activo === false) return false;
  if (alumno.fecha_baja) return false;
  return true;
}

function mountDomainCursos(app) {
  app.post('/api/cursos/abrir', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const nombre = String(body.nombre || '').trim();
    const fechaInicio = String(body.fechaInicio || '');
    const fechaFin = String(body.fechaFin || '');
    const claseIds = Array.isArray(body.claseIds) ? body.claseIds.map(String) : [];

    if (!nombre) return res.status(400).json({ error: 'El curso necesita un nombre' });
    if (!fechaInicio || !fechaFin || fechaInicio > fechaFin) {
      return res.status(400).json({ error: 'Las fechas del curso no son validas' });
    }

    try {
      const cursoId = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const abierto = await client.query(
            `SELECT id FROM cursos WHERE estado = 'abierto' LIMIT 1 FOR UPDATE`
          );
          if (abierto.rows[0]) {
            const err = new Error('Cierra el curso abierto antes de abrir otro');
            err.status = 409;
            throw err;
          }

          const solapa = await client.query(
            `SELECT id FROM cursos
             WHERE NOT ($1 < fecha_inicio OR $2 > fecha_fin)
             LIMIT 1`,
            [fechaFin, fechaInicio]
          );
          if (solapa.rows[0]) {
            const err = new Error('Las fechas se solapan con otro curso');
            err.status = 409;
            throw err;
          }

          const creado = await client.query(
            `INSERT INTO cursos (nombre, fecha_inicio, fecha_fin, estado)
             VALUES ($1, $2, $3, 'abierto')
             RETURNING id`,
            [nombre, fechaInicio, fechaFin]
          );
          const nuevoCursoId = creado.rows[0].id;

          if (claseIds.length === 0) {
            await client.query('COMMIT');
            return nuevoCursoId;
          }

          const origenes = await client.query(
            `SELECT id, nombre, dia_semana, hora_inicio, hora_fin, nivel_clase, profesor,
                    tipo_clase, observaciones, capacidad_maxima, instalacion_id, recurrencia,
                    contabiliza_como
             FROM clases WHERE id = ANY($1::uuid[])`,
            [claseIds]
          );

          for (const clase of origenes.rows) {
            const nueva = await client.query(
              `INSERT INTO clases (
                 nombre, dia_semana, hora_inicio, hora_fin, nivel_clase, profesor,
                 tipo_clase, observaciones, capacidad_maxima, instalacion_id, recurrencia,
                 contabiliza_como, fecha_inicio, fecha_fin, curso_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               RETURNING id`,
              [
                clase.nombre,
                clase.dia_semana,
                clase.hora_inicio,
                clase.hora_fin,
                clase.nivel_clase,
                clase.profesor,
                clase.tipo_clase,
                clase.observaciones,
                clase.capacidad_maxima,
                clase.instalacion_id,
                clase.recurrencia,
                clase.contabiliza_como,
                fechaInicio,
                fechaFin,
                nuevoCursoId,
              ]
            );
            const nuevaId = nueva.rows[0].id;

            const asignaciones = await client.query(
              `SELECT ac.alumno_id, ac.tipo_asignacion, ac.origen,
                      a.activo, a.fecha_baja
               FROM alumnos_clases ac
               JOIN alumnos a ON a.id = ac.alumno_id
               WHERE ac.clase_id = $1`,
              [clase.id]
            );

            const copias = [];
            for (const asignacion of asignaciones.rows) {
              const permanente =
                !asignacion.tipo_asignacion || asignacion.tipo_asignacion === 'permanente';
              const escuela = !asignacion.origen || asignacion.origen === 'escuela';
              if (
                !permanente ||
                !escuela ||
                !esAlumnoActivo({
                  activo: asignacion.activo,
                  fecha_baja: asignacion.fecha_baja,
                })
              ) {
                continue;
              }
              copias.push([asignacion.alumno_id, nuevaId, 'escuela', 'permanente']);
            }
            if (copias.length) {
              const values = [];
              const params = [];
              copias.forEach((row, i) => {
                const base = i * 4;
                values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
                params.push(...row);
              });
              await client.query(
                `INSERT INTO alumnos_clases (alumno_id, clase_id, origen, tipo_asignacion)
                 VALUES ${values.join(',')}`,
                params
              );
            }

            const fechas = fechasDeClase(fechaInicio, fechaFin, clase.dia_semana);
            if (fechas.length && clase.hora_inicio && clase.hora_fin) {
              const values = [];
              const params = [];
              fechas.forEach((fecha, i) => {
                const base = i * 4;
                values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
                params.push(nuevaId, fecha, clase.hora_inicio, clase.hora_fin);
              });
              await client.query(
                `INSERT INTO eventos_clase (clase_id, fecha, hora_inicio, hora_fin)
                 VALUES ${values.join(',')}`,
                params
              );
            }
          }

          await client.query('COMMIT');
          return nuevoCursoId;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });

      res.status(201).json({ id: cursoId });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/cursos/reabrir', requireAdmin, async (req, res) => {
    const cursoId = String((req.body || {}).cursoId || '').trim();
    if (!cursoId) {
      return res.status(400).json({ error: 'Falta el curso a reabrir' });
    }

    try {
      const reabierto = await withClient(async client => {
        await client.query('BEGIN');
        try {
          const objetivo = await client.query(
            `SELECT id, nombre, estado FROM cursos WHERE id = $1 FOR UPDATE`,
            [cursoId]
          );
          const curso = objetivo.rows[0];
          if (!curso) {
            const err = new Error('No se encontró el curso');
            err.status = 404;
            throw err;
          }
          if (curso.estado === 'abierto') {
            await client.query('COMMIT');
            return { id: curso.id, yaAbierto: true };
          }

          const abiertos = await client.query(
            `SELECT id, nombre FROM cursos WHERE estado = 'abierto' FOR UPDATE`
          );
          for (const abierto of abiertos.rows) {
            await client.query(`UPDATE cursos SET estado = 'cerrado' WHERE id = $1`, [
              abierto.id,
            ]);
          }

          await client.query(`UPDATE cursos SET estado = 'abierto' WHERE id = $1`, [cursoId]);
          await client.query('COMMIT');
          return {
            id: cursoId,
            yaAbierto: false,
            cerrados: abiertos.rows.map(row => row.id),
          };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });

      res.status(200).json(reabierto);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountDomainCursos };
