/**
 * Normaliza teléfonos al formato E.164 (prioridad ES: 9 dígitos 6/7 → +34).
 * Misma lógica que public.normalizar_telefono_e164 en SQL.
 */
function normalizarTelefonoE164(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  let d = trimmed.replace(/[^0-9+]/g, '');
  if (d.startsWith('+')) {
    d = `+${d.slice(1).replace(/\D/g, '')}`;
  } else {
    d = d.replace(/\D/g, '');
    if (d.startsWith('00')) {
      d = `+${d.slice(2)}`;
    } else if (/^[67]\d{8}$/.test(d)) {
      d = `+34${d}`;
    } else if (/^34\d{9}$/.test(d)) {
      d = `+${d}`;
    } else {
      return null;
    }
  }

  if (d.length < 10 || d.length > 16) return null;
  return d;
}

/** Solo el primer nombre (evita apellidos en la página pública). */
function nombrePila(nombre) {
  const t = String(nombre || '').trim();
  if (!t) return 'Alumno';
  return t.split(/\s+/)[0];
}

module.exports = { normalizarTelefonoE164, nombrePila };
