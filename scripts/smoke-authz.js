/**
 * Smoke tests de authz sin runner externo.
 * Uso: node scripts/smoke-authz.js
 */
const assert = require('assert');
const { roleFromClaims, profesorPuede } = require('../src/authz');

function roles(...keys) {
  const map = {};
  for (const key of keys) map[key] = { 'x': {} };
  return { 'urn:zitadel:iam:org:project:roles': map };
}

assert.strictEqual(roleFromClaims(roles('admin')), 'admin');
assert.strictEqual(roleFromClaims(roles('profesor')), 'profesor');
assert.strictEqual(roleFromClaims(roles()), null);
assert.strictEqual(roleFromClaims({}), null);

assert.strictEqual(profesorPuede('pagos', 'select'), false);
assert.strictEqual(profesorPuede('alumnos', 'select'), true);
assert.strictEqual(profesorPuede('alumnos', 'insert'), false);
assert.strictEqual(profesorPuede('asistencias', 'insert'), true);
assert.strictEqual(profesorPuede('importaciones_banco', 'select'), false);

console.log('OK smoke-authz');
