const { query } = require('./db');
const { requireUser } = require('./session');
const { calcularAlumnosConDeuda } = require('./domainDeudas');

function rangoSemanaISO(d = new Date()) {
  const day = d.getDay() || 7;
  const lunes = new Date(d);
  lunes.setDate(d.getDate() - day + 1);
  lunes.setHours(0, 0, 0, 0);
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  return {
    lunes: lunes.toISOString().slice(0, 10),
    domingo: domingo.toISOString().slice(0, 10),
  };
}

function mountDomainDashboard(app) {
  app.get('/api/dashboard/stats', requireUser, async (req, res) => {
    try {
      const periodo = req.query?.periodo === 'anio' ? 'anio' : 'mes';
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      const hoyISO = hoy.toISOString().slice(0, 10);
      const finAsist = new Date(hoy);
      finAsist.setDate(finAsist.getDate() + 30);
      const finAsistISO = finAsist.toISOString().slice(0, 10);
      const { lunes, domingo } = rangoSemanaISO(hoy);

      const [
        alumnosRes,
        pagosRes,
        clasesRes,
        asignadosRes,
        eventosRes,
        asistenciasRes,
        profesoresRes,
        liberacionesRes,
        deudas,
      ] = await Promise.all([
        query(`SELECT id, nombre, activo, fecha_baja FROM alumnos`),
        query(
          `SELECT p.id, p.cantidad, p.mes_cubierto, p.fecha_pago, p.alumno_id,
                  a.nombre AS alumno_nombre
           FROM pagos p
           LEFT JOIN alumnos a ON a.id = p.alumno_id`
        ),
        query(
          `SELECT id, nombre, nivel_clase, dia_semana, tipo_clase, profesor
           FROM clases`
        ),
        query(`SELECT clase_id FROM alumnos_clases`),
        query(
          `SELECT ec.id, ec.fecha, ec.hora_inicio, ec.estado, ec.clase_id,
                  c.nombre AS clase_nombre, c.tipo_clase, c.nivel_clase, c.dia_semana
           FROM eventos_clase ec
           LEFT JOIN clases c ON c.id = ec.clase_id
           WHERE (ec.estado IS NULL OR ec.estado <> 'eliminado')
             AND ec.fecha >= $1 AND ec.fecha <= $2`,
          [lunes, domingo]
        ),
        query(
          `SELECT asis.id, asis.alumno_id, asis.clase_id, asis.fecha, asis.estado,
                  a.nombre AS alumno_nombre
           FROM asistencias asis
           LEFT JOIN alumnos a ON a.id = asis.alumno_id
           WHERE asis.estado IN ('justificada','falta','lesionado')
             AND asis.fecha >= $1 AND asis.fecha <= $2`,
          [hoyISO, finAsistISO]
        ),
        query(`SELECT id, nombre, activo FROM profesores`),
        query(
          `SELECT clase_id, alumno_id, fecha_inicio, fecha_fin
           FROM liberaciones_plaza
           WHERE estado = 'activa'
             AND fecha_inicio <= $1
             AND fecha_fin >= $1`,
          [hoyISO]
        ).catch(() => ({ rows: [] })),
        calcularAlumnosConDeuda(),
      ]);

      const alumnos = alumnosRes.rows || [];
      const pagos = (pagosRes.rows || []).map(p => ({
        ...p,
        alumnos: { nombre: p.alumno_nombre },
      }));
      const clases = clasesRes.rows || [];
      const asignaciones = asignadosRes.rows || [];
      const eventos = (eventosRes.rows || []).map(e => ({
        id: e.id,
        fecha: e.fecha,
        hora_inicio: e.hora_inicio,
        estado: e.estado,
        clase_id: e.clase_id,
        clases: e.clase_id
          ? {
              id: e.clase_id,
              nombre: e.clase_nombre,
              tipo_clase: e.tipo_clase,
              nivel_clase: e.nivel_clase,
              dia_semana: e.dia_semana,
            }
          : null,
      }));
      const asistencias = (asistenciasRes.rows || []).map(a => ({
        ...a,
        alumnos: { nombre: a.alumno_nombre },
      }));
      const profesores = profesoresRes.rows || [];

      const year = hoy.getFullYear();
      const mes = hoy.getMonth() + 1;
      const pagosValidos = pagos.filter(p => p.mes_cubierto && p.cantidad != null);
      const calcIngresos = (anyo, tipo) => {
        if (tipo === 'anio') {
          const pref = `${anyo}-`;
          return pagosValidos
            .filter(p => String(p.mes_cubierto).startsWith(pref))
            .reduce((acc, p) => acc + (Number(p.cantidad) || 0), 0);
        }
        const clave = `${anyo}-${String(mes).padStart(2, '0')}`;
        return pagosValidos
          .filter(p => p.mes_cubierto === clave)
          .reduce((acc, p) => acc + (Number(p.cantidad) || 0), 0);
      };

      const ingresosPeriodoActual = calcIngresos(year, periodo);
      const ingresosPeriodoAnterior = calcIngresos(year - 1, periodo);

      const ultimosPagos = [...pagos]
        .sort(
          (a, b) =>
            new Date(b.fecha_pago || 0).getTime() -
            new Date(a.fecha_pago || 0).getTime()
        )
        .slice(0, 5)
        .map(p => ({
          alumno: p.alumnos?.nombre || 'Alumno eliminado',
          cantidad: p.cantidad,
          mes: p.mes_cubierto,
          fecha: p.fecha_pago
            ? new Date(p.fecha_pago).toLocaleDateString('es-ES')
            : '',
        }));

      const asignacionesMap = {};
      asignaciones.forEach(ac => {
        if (!ac.clase_id) return;
        asignacionesMap[ac.clase_id] = (asignacionesMap[ac.clase_id] || 0) + 1;
      });

      const liberacionesPorClase = {};
      (liberacionesRes.rows || []).forEach(l => {
        if (!l.clase_id) return;
        liberacionesPorClase[l.clase_id] =
          (liberacionesPorClase[l.clase_id] || 0) + 1;
      });

      const clasesIncompletas = eventos
        .filter(evento => {
          const fechaEvento = evento.fecha ? new Date(evento.fecha) : new Date(0);
          fechaEvento.setHours(0, 0, 0, 0);
          if (fechaEvento < hoy) return false;
          if (evento.estado === 'cancelada') return false;
          const clase = clases.find(c => c.id === evento.clase_id);
          if (!clase) return false;
          const alumnosAsignados = asignacionesMap[clase.id] || 0;
          const liberacionesActivas = liberacionesPorClase[clase.id] || 0;
          const alumnosDisponibles = Math.max(
            0,
            alumnosAsignados - liberacionesActivas
          );
          const esParticular =
            (clase.nombre || '').toLowerCase().includes('particular') ||
            clase.tipo_clase === 'particular';
          const maxAlumnos = esParticular ? 1 : 4;
          return alumnosDisponibles < maxAlumnos;
        })
        .map(evento => {
          const clase = clases.find(c => c.id === evento.clase_id);
          const alumnosAsignados = asignacionesMap[clase.id] || 0;
          const liberacionesActivas = liberacionesPorClase[clase.id] || 0;
          return {
            id: evento.id,
            nombre: clase.nombre,
            nivel_clase: clase.nivel_clase,
            dia_semana: clase.dia_semana,
            tipo_clase: clase.tipo_clase,
            fecha: evento.fecha,
            alumnosAsignados,
            alumnosDisponibles: Math.max(0, alumnosAsignados - liberacionesActivas),
            liberacionesActivas,
            eventoId: evento.id,
          };
        });

      const faltasPorEvento = new Map();
      asistencias.forEach(a => {
        const key = `${a.clase_id}|${a.fecha}`;
        if (!faltasPorEvento.has(key)) faltasPorEvento.set(key, []);
        faltasPorEvento.get(key).push(a);
      });

      const huecosPorFaltas = eventos
        .filter(evento => {
          const fechaEvento = evento.fecha ? new Date(evento.fecha) : new Date(0);
          return fechaEvento >= hoy && evento.estado !== 'cancelada';
        })
        .map(evento => {
          const key = `${evento.clase_id}|${evento.fecha}`;
          const faltas = faltasPorEvento.get(key) || [];
          const clase = clases.find(c => c.id === evento.clase_id);
          const esParticular = clase?.tipo_clase === 'particular';
          const maxAlumnos = esParticular ? 1 : 4;
          const alumnosAsignados = asignacionesMap[evento.clase_id || ''] || 0;
          const liberacionesActivas =
            liberacionesPorClase[evento.clase_id || ''] || 0;
          const alumnosDisponibles = Math.max(
            0,
            alumnosAsignados - liberacionesActivas
          );
          return {
            eventoId: evento.id,
            claseId: evento.clase_id,
            nombre: clase?.nombre || 'Clase',
            nivel_clase: clase?.nivel_clase || null,
            dia_semana: clase?.dia_semana || null,
            tipo_clase: clase?.tipo_clase || null,
            fecha: evento.fecha,
            cantidadHuecos: Math.max(0, maxAlumnos - alumnosDisponibles),
            alumnosConFaltas: faltas.map(f => ({
              id: f.alumno_id,
              nombre: f.alumnos?.nombre || 'Alumno',
              estado: f.estado,
              derechoRecuperacion: f.estado === 'justificada',
            })),
            tieneFaltas: faltas.length > 0,
          };
        })
        .filter(item => item.cantidadHuecos > 0)
        .sort(
          (a, b) =>
            new Date(a.fecha || 0).getTime() - new Date(b.fecha || 0).getTime()
        );

      const clasesPorProfesor = {};
      clases.forEach(clase => {
        if (!clase.profesor) return;
        clasesPorProfesor[clase.profesor] =
          (clasesPorProfesor[clase.profesor] || 0) + 1;
      });

      res.json({
        data: {
          totalAlumnos: alumnos.length,
          ingresosMes: ingresosPeriodoActual,
          ingresosPeriodoActual,
          ingresosPeriodoAnterior,
          clasesEstaSemana: eventos.length,
          ultimosPagos,
          clasesIncompletas,
          alumnosConDeuda: deudas.count,
          huecosPorFaltas,
          totalHuecosPorFaltas: huecosPorFaltas.reduce(
            (acc, h) => acc + h.cantidadHuecos,
            0
          ),
          totalProfesores: profesores.length,
          profesoresActivos: profesores.filter(p => p.activo).length,
          clasesPorProfesor,
        },
      });
    } catch (error) {
      console.error('[dashboard] stats', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });
}

module.exports = { mountDomainDashboard };
