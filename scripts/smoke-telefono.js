const assert = require('node:assert/strict');
const { normalizarTelefonoE164, nombrePila } = require('../src/telefono');

const cases = [
  ['600123456', '+34600123456'],
  ['600 12 34 56', '+34600123456'],
  ['+34 600 123 456', '+34600123456'],
  ['0034600123456', '+34600123456'],
  ['34600123456', '+34600123456'],
  ['700111222', '+34700111222'],
  ['', null],
  [null, null],
  ['12345', null],
  ['912345678', null],
];

for (const [input, expected] of cases) {
  assert.equal(
    normalizarTelefonoE164(input),
    expected,
    `normalizarTelefonoE164(${JSON.stringify(input)})`
  );
}

assert.equal(nombrePila('Lucía García Pérez'), 'Lucía');
assert.equal(nombrePila('  Pablo  '), 'Pablo');
assert.equal(nombrePila(''), 'Alumno');

console.log('smoke-telefono: ok', cases.length, 'casos + nombrePila');
