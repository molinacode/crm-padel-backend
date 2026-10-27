/**
 * Smoke: whitelist de columnas en escritura.
 * Uso: node scripts/smoke-columns.js
 */
const assert = require('assert');
const { assertWritableColumns } = require('../src/tables');

assertWritableColumns('alumnos', ['nombre', 'telefono', 'activo']);
assertWritableColumns('asistencias', ['alumno_id', 'clase_id', 'fecha', 'estado']);

assert.throws(
  () => assertWritableColumns('alumnos', ['nombre', 'rol_secreto']),
  /Columnas no permitidas/
);
assert.throws(
  () => assertWritableColumns('alumnos', ['ctid']),
  /Columnas no permitidas/
);
assert.throws(
  () => assertWritableColumns('tabla_fantasma', ['id']),
  /sin whitelist/
);

console.log('OK smoke-columns');
