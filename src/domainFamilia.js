const crypto = require('crypto');
const { query } = require('./db');
const { requireAdmin } = require('./authz');
const { normalizarTelefonoE164, nombrePila } = require('./telefono');

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

async function pagosPorTelefono(telefonoE164) {
  const { rows } = await query(
    `
    SELECT
      a.id,
      a.nombre,
      a.modalidad_cobro,
      a.iberdrola,
      a.precio_clase,
      a.precio_mes,
      (
        SELECT count(*)::int
        FROM public.asistencias asis
        WHERE asis.alumno_id = a.id
          AND asis.estado = 'asistio'
          AND asis.fecha >= date_trunc('month', CURRENT_DATE)::date
          AND asis.fecha < (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
      ) AS clases_asistidas_mes
    FROM public.alumnos a
    WHERE a.telefono_e164 = $1
      AND COALESCE(a.activo, true) = true
    ORDER BY a.nombre ASC NULLS LAST
    `,
    [telefonoE164]
  );

  const mes = etiquetaMesActual();
  return rows.map(row => {
    const modalidad = row.modalidad_cobro || null;
    const precioClase = moneyOrNull(row.precio_clase);
    const precioMes = moneyOrNull(row.precio_mes);
    const clasesMes = Number(row.clases_asistidas_mes || 0);
    const iberdrola = row.iberdrola === true;

    let precioMesCurso = null;
    let precioMesCursoNota = null;
    if (iberdrola) {
      precioMesCursoNota =
        'Convenio Iberdrola: el pago se gestiona por otras vías.';
    } else if (modalidad === 'mensual') {
      precioMesCurso = precioMes;
      precioMesCursoNota = precioMes == null ? 'Cuota mensual sin definir en ficha.' : null;
    } else if (modalidad === 'turno_suelta') {
      if (precioClase != null) {
        precioMesCurso = Number((precioClase * clasesMes).toFixed(2));
        precioMesCursoNota = `${clasesMes} clase(s) asistida(s) este mes × ${precioClase.toFixed(2)} €`;
      } else {
        precioMesCursoNota = 'Precio por clase sin definir en ficha.';
      }
    } else {
      precioMesCursoNota =
        'Modalidad de cobro sin definir en ficha (mensual o turno/clase suelta).';
    }

    return {
      nombre: nombrePila(row.nombre),
      modalidad_cobro: modalidad,
      iberdrola,
      precio_clase: precioClase,
      precio_mes: precioMes,
      clases_asistidas_mes: clasesMes,
      precio_mes_curso: precioMesCurso,
      precio_mes_curso_nota: precioMesCursoNota,
      mes_etiqueta: mes,
    };
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
    `SELECT id, telefono_e164, expires_at
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
      let enlace = await asegurarEnlace(info.e164, tipo, { regenerar });
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
      const alumnos = await pagosPorTelefono(enlace.telefono_e164);
      const revelar = puedeRevelarMetodosPago(alumnos);
      res.json({
        alumnos,
        mes_etiqueta: etiquetaMesActual(),
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
      const alumnos = await pagosPorTelefono(enlace.telefono_e164);
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
