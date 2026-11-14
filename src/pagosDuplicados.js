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

/** Ventana (días) entre fecha de pago manual y fecha del banco para considerarlos el mismo cobro. */
const DIAS_VENTANA_DUPLICADO = 10;
const MAX_MESES_OPERACION = 12;

function normalizarMes(raw) {
  if (!raw) return null;
  const txt = String(raw).trim();
  if (/^\d{4}-\d{2}/.test(txt)) return txt.slice(0, 7);
  const partes = txt.toLowerCase().split(/\s+/);
  if (partes.length >= 2) {
    const mes = MESES_NOMBRE[partes[0]];
    const anio = partes[partes.length - 1];
    if (mes && /^\d{4}$/.test(anio)) return `${anio}-${mes}`;
  }
  return null;
}

function mesesConsecutivos(desde, n) {
  const ini = normalizarMes(desde);
  if (!ini) return [];
  let year = Number(ini.slice(0, 4));
  let month = Number(ini.slice(5, 7));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function parseNumMeses(raw) {
  const n = Math.trunc(Number(raw || 1));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_MESES_OPERACION);
}

/** Reparte un total en n partes en céntimos; la última absorbe el redondeo. */
function repartirImporte(total, n) {
  if (n <= 1) return [Math.round(Number(total) * 100) / 100];
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] += cents - base * n;
  return parts.map(c => c / 100);
}

function fechaDia(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function diasEntre(a, b) {
  const fa = fechaDia(a);
  const fb = fechaDia(b);
  if (!fa || !fb) return null;
  return Math.round(
    (Date.parse(`${fb}T12:00:00Z`) - Date.parse(`${fa}T12:00:00Z`)) / 86400000
  );
}

/**
 * ¿Pueden ser el mismo cobro? Mismo alumno e importe, y mismo mes cubierto
 * o fechas de pago a menos de DIAS_VENTANA_DUPLICADO días.
 */
function compararPagos(a, b) {
  if (!a.alumno_id || a.alumno_id !== b.alumno_id) return null;
  if (Math.abs(Number(a.cantidad || 0) - Number(b.cantidad || 0)) >= 0.01) return null;
  const mesA = a.tipo_pago === 'mensual' ? normalizarMes(a.mes_cubierto) : null;
  const mesB = b.tipo_pago === 'mensual' ? normalizarMes(b.mes_cubierto) : null;
  const mismoMes = Boolean(mesA && mesA === mesB);
  const dias = diasEntre(a.fecha_pago, b.fecha_pago);
  const cerca = dias != null && Math.abs(dias) <= DIAS_VENTANA_DUPLICADO;
  if (!mismoMes && !cerca) return null;
  return {
    mismoMes,
    dias,
    coste: (mismoMes ? 0 : 100) + Math.abs(dias ?? DIAS_VENTANA_DUPLICADO),
  };
}

function claveParDescartado(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Empareja cada pago no importado (manual/api) con como mucho un pago
 * importado del banco, priorizando mismo mes y fechas más cercanas.
 */
function emparejarDuplicados(pagos, descartados = new Set()) {
  const importados = pagos.filter(p => p.origen_registro === 'import_csv');
  const otros = pagos.filter(p => p.origen_registro !== 'import_csv');
  const porAlumno = new Map();
  for (const p of importados) {
    const lista = porAlumno.get(p.alumno_id) || [];
    lista.push(p);
    porAlumno.set(p.alumno_id, lista);
  }

  const candidatos = [];
  for (const m of otros) {
    for (const i of porAlumno.get(m.alumno_id) || []) {
      if (descartados.has(claveParDescartado(m.id, i.id))) continue;
      const cmp = compararPagos(m, i);
      if (cmp) candidatos.push({ manual: m, importado: i, ...cmp });
    }
  }
  candidatos.sort((x, y) => x.coste - y.coste);

  const usados = new Set();
  const pares = [];
  for (const c of candidatos) {
    if (usados.has(c.manual.id) || usados.has(c.importado.id)) continue;
    usados.add(c.manual.id);
    usados.add(c.importado.id);
    pares.push(c);
  }
  return pares;
}

module.exports = {
  DIAS_VENTANA_DUPLICADO,
  MAX_MESES_OPERACION,
  normalizarMes,
  mesesConsecutivos,
  parseNumMeses,
  repartirImporte,
  diasEntre,
  compararPagos,
  claveParDescartado,
  emparejarDuplicados,
};
