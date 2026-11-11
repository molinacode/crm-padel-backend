const crypto = require('crypto');
const { query } = require('./db');
const { requireAdmin } = require('./authz');
const { normalizarTelefonoE164, nombrePila } = require('./telefono');
const { calcularAlumnosConDeuda } = require('./domainDeudas');

const TIPOS_ENLACE = new Set(['horario', 'pago']);

function publicBaseUrl() {
  return (process.env.PUBLIC_URL || 'http://localhost:5175').replace(/\/$/, '');
}

function whatsappContactE164() {
  const raw = process.env.FAMILIA_WHATSAPP_E164 || process.env.WA_CONTACT_E164 || '';
  return normalizarTelefonoE164(raw);
}

function metodosPagoConfig() {
  const bizumRaw =
    process.env.PAGO_BIZUM_TELEFONO ||
    process.env.FAMILIA_WHATSAPP_E164 ||
    process.env.WA_CONTACT_E164 ||
    '';
  const bizum = normalizarTelefonoE164(bizumRaw);
  const iban = String(process.env.PAGO_TRANSFERENCIA_IBAN || '').trim();
  const titular = String(process.env.PAGO_TRANSFERENCIA_TITULAR || 'V3 Sports').trim();
  return {
    bizum: bizum
      ? {
          // Solo dígitos nacionales en la API pública (sin +34).
          telefono_mostrar: bizum.replace(/^\+34/, '').replace(/\D/g, ''),
        }
      : null,
    transferencia: iban
      ? { iban, titular: titular || 'V3 Sports' }
      : null,
  };
}

/** Días de vida del token. Pago más corto: contiene datos bancarios. */
function ttlDiasEnlace(tipo) {
  if (tipo === 'pago') {
    const n = Number(process.env.FAMILIA_PAGO_TTL_DIAS || 45);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 45;
  }
  const n = Number(process.env.FAMILIA_HORARIO_TTL_DIAS || 90);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 730) : 90;
}

function puedeRevelarMetodosPago(alumnos) {
  if (!Array.isArray(alumnos) || alumnos.length === 0) return false;
  return alumnos.some(a => a && a.iberdrola !== true);
}

function nuevoToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function enlaceUrl(token, tipo = 'horario') {
  const path = tipo === 'pago' ? 'p' : 'h';
  return `${publicBaseUrl()}/${path}/${token}`;
}

/** wa.me hacia un destino E.164 (familia o academia). */
function waMeUrl(destinoE164, mensaje) {
  const e164 = normalizarTelefonoE164(destinoE164);
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  const text = encodeURIComponent(mensaje);
  return `https://wa.me/${digits}?text=${text}`;
}

function headersPrivacidadFamilia(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Pragma', 'no-cache');
}

function parseTipo(raw, fallback = 'horario') {
  const t = String(raw || fallback).trim();
  return TIPOS_ENLACE.has(t) ? t : null;
}

function etiquetaMesActual(fecha = new Date()) {
  const s = fecha.toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function moneyOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function horariosPorTelefono(telefonoE164) {
  const { rows } = await query(
    `
    SELECT alumno_id, alumno_nombre, grupo, dia_semana, hora_inicio, hora_fin, origen
    FROM (
      SELECT
        a.id AS alumno_id,
        a.nombre AS alumno_nombre,
        g.nombre AS grupo,
        g.dia_semana,
        left(g.hora_inicio::text, 5) AS hora_inicio,
        left(g.hora_fin::text, 5) AS hora_fin,
        'grupo'::text AS origen
      FROM public.alumnos a
      JOIN public.alumnos_grupos ag ON ag.alumno_id = a.id
      JOIN public.grupos g ON g.id = ag.grupo_id
      WHERE a.telefono_e164 = $1
        AND COALESCE(a.activo, true) = true
        AND COALESCE(g.activo, true) = true

      UNION ALL

      SELECT
        a.id AS alumno_id,
        a.nombre AS alumno_nombre,
        c.nombre AS grupo,
        c.dia_semana,
        to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio,
        to_char(c.hora_fin, 'HH24:MI') AS hora_fin,
        'clase'::text AS origen
      FROM public.alumnos a
      JOIN public.alumnos_clases ac ON ac.alumno_id = a.id
      JOIN public.clases c ON c.id = ac.clase_id
      WHERE a.telefono_e164 = $1
        AND COALESCE(a.activo, true) = true
    ) h
    ORDER BY alumno_nombre ASC NULLS LAST, dia_semana ASC NULLS LAST, hora_inicio ASC NULLS LAST
    `,
    [telefonoE164]
  );

  const bySlot = new Map();
  for (const row of rows) {
    const slotKey = [
      row.alumno_id,
      row.dia_semana || '',
      row.hora_inicio || '',
      row.hora_fin || '',
    ].join('|');
    const prev = bySlot.get(slotKey);
    if (!prev) {
      bySlot.set(slotKey, row);
      continue;
    }
    if (prev.origen === 'grupo' && row.origen === 'clase') {
      bySlot.set(slotKey, row);
    }
  }

  const byAlumno = new Map();
  for (const row of bySlot.values()) {
    if (!byAlumno.has(row.alumno_id)) {
      byAlumno.set(row.alumno_id, {
        nombre: nombrePila(row.alumno_nombre),
        horarios: [],
      });
    }
    if (row.grupo || row.dia_semana || row.hora_inicio) {
      byAlumno.get(row.alumno_id).horarios.push({
        grupo: row.grupo || 'Sin nombre',
        dia_semana: row.dia_semana || null,
        hora_inicio: row.hora_inicio || null,
        hora_fin: row.hora_fin || null,
      });
    }
  }

  const { rows: alumnosTel } = await query(
    `SELECT id, nombre
     FROM public.alumnos
     WHERE telefono_e164 = $1 AND COALESCE(activo, true) = true
     ORDER BY nombre ASC NULLS LAST`,
    [telefonoE164]
  );
  for (const a of alumnosTel) {
    if (!byAlumno.has(a.id)) {
      byAlumno.set(a.id, { nombre: nombrePila(a.nombre), horarios: [] });
    }
  }

  return [...byAlumno.values()];
}

function mesActualIso(fecha = new Date()) {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

function etiquetaMesIso(mes) {
  const [year, month] = String(mes || '').split('-');
  const y = Number(year);
  const m = Number(month);
  if (!y || !m) return etiquetaMesActual();
  return etiquetaMesActual(new Date(y, m - 1, 1));
}

function formatoImporte(n) {
  return String(n).replace('.', ',');
}

/** 4 semanas = precio_mes de la ficha. Un mes corto se prorratea. */
function precioDeMes(row, clasesMes, cuota) {
  const modalidad = row.modalidad_cobro || null;
  const precioClase = moneyOrNull(row.precio_clase);
  const precioMes = moneyOrNull(row.precio_mes);
  const iberdrola = row.iberdrola === true;
  if (iberdrola) {
    return {
      importe: null,
      nota: 'Convenio Iberdrola: el pago se gestiona por otras vías.',
    };
  }
  if (modalidad === 'mensual') {
    if (precioMes == null) {
      return { importe: null, nota: 'Cuota mensual sin definir en ficha.' };
    }
    const semanasRaw = cuota && cuota.semanas != null ? Number(cuota.semanas) : 4;
    const semanas = Number.isFinite(semanasRaw) && semanasRaw >= 0 ? semanasRaw : 4;
    const importe = Number(((precioMes * semanas) / 4).toFixed(2));
    const partes = [];
    if (semanas !== 4) {
      partes.push(
        `${formatoImporte(semanas)} semanas de clase · mes completo ${formatoImporte(precioMes)} €`
      );
    }
    if (cuota && cuota.dias_clase != null && cuota.dias_clase !== '') {
      partes.push(`${cuota.dias_clase} días de clase`);
    }
    if (cuota && cuota.nota) partes.push(String(cuota.nota));
    return { importe, nota: partes.length ? partes.join(' · ') : null };
  }
  if (modalidad === 'turno_suelta') {
    if (precioClase == null) {
      return { importe: null, nota: 'Precio por clase sin definir en ficha.' };
    }
    return {
      importe: Number((precioClase * clasesMes).toFixed(2)),
      nota: `${clasesMes} clase(s) asistida(s) × ${precioClase.toFixed(2)} €`,
    };
  }
  return {
    importe: null,
    nota: 'Modalidad de cobro sin definir en ficha (mensual o turno/clase suelta).',
  };
}

async function alumnosCobroPorTelefono(telefonoE164) {
  const { rows } = await query(
    `
    SELECT id, nombre, modalidad_cobro, iberdrola, precio_clase, precio_mes,
           COALESCE(activo, true) AS activo
    FROM public.alumnos
    WHERE telefono_e164 = $1
    ORDER BY nombre ASC NULLS LAST
    `,
    [telefonoE164]
  );
  return rows;
}

async function impagadosPorAlumno(ids) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    const { alumnos } = await calcularAlumnosConDeuda();
    const querer = new Set(ids.map(String));
    for (const alumno of alumnos) {
      if (!querer.has(String(alumno.id))) continue;
      map.set(
        String(alumno.id),
        (alumno.meses || []).map(m => String(m.mes)).filter(m => /^\d{4}-\d{2}$/.test(m))
      );
    }
  } catch (error) {
    console.error('[familia] meses impagados', error);
  }
  return map;
}

async function cuotasPorMes(meses) {
  const map = new Map();
  if (!meses.length) return map;
  try {
    const { rows } = await query(
      `
      SELECT cm.mes, cm.semanas, cm.dias_clase, cm.nota
      FROM public.cuotas_mes cm
      JOIN public.cursos cu ON cu.id = cm.curso_id
      WHERE cm.mes = ANY($1::text[])
      ORDER BY CASE WHEN cu.estado = 'abierto' THEN 0 ELSE 1 END,
               cu.fecha_inicio DESC
      `,
      [meses]
    );
    for (const row of rows) {
      if (!map.has(row.mes)) map.set(row.mes, row);
    }
  } catch (error) {
    console.error('[familia] cuotas_mes', error);
  }
  return map;
}

async function clasesAsistidasPorMes(ids, meses) {
  const map = new Map();
  if (!ids.length || !meses.length) return map;
  const { rows } = await query(
    `
    SELECT alumno_id::text AS alumno_id,
           to_char(fecha, 'YYYY-MM') AS mes,
           count(*)::int AS n
    FROM public.asistencias
    WHERE alumno_id = ANY($1::uuid[])
      AND estado = 'asistio'
      AND to_char(fecha, 'YYYY-MM') = ANY($2::text[])
    GROUP BY 1, 2
    `,
    [ids, meses]
  );
  for (const row of rows) {
    map.set(`${row.alumno_id}|${row.mes}`, Number(row.n || 0));
  }
  return map;
}

function parseMesesPagoGuardados(raw) {
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [];
  const map = new Map();
  for (const item of list) {
    const id = String(item?.alumno_id || '');
    if (!id) continue;
    const meses = new Set(
      (item.meses || [])
        .map(m => String(m || '').slice(0, 7))
        .filter(m => /^\d{4}-\d{2}$/.test(m))
    );
    map.set(id, meses);
  }
  return map;
}

async function mesesGuardadosPorTelefono(telefonoE164) {
  const { rows } = await query(
    `
    SELECT meses_pago
    FROM public.familia_enlaces
    WHERE telefono_e164 = $1
      AND tipo = 'pago'
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
    `,
    [telefonoE164]
  );
  if (!rows[0]) return null;
  return parseMesesPagoGuardados(rows[0].meses_pago);
}

/** Meses que el staff puede marcar: impagados + mes en curso + lo ya guardado. */
async function vistaMesesPago(telefonoE164) {
  const alumnos = await alumnosCobroPorTelefono(telefonoE164);
  const ids = alumnos.map(a => String(a.id));
  const impagados = await impagadosPorAlumno(ids);
  const guardados = await mesesGuardadosPorTelefono(telefonoE164);
  const actual = mesActualIso();
  const universo = new Set([actual]);
  for (const id of ids) {
    for (const mes of impagados.get(id) || []) universo.add(mes);
    const saved = guardados?.get(id);
    if (saved) {
      for (const mes of saved) {
        if (mes <= actual) universo.add(mes);
      }
    }
  }
  const mesesLista = [...universo];
  const clases = await clasesAsistidasPorMes(ids, mesesLista);
  const cuotas = await cuotasPorMes(mesesLista);

  return {
    guardado: Boolean(guardados),
    alumnos: alumnos.map(row => {
      const id = String(row.id);
      const imp = new Set(impagados.get(id) || []);
      const saved = guardados?.get(id);
      const activo = row.activo !== false;
      const mesesSet = new Set(imp);
      if (activo) mesesSet.add(actual);
      if (saved) {
        for (const mes of saved) {
          if (mes <= actual) mesesSet.add(mes);
        }
      }
      const meses = [...mesesSet].sort().map(mes => {
        const clasesN = clases.get(`${id}|${mes}`) || 0;
        const precio = precioDeMes(row, clasesN, cuotas.get(mes));
        let seleccionado = false;
        if (saved) seleccionado = saved.has(mes);
        else if (imp.has(mes)) seleccionado = true;
        else seleccionado = imp.size === 0 && mes === actual;
        return {
          mes,
          etiqueta: etiquetaMesIso(mes),
          impagado: imp.has(mes),
          actual: mes === actual,
          clases_asistidas: clasesN,
          importe: precio.importe,
          nota: precio.nota,
          seleccionado,
        };
      });
      return {
        id,
        nombre: row.nombre,
        activo,
        modalidad_cobro: row.modalidad_cobro || null,
        iberdrola: row.iberdrola === true,
        meses,
      };
    }).filter(alumno => alumno.activo !== false || alumno.meses.length > 0),
  };
}

function normalizarSeleccionMeses(raw, idsPermitidos) {
  if (!Array.isArray(raw)) return null;
  const permitidos = new Set(idsPermitidos.map(String));
  const actual = mesActualIso();
  const out = [];
  for (const item of raw) {
    const id = String(item?.alumno_id || item?.id || '');
    if (!permitidos.has(id)) continue;
    const vistos = new Set();
    const meses = [];
    for (const value of item.meses || []) {
      const mes = String(value || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mes) || mes > actual || vistos.has(mes)) continue;
      vistos.add(mes);
      meses.push(mes);
      if (meses.length >= 24) break;
    }
    meses.sort();
    out.push({ alumno_id: id, meses });
  }
  return out;
}

async function seleccionPorDefecto(telefonoE164) {
  const vista = await vistaMesesPago(telefonoE164);
  return vista.alumnos.map(alumno => ({
    alumno_id: alumno.id,
    meses: alumno.meses.filter(m => m.seleccionado).map(m => m.mes),
  }));
}

async function guardarMesesPago(enlaceId, seleccion) {
  await query(
    `UPDATE public.familia_enlaces SET meses_pago = $2::jsonb WHERE id = $1`,
    [enlaceId, JSON.stringify(seleccion)]
  );
}

function lineaAlumnoPago(row, mesesLineas) {
  const modalidad = row.modalidad_cobro || null;
  const precioClase = moneyOrNull(row.precio_clase);
  const precioMes = moneyOrNull(row.precio_mes);
  const iberdrola = row.iberdrola === true;
  const importes = mesesLineas
    .map(m => m.importe)
    .filter(n => typeof n === 'number' && Number.isFinite(n));
  const total = importes.length
    ? Number(importes.reduce((acc, n) => acc + n, 0).toFixed(2))
    : null;
  const primera = mesesLineas[0];
  const etiqueta =
    mesesLineas.length > 1
      ? mesesLineas.map(m => m.etiqueta).join(', ')
      : primera?.etiqueta || etiquetaMesActual();
  return {
    nombre: nombrePila(row.nombre),
    modalidad_cobro: modalidad,
    iberdrola,
    precio_clase: precioClase,
    precio_mes: precioMes,
    clases_asistidas_mes: primera?.clases_asistidas || 0,
    precio_mes_curso: total,
    precio_mes_curso_nota:
      mesesLineas.length === 1 ? primera?.nota || null : null,
    mes_etiqueta: etiqueta,
    meses: mesesLineas.map(m => ({
      mes: m.mes,
      etiqueta: m.etiqueta,
      importe: m.importe,
      nota: m.nota,
    })),
    total,
  };
}

async function pagosPorTelefono(telefonoE164, mesesPago) {
  const rows = await alumnosCobroPorTelefono(telefonoE164);
  const ids = rows.map(a => String(a.id));
  const actual = mesActualIso();
  const guardados = parseMesesPagoGuardados(mesesPago);
  const porAlumno = new Map();
  if (guardados) {
    for (const [id, meses] of guardados) porAlumno.set(id, [...meses].sort());
  } else {
    for (const row of rows) {
      if (row.activo === false) continue;
      porAlumno.set(String(row.id), [actual]);
    }
  }

  const universo = new Set();
  for (const meses of porAlumno.values()) {
    for (const mes of meses) universo.add(mes);
  }
  const mesesLista = [...universo];
  const clases = await clasesAsistidasPorMes(ids, mesesLista);
  const cuotas = await cuotasPorMes(mesesLista);

  return rows.flatMap(row => {
    const id = String(row.id);
    const meses = porAlumno.get(id) || [];
    if (!meses.length) return [];
    const lineas = meses.map(mes => {
      const clasesN = clases.get(`${id}|${mes}`) || 0;
      const precio = precioDeMes(row, clasesN, cuotas.get(mes));
      return {
        mes,
        etiqueta: etiquetaMesIso(mes),
        clases_asistidas: clasesN,
        importe: precio.importe,
        nota: precio.nota,
      };
    });
    return [lineaAlumnoPago(row, lineas)];
  });
}

async function asegurarEnlace(telefonoE164, tipo, { regenerar = false } = {}) {
  if (!regenerar) {
    const existing = await query(
      `SELECT id, token, notified_at, expires_at FROM public.familia_enlaces
       WHERE telefono_e164 = $1
         AND tipo = $2
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [telefonoE164, tipo]
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }
    // Caducados: revocar para no dejar filas “activas” fantasma.
    await query(
      `UPDATE public.familia_enlaces
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE telefono_e164 = $1
         AND tipo = $2
         AND revoked_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at <= now()`,
      [telefonoE164, tipo]
    );
  } else {
    await query(
      `UPDATE public.familia_enlaces
       SET revoked_at = now()
       WHERE telefono_e164 = $1 AND tipo = $2 AND revoked_at IS NULL`,
      [telefonoE164, tipo]
    );
  }

  const token = nuevoToken();
  const ttlDias = ttlDiasEnlace(tipo);
  const inserted = await query(
    `INSERT INTO public.familia_enlaces (token, telefono_e164, tipo, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int))
     RETURNING id, token, notified_at, expires_at`,
    [token, telefonoE164, tipo, ttlDias]
  );
  return inserted.rows[0];
}

/** Token activo y no caducado; mismo 404 si no existe / revocado / expirado. */
async function enlacePublicoPorToken(token, tipo) {
  const { rows } = await query(
    `SELECT id, telefono_e164, expires_at, meses_pago
     FROM public.familia_enlaces
     WHERE token = $1 AND tipo = $2 AND revoked_at IS NULL
     LIMIT 1`,
    [token, tipo]
  );
  const enlace = rows[0];
  if (!enlace) return null;
  if (enlace.expires_at && new Date(enlace.expires_at).getTime() <= Date.now()) {
    await query(
      `UPDATE public.familia_enlaces
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND revoked_at IS NULL`,
      [enlace.id]
    );
    return null;
  }
  return enlace;
}

async function marcarNotificado(enlaceId) {
  const { rows } = await query(
    `UPDATE public.familia_enlaces
     SET notified_at = COALESCE(notified_at, now())
     WHERE id = $1
     RETURNING id, token, notified_at`,
    [enlaceId]
  );
  return rows[0];
}

async function telefonoDeAlumno(alumnoId) {
  const { rows } = await query(
    `SELECT id, telefono, telefono_e164, nombre
     FROM public.alumnos WHERE id = $1 LIMIT 1`,
    [alumnoId]
  );
  const alumno = rows[0];
  if (!alumno) return null;

  let e164 = alumno.telefono_e164 || normalizarTelefonoE164(alumno.telefono);
  if (!e164) return { alumno, e164: null };

  if (!alumno.telefono_e164) {
    await query(`UPDATE public.alumnos SET telefono_e164 = $2 WHERE id = $1`, [
      alumno.id,
      e164,
    ]);
  }
  return { alumno, e164 };
}

async function estadoEnlacesTelefono(telefonoE164) {
  const { rows } = await query(
    `SELECT tipo, notified_at, expires_at
     FROM public.familia_enlaces
     WHERE telefono_e164 = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [telefonoE164]
  );
  const base = {
    horario: { generado: false, notificado: false },
    pago: { generado: false, notificado: false },
  };
  for (const row of rows) {
    if (!TIPOS_ENLACE.has(row.tipo)) continue;
    base[row.tipo] = {
      generado: true,
      notificado: Boolean(row.notified_at),
    };
  }
  return base;
}

function mensajeWhatsApp(tipo, url) {
  if (tipo === 'pago') {
    return `Hola, aquí tienes el enlace con la información de pago de la academia:\n${url}`;
  }
  return `Hola, aquí tienes el enlace con los horarios de la academia (grupo, día y hora):\n${url}`;
}

function mountDomainFamilia(app) {
  app.use('/api/familia', (req, res, next) => {
    headersPrivacidadFamilia(res);
    next();
  });

  // --- Staff ---
  app.get('/api/familia/enlace-estado', requireAdmin, async (req, res) => {
    try {
      const alumnoId = String(req.query?.alumnoId || '');
      if (!alumnoId) {
        return res.status(400).json({ error: 'alumnoId es obligatorio' });
      }
      const info = await telefonoDeAlumno(alumnoId);
      if (!info) return res.status(404).json({ error: 'Alumno no encontrado' });
      if (!info.e164) {
        return res.json({
          telefono_e164: null,
          horario: { generado: false, notificado: false },
          pago: { generado: false, notificado: false },
        });
      }
      const estado = await estadoEnlacesTelefono(info.e164);
      return res.json({ telefono_e164: info.e164, ...estado });
    } catch (error) {
      console.error('[familia] enlace-estado', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.get('/api/familia/pago-meses', requireAdmin, async (req, res) => {
    try {
      const alumnoId = String(req.query?.alumnoId || '');
      if (!alumnoId) {
        return res.status(400).json({ error: 'alumnoId es obligatorio' });
      }
      const info = await telefonoDeAlumno(alumnoId);
      if (!info) return res.status(404).json({ error: 'Alumno no encontrado' });
      if (!info.e164) {
        return res.json({ telefono_e164: null, guardado: false, alumnos: [] });
      }
      const vista = await vistaMesesPago(info.e164);
      return res.json({ telefono_e164: info.e164, ...vista });
    } catch (error) {
      console.error('[familia] pago-meses', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  app.post('/api/familia/enlace', requireAdmin, async (req, res) => {
    try {
      const alumnoId = String(req.body?.alumnoId || '');
      const regenerar = Boolean(req.body?.regenerar);
      const notificar = Boolean(req.body?.notificar);
      const tipo = parseTipo(req.body?.tipo, 'horario');
      if (!alumnoId) {
        return res.status(400).json({ error: 'alumnoId es obligatorio' });
      }
      if (!tipo) {
        return res.status(400).json({ error: 'tipo debe ser horario o pago' });
      }
      const info = await telefonoDeAlumno(alumnoId);
      if (!info) return res.status(404).json({ error: 'Alumno no encontrado' });
      if (!info.e164) {
        return res.status(400).json({
          error: 'El alumno no tiene un teléfono válido (móvil ES o E.164).',
        });
      }
      let seleccionPago = null;
      if (tipo === 'pago') {
        const alumnos = await alumnosCobroPorTelefono(info.e164);
        const ids = alumnos.map(a => String(a.id));
        seleccionPago = normalizarSeleccionMeses(req.body?.meses, ids);
        if (!seleccionPago) seleccionPago = await seleccionPorDefecto(info.e164);
        const hayMes = seleccionPago.some(item => item.meses.length > 0);
        const hayCobro = alumnos.some(a => a.iberdrola !== true);
        if (hayCobro && !hayMes) {
          return res.status(400).json({
            error: 'Elige al menos un mes para el enlace de pago.',
          });
        }
      }
      let enlace = await asegurarEnlace(info.e164, tipo, { regenerar });
      if (seleccionPago) {
        await guardarMesesPago(enlace.id, seleccionPago);
      }
      if (notificar) {
        enlace = (await marcarNotificado(enlace.id)) || enlace;
      }
      const url = enlaceUrl(enlace.token, tipo);
      const whatsapp_url = waMeUrl(info.e164, mensajeWhatsApp(tipo, url));
      const estado = await estadoEnlacesTelefono(info.e164);
      return res.json({
        url,
        tipo,
        telefono_e164: info.e164,
        regenerado: regenerar,
        notificado: Boolean(enlace.notified_at),
        whatsapp_url,
        estado,
      });
    } catch (error) {
      console.error('[familia] enlace', error);
      res.status(error.status || 500).json({ error: error.message || 'Error' });
    }
  });

  app.get('/api/familia/solicitudes/pendientes-count', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT count(*)::int AS n
         FROM public.familia_solicitudes
         WHERE estado = 'pendiente'`
      );
      res.json({ count: rows[0]?.n || 0 });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/familia/solicitudes', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT
           s.id,
           s.telefono_e164,
           s.mensaje,
           s.estado,
           s.created_at,
           COALESCE(
             (
               SELECT string_agg(a.nombre, ', ' ORDER BY a.nombre)
               FROM public.alumnos a
               WHERE a.telefono_e164 = s.telefono_e164
                 AND COALESCE(a.activo, true) = true
             ),
             ''
           ) AS alumnos
         FROM public.familia_solicitudes s
         ORDER BY
           CASE s.estado
             WHEN 'pendiente' THEN 0
             WHEN 'visto' THEN 1
             ELSE 2
           END,
           s.created_at DESC
         LIMIT 100`
      );
      const pendientes = rows.filter(r => r.estado === 'pendiente').length;
      res.json({ data: rows, pendientes });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/familia/solicitudes/:id', requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const estado = String(req.body?.estado || '');
      if (!id) return res.status(400).json({ error: 'id obligatorio' });
      if (!['pendiente', 'visto', 'cerrado'].includes(estado)) {
        return res.status(400).json({
          error: 'estado debe ser pendiente, visto o cerrado',
        });
      }
      const { rows } = await query(
        `UPDATE public.familia_solicitudes
         SET estado = $2
         WHERE id = $1
         RETURNING id, telefono_e164, mensaje, estado, created_at`,
        [id, estado]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada' });
      return res.json({ data: rows[0] });
    } catch (error) {
      console.error('[familia] patch solicitud', error);
      res.status(500).json({ error: error.message || 'Error' });
    }
  });

  // Público pago (antes de /:token). La carga inicial NO incluye IBAN/Bizum.
  app.get('/api/familia/pago/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const enlace = await enlacePublicoPorToken(token, 'pago');
      if (!enlace) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      await query(
        `UPDATE public.familia_enlaces SET last_used_at = now() WHERE id = $1`,
        [enlace.id]
      );
      const alumnos = await pagosPorTelefono(
        enlace.telefono_e164,
        enlace.meses_pago
      );
      const revelar = puedeRevelarMetodosPago(alumnos);
      const etiquetas = [
        ...new Set(
          alumnos.flatMap(a => (a.meses || []).map(m => m.etiqueta)).filter(Boolean)
        ),
      ];
      res.json({
        alumnos,
        mes_etiqueta: etiquetas.join(', ') || etiquetaMesActual(),
        // Métodos solo vía GET .../metodos (segundo paso explícito).
        metodos: null,
        mostrar_metodos: revelar,
        expires_at: enlace.expires_at || null,
      });
    } catch (error) {
      console.error('[familia] pago get', error);
      res.status(500).json({ error: 'No se pudo cargar la información de pago' });
    }
  });

  // Segundo paso: solo entonces viajan IBAN / Bizum.
  app.get('/api/familia/pago/:token/metodos', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const enlace = await enlacePublicoPorToken(token, 'pago');
      if (!enlace) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const alumnos = await pagosPorTelefono(
        enlace.telefono_e164,
        enlace.meses_pago
      );
      if (!puedeRevelarMetodosPago(alumnos)) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const metodos = metodosPagoConfig();
      if (!metodos.bizum && !metodos.transferencia) {
        return res.status(404).json({ error: 'Formas de pago no configuradas' });
      }
      res.json({ metodos });
    } catch (error) {
      console.error('[familia] pago metodos', error);
      res.status(500).json({ error: 'No se pudieron cargar las formas de pago' });
    }
  });

  // --- Público horario (token) ---
  app.get('/api/familia/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const enlace = await enlacePublicoPorToken(token, 'horario');
      if (!enlace) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      await query(
        `UPDATE public.familia_enlaces SET last_used_at = now() WHERE id = $1`,
        [enlace.id]
      );
      const alumnos = await horariosPorTelefono(enlace.telefono_e164);
      const waAcademia = whatsappContactE164();
      res.json({
        alumnos,
        whatsapp_e164: waAcademia,
        whatsapp_url: waAcademia
          ? waMeUrl(
              waAcademia,
              'Hola, escribo por el enlace de horarios. Quiero comentar un cambio.'
            )
          : null,
        expires_at: enlace.expires_at || null,
      });
    } catch (error) {
      console.error('[familia] get', error);
      res.status(500).json({ error: 'No se pudo cargar el horario' });
    }
  });

  app.post('/api/familia/:token/solicitud', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      const mensaje = String(req.body?.mensaje || '').trim();
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      if (mensaje.length < 5 || mensaje.length > 2000) {
        return res.status(400).json({
          error: 'Escribe un mensaje entre 5 y 2000 caracteres.',
        });
      }
      const enlace = await enlacePublicoPorToken(token, 'horario');
      if (!enlace) {
        return res.status(404).json({ error: 'Enlace no válido' });
      }
      const inserted = await query(
        `INSERT INTO public.familia_solicitudes (enlace_id, telefono_e164, mensaje)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [enlace.id, enlace.telefono_e164, mensaje]
      );
      const waAcademia = whatsappContactE164();
      res.status(201).json({
        ok: true,
        id: inserted.rows[0].id,
        whatsapp_url: waAcademia
          ? waMeUrl(waAcademia, `Hola, desde el enlace de horarios:\n${mensaje}`)
          : null,
      });
    } catch (error) {
      console.error('[familia] solicitud', error);
      res.status(500).json({ error: 'No se pudo enviar la solicitud' });
    }
  });
}

module.exports = {
  mountDomainFamilia,
  normalizarTelefonoE164,
  horariosPorTelefono,
  headersPrivacidadFamilia,
};
