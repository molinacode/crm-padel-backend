const { query } = require('./db');
const { requireUser } = require('./session');

const MESES_ES = {
  '01': 'Enero',
  '02': 'Febrero',
  '03': 'Marzo',
  '04': 'Abril',
  '05': 'Mayo',
  '06': 'Junio',
  '07': 'Julio',
  '08': 'Agosto',
  '09': 'Septiembre',
  '10': 'Octubre',
  '11': 'Noviembre',
  '12': 'Diciembre',
};

const MESES_NOMBRE = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

function normalizarMes(mesCubierto) {
  if (!mesCubierto) return null;
  const raw = String(mesCubierto).trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw.slice(0, 7);
  const partes = raw.toLowerCase().split(/\s+/);
  if (partes.length >= 2) {
    const mesNum = MESES_NOMBRE[partes[0]];
    const año = partes[partes.length - 1];
    if (mesNum && /^\d{4}$/.test(año)) return `${año}-${mesNum}`;
  }
  return null;
}

function formatearMes(mes) {
  const n = normalizarMes(mes) || String(mes || '').trim();
  if (!/^\d{4}-\d{2}$/.test(n)) return String(mes || '-');
  const [año, m] = n.split('-');
  return MESES_ES[m] ? `${MESES_ES[m]} ${año}` : n;
}

function mesesDelRango(inicio, fin) {
  const out = [];
  let year = Number(String(inicio).slice(0, 4));
  let month = Number(String(inicio).slice(5, 7));
  const endYear = Number(String(fin).slice(0, 4));
  const endMonth = Number(String(fin).slice(5, 7));
  if (!year || !month || !endYear || !endMonth) return out;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function pagoCubreMes(pago, mes) {
  if (pago.tipo_pago === 'mensual') {
    return normalizarMes(pago.mes_cubierto) === mes;
  }
  if (pago.tipo_pago === 'clases' && pago.fecha_inicio) {
    const ini = String(pago.fecha_inicio).slice(0, 7);
    const fin = String(pago.fecha_fin || pago.fecha_inicio).slice(0, 7);
    return ini <= mes && mes <= fin;
  }
  return false;
}

function ultimoDiaMes(mes) {
  const year = Number(mes.slice(0, 4));
  const month = Number(mes.slice(5, 7));
  const last = new Date(year, month, 0).getDate();
  return `${mes}-${String(last).padStart(2, '0')}`;
}

function mesSolapaPeriodoAlta(mes, periodos) {
  if (!periodos.length) return false;
  const mesIni = `${mes}-01`;
  const mesFin = ultimoDiaMes(mes);
  return periodos.some(p => {
    const ini = String(p.fecha_inicio).slice(0, 10);
    const fin = p.fecha_fin ? String(p.fecha_fin).slice(0, 10) : '9999-12-31';
    return ini <= mesFin && fin >= mesIni;
  });
}

function esAlumnoActivo(alumno, hoy) {
  if (alumno.activo === false) return false;
  if (!alumno.fecha_baja) {
    return alumno.activo === true || alumno.activo == null;
  }
  const baja = new Date(alumno.fecha_baja);
  baja.setHours(0, 0, 0, 0);
  const f = new Date(hoy);
  f.setHours(0, 0, 0, 0);
  return f < baja;
}

function periodosEfectivos(alumno, periodos, hoyIso) {
  if (periodos.length > 0) return periodos;
  if (alumno.activo === false || alumno.fecha_baja) {
    return [
      {
        alumno_id: alumno.id,
        fecha_inicio: '2000-01-01',
        fecha_fin: alumno.fecha_baja
          ? String(alumno.fecha_baja).slice(0, 10)
          : hoyIso,
      },
    ];
  }
  return [{ alumno_id: alumno.id, fecha_inicio: '2000-01-01', fecha_fin: null }];
}

async function calcularAlumnosConDeuda() {
  const [
    cursosRes,
    alumnosRes,
    pagosRes,
    asignacionesRes,
    clasesRes,
    eventosRes,
  ] = await Promise.all([
    query(`SELECT id, nombre, fecha_inicio, fecha_fin, estado FROM cursos`),
    query(`SELECT id, nombre, activo, fecha_baja FROM alumnos`),
    query(
      `SELECT alumno_id, tipo_pago, mes_cubierto, fecha_inicio, fecha_fin FROM pagos`
    ),
    query(
      `SELECT alumno_id, clase_id, origen, tipo_asignacion FROM alumnos_clases`
    ),
    query(`SELECT id, curso_id FROM clases`),
    query(`SELECT clase_id, fecha, estado FROM eventos_clase`),
  ]);

  let periodosAll = [];
  try {
    const periodosRes = await query(
      `SELECT alumno_id, fecha_inicio, fecha_fin FROM alumno_periodos`
    );
    periodosAll = periodosRes.rows || [];
  } catch (err) {
    console.warn('[deudas] alumno_periodos no disponible', err.message);
  }

  const cursos = cursosRes.rows || [];
  const alumnos = alumnosRes.rows || [];
  const pagos = pagosRes.rows || [];
  const asignaciones = asignacionesRes.rows || [];
  const clases = clasesRes.rows || [];
  const eventos = eventosRes.rows || [];

  const periodosPorAlumno = new Map();
  periodosAll.forEach(p => {
    const lista = periodosPorAlumno.get(p.alumno_id) || [];
    lista.push(p);
    periodosPorAlumno.set(p.alumno_id, lista);
  });

  const cursoPorClase = new Map();
  clases.forEach(c => {
    if (c.curso_id) cursoPorClase.set(c.id, c.curso_id);
  });

  const hoy = new Date();
  const hoyIso = hoy.toISOString().slice(0, 10);
  const mesActual = hoyIso.slice(0, 7);

  const primerEventoPasadoPorClaseMes = new Map();
  eventos.forEach(ev => {
    if (!ev.clase_id || !ev.fecha) return;
    if (ev.estado === 'cancelada' || ev.estado === 'eliminado') return;
    const fecha = String(ev.fecha).slice(0, 10);
    if (fecha > hoyIso) return;
    const mes = fecha.slice(0, 7);
    const key = `${ev.clase_id}|${mes}`;
    const prev = primerEventoPasadoPorClaseMes.get(key);
    if (!prev || fecha < prev) primerEventoPasadoPorClaseMes.set(key, fecha);
  });

  const asignacionesEscuela = asignaciones.filter(a => {
    if (!a.clase_id) return false;
    const permanente = !a.tipo_asignacion || a.tipo_asignacion === 'permanente';
    const escuela = !a.origen || a.origen === 'escuela';
    return permanente && escuela;
  });

  const pagosPorAlumno = new Map();
  pagos.forEach(p => {
    if (!p.alumno_id) return;
    const lista = pagosPorAlumno.get(p.alumno_id) || [];
    lista.push(p);
    pagosPorAlumno.set(p.alumno_id, lista);
  });

  const resultado = [];

  alumnos.forEach(alumno => {
    if (!alumno.id) return;
    const suyas = asignacionesEscuela.filter(a => a.alumno_id === alumno.id);
    if (!suyas.length) return;

    const periodos = periodosEfectivos(
      alumno,
      periodosPorAlumno.get(alumno.id) || [],
      hoyIso
    );

    const meses = [];
    cursos.forEach(curso => {
      const inicio = String(curso.fecha_inicio).slice(0, 10);
      const fin = String(curso.fecha_fin).slice(0, 10);
      mesesDelRango(inicio, fin).forEach(mes => {
        if (mes > mesActual) return;
        if (!mesSolapaPeriodoAlta(mes, periodos)) return;

        let fechaGeneracion = null;
        const tuvoClase = suyas.some(a => {
          if (cursoPorClase.get(a.clase_id) !== curso.id) return false;
          const primera = primerEventoPasadoPorClaseMes.get(`${a.clase_id}|${mes}`);
          if (!primera) return false;
          if (!fechaGeneracion || primera < fechaGeneracion) fechaGeneracion = primera;
          return true;
        });
        if (!tuvoClase || !fechaGeneracion) return;
        const cubierto = (pagosPorAlumno.get(alumno.id) || []).some(p =>
          pagoCubreMes(p, mes)
        );
        if (cubierto) return;
        meses.push({
          mes,
          fechaGeneracion,
          cursoId: curso.id,
          cursoNombre: curso.nombre,
          etiqueta: formatearMes(mes),
        });
      });
    });

    if (!meses.length) return;
    meses.sort((a, b) => a.mes.localeCompare(b.mes));
    const inicioMes = new Date(`${meses[0].mes}-01T00:00:00`);
    const diasSinPagar = Math.max(
      0,
      Math.floor((hoy.getTime() - inicioMes.getTime()) / 86400000)
    );
    resultado.push({
      id: alumno.id,
      nombre: alumno.nombre || 'Sin nombre',
      baja: !esAlumnoActivo(alumno, hoy),
      meses,
      diasSinPagar,
      mesReferencia: meses.map(m => m.etiqueta).join(', '),
      deudaTotal: 0,
    });
  });

  resultado.sort(
    (a, b) => b.meses.length - a.meses.length || a.nombre.localeCompare(b.nombre)
  );
  return { count: resultado.length, alumnos: resultado };
}

function mountDomainDeudas(app) {
  app.get('/api/deudas', requireUser, async (_req, res) => {
    try {
      const data = await calcularAlumnosConDeuda();
      res.json({ data });
    } catch (error) {
      console.error('[deudas]', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });
}

module.exports = { mountDomainDeudas, calcularAlumnosConDeuda };
