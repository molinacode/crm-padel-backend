/**
 * Smoke tests de row-level scope (sin DB).
 * Uso: node scripts/smoke-scope.js
 */
const assert = require('assert');
const { scopePlanForProfesor } = require('../src/profesorScope');

const scope = {
  profesorId: 'p1',
  nombres: ['Ana', 'Ana Ruiz'],
  claseIds: ['c1', 'c2'],
  alumnoIds: ['a1'],
};

const clases = scopePlanForProfesor({ table: 'clases', op: 'select', filters: [] }, scope);
assert.ok(clases.filters.some(f => f.type === 'in' && f.column === 'id'));
assert.deepStrictEqual(
  clases.filters.find(f => f.column === 'id').value,
  ['c1', 'c2']
);

const alumnos = scopePlanForProfesor({ table: 'alumnos', op: 'select' }, scope);
assert.deepStrictEqual(
  alumnos.filters.find(f => f.column === 'id').value,
  ['a1']
);

const self = scopePlanForProfesor({ table: 'profesores', op: 'select' }, scope);
assert.strictEqual(self.filters.find(f => f.column === 'id').value, 'p1');

const cursos = scopePlanForProfesor({ table: 'cursos', op: 'select', filters: [] }, scope);
assert.ok(cursos.filters.some(f => f.type === 'eq' && f.column === 'estado' && f.value === 'abierto'));

assert.throws(
  () =>
    scopePlanForProfesor(
      {
        table: 'asistencias',
        op: 'insert',
        data: { clase_id: 'ajena', alumno_id: 'a1' },
      },
      scope
    ),
  /No puedes escribir/
);

scopePlanForProfesor(
  {
    table: 'asistencias',
    op: 'insert',
    data: { clase_id: 'c1', alumno_id: 'a1' },
  },
  scope
);

console.log('OK smoke-scope');
