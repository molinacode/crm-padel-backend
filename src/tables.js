const ALLOWED_TABLES = new Set([
  'alumnos',
  'alumno_periodos',
  'alumnos_clases',
  'alumnos_grupos',
  'asistencias',
  'clases',
  'cursos',
  'clases_ejercicios',
  'ejercicios',
  'eventos_clase',
  'gastos_material',
  'grupos',
  'importaciones_banco',
  'importaciones_banco_movimientos',
  'instalaciones',
  'liberaciones_plaza',
  'logs_auditoria',
  'notificaciones',
  'notificaciones_admin',
  'notificaciones_profesor',
  'pagos',
  'pagos_clases_internas',
  'profesores',
  'recuperaciones_clase',
  'seguimiento_alumnos',
  'tematicas_clase',
  'tarifas_alquiler_escuela',
]);

// `staff` se gestiona solo desde /api/auth/* (es la tabla que decide el rol) y
// `usuarios` es la tabla heredada de Supabase Auth: ninguna se expone aquí.

/** Tablas donde solo se puede leer e insertar: el histórico no se toca. */
const APPEND_ONLY_TABLES = new Set(['logs_auditoria']);

function assertOperation(table, op) {
  if (APPEND_ONLY_TABLES.has(table) && op !== 'select' && op !== 'insert') {
    throw new Error(`Operación no permitida sobre ${table}: ${op}`);
  }
}

/** table -> embedName -> { from, toTable, to, many } */
const RELATIONS = {
  alumno_periodos: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
  },
  alumnos_clases: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
    eventos_clase: { from: 'evento_id', toTable: 'eventos_clase', to: 'id', many: false },
  },
  alumnos_grupos: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    grupos: { from: 'grupo_id', toTable: 'grupos', to: 'id', many: false },
  },
  asistencias: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  clases: {
    instalaciones: { from: 'instalacion_id', toTable: 'instalaciones', to: 'id', many: false },
    eventos_clase: { from: 'id', toTable: 'eventos_clase', to: 'clase_id', many: true },
    alumnos_clases: { from: 'id', toTable: 'alumnos_clases', to: 'clase_id', many: true },
    cursos: { from: 'curso_id', toTable: 'cursos', to: 'id', many: false },
  },
  clases_ejercicios: {
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
    ejercicios: { from: 'ejercicio_id', toTable: 'ejercicios', to: 'id', many: false },
  },
  eventos_clase: {
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  grupos: {
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
    instalaciones: { from: 'instalacion_id', toTable: 'instalaciones', to: 'id', many: false },
    alumnos_grupos: { from: 'id', toTable: 'alumnos_grupos', to: 'grupo_id', many: true },
  },
  liberaciones_plaza: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  notificaciones_profesor: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  pagos: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
  },
  pagos_clases_internas: {
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  recuperaciones_clase: {
    alumnos: { from: 'alumno_id', toTable: 'alumnos', to: 'id', many: false },
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  seguimiento_alumnos: {
    profesores: { from: 'profesor_id', toTable: 'profesores', to: 'id', many: false },
  },
  tematicas_clase: {
    clases: { from: 'clase_id', toTable: 'clases', to: 'id', many: false },
  },
  importaciones_banco_movimientos: {
    importaciones_banco: { from: 'import_id', toTable: 'importaciones_banco', to: 'id', many: false },
    pagos: { from: 'pago_id_creado', toTable: 'pagos', to: 'id', many: false },
  },
};

function isIdent(name) {
  return typeof name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function quoteIdent(name) {
  if (!isIdent(name)) {
    throw new Error(`Identificador no permitido: ${name}`);
  }
  return `"${name}"`;
}

function assertTable(table) {
  if (!ALLOWED_TABLES.has(table) || !isIdent(table)) {
    throw new Error(`Tabla no permitida: ${table}`);
  }
  return table;
}

/** Columnas escribibles por tabla (insert/update/upsert). Cualquier otra se rechaza. */
const WRITABLE_COLUMNS = {
  alumno_periodos: new Set(['id', 'alumno_id', 'fecha_inicio', 'fecha_fin', 'created_at']),
  alumnos: new Set([
    'id', 'nombre', 'email', 'telefono', 'nivel', 'created_at', 'activo', 'foto_url',
    'observaciones', 'disponibilidad', 'updated_at', 'fecha_baja', 'telefono_e164',
    'pendiente_horario', 'modalidad_cobro', 'iberdrola', 'precio_clase', 'precio_mes',
  ]),
  alumnos_clases: new Set([
    'alumno_id', 'clase_id', 'id', 'origen', 'tipo_asignacion', 'evento_id',
  ]),
  alumnos_grupos: new Set(['id', 'grupo_id', 'alumno_id', 'created_at']),
  asistencias: new Set(['id', 'alumno_id', 'clase_id', 'fecha', 'estado']),
  clases: new Set([
    'id', 'nombre', 'dia_semana', 'hora_inicio', 'hora_fin', 'nivel_clase', 'profesor',
    'fecha_inicio', 'fecha_fin', 'recurrencia', 'tipo_clase', 'instalacion_id',
    'created_at', 'updated_at', 'observaciones', 'contabiliza_como', 'capacidad_maxima',
    'curso_id',
  ]),
  clases_ejercicios: new Set([
    'id', 'clase_id', 'ejercicio_id', 'tematica', 'profesor', 'fecha_asignacion',
    'orden_ejercicio', 'duracion_minutos', 'observaciones', 'activo', 'created_at',
    'updated_at',
  ]),
  cursos: new Set(['id', 'nombre', 'fecha_inicio', 'fecha_fin', 'estado', 'created_at']),
  ejercicios: new Set([
    'id', 'nombre', 'description', 'categoria', 'dificultad', 'duracion_minutos', 'tipo',
    'material_necesario', 'instrucciones', 'variantes', 'observaciones', 'created_at',
  ]),
  eventos_clase: new Set([
    'id', 'clase_id', 'fecha', 'hora_inicio', 'hora_fin', 'estado', 'es_modificacion',
    'modificado_individualmente', 'fecha_modificacion', 'excluir_alquiler',
  ]),
  gastos_material: new Set([
    'id', 'created_at', 'concepto', 'descripcion', 'cantidad', 'fecha_gasto', 'categoria',
    'proveedor', 'factura_url', 'observaciones', 'updated_at', 'fecha_gasto_mes',
  ]),
  grupos: new Set([
    'id', 'nombre', 'nivel', 'capacidad_maxima', 'profesor', 'instalacion_id', 'dia_semana',
    'hora_inicio', 'hora_fin', 'color', 'activo', 'observaciones', 'clase_id', 'created_at',
    'updated_at',
  ]),
  importaciones_banco: new Set([
    'id', 'created_at', 'created_by', 'banco', 'nombre_archivo', 'estado', 'total_lineas',
    'total_ingresos', 'total_gastos', 'total_aceptadas', 'total_descartadas',
    'total_duplicadas', 'total_creadas_en_pagos', 'notas',
  ]),
  importaciones_banco_movimientos: new Set([
    'id', 'import_id', 'created_at', 'updated_at', 'linea_csv', 'fecha_operacion', 'importe',
    'tipo_movimiento', 'concepto_raw', 'referencia_raw', 'ordenante_raw', 'iban_raw',
    'categoria', 'subcategoria', 'moneda', 'tipo_origen', 'estado_origen', 'estado_match',
    'alumno_id_sugerido', 'alumno_id_confirmado', 'confianza_match', 'motivo_match',
    'huella_movimiento', 'es_duplicado', 'duplicado_de_movimiento_id', 'pago_id_creado',
  ]),
  instalaciones: new Set([
    'id', 'nombre', 'tipo', 'capacidad', 'precio_hora', 'created_at', 'updated_at',
  ]),
  liberaciones_plaza: new Set([
    'id', 'alumno_id', 'clase_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'estado',
    'fecha_creacion', 'fecha_actualizacion',
  ]),
  logs_auditoria: new Set([
    'id', 'usuario_id', 'accion', 'entidad', 'entidad_id', 'detalle', 'created_at',
  ]),
  notificaciones: new Set([
    'id', 'created_at', 'tipo', 'titulo', 'mensaje', 'datos', 'leida', 'leida_at',
  ]),
  notificaciones_admin: new Set([
    'id', 'created_at', 'created_by', 'tipo', 'titulo', 'mensaje', 'datos', 'leida', 'leida_at',
  ]),
  notificaciones_profesor: new Set([
    'id', 'profesor', 'tipo', 'titulo', 'mensaje', 'clase_id', 'alumno_id', 'leida',
    'fecha_creacion', 'fecha_lectura', 'prioridad', 'metadata', 'created_at', 'updated_at',
    'cambios_planificados', 'cambios_aplicados', 'estado',
  ]),
  pagos: new Set([
    'id', 'alumno_id', 'cantidad', 'mes_cubierto', 'metodo', 'fecha_pago', 'tipo_pago',
    'fecha_inicio', 'fecha_fin', 'clases_cubiertas', 'origen_registro',
    'importacion_movimiento_id', 'huella_movimiento',
  ]),
  pagos_clases_internas: new Set([
    'id', 'clase_id', 'fecha', 'estado', 'notas', 'created_at', 'created_by',
  ]),
  profesores: new Set([
    'id', 'nombre', 'apellidos', 'email', 'telefono', 'especialidad', 'nivel_experiencia',
    'direccion', 'observaciones', 'created_at', 'updated_at', 'foto_url', 'activo',
    'fecha_nacimiento',
  ]),
  recuperaciones_clase: new Set([
    'id', 'alumno_id', 'clase_id', 'falta_justificada_id', 'fecha_falta', 'fecha_recuperacion',
    'estado', 'observaciones', 'created_at', 'updated_at', 'tipo_recuperacion',
  ]),
  seguimiento_alumnos: new Set([
    'id', 'alumno_id', 'created_at', 'fecha_seguimiento', 'tipo', 'objetivos', 'progreso',
    'profesor_id',
  ]),
  tarifas_alquiler_escuela: new Set(['id', 'importe', 'vigente_desde', 'created_at']),
  tematicas_clase: new Set([
    'id', 'clase_id', 'tematica', 'profesor', 'fecha_asignacion', 'ejercicios_asignados',
    'observaciones', 'activa', 'created_at', 'updated_at',
  ]),
};

const FORBIDDEN_SYSTEM_COLUMNS = new Set([
  'ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid',
]);

function assertWritableColumns(table, cols) {
  const allowed = WRITABLE_COLUMNS[table];
  if (!allowed) {
    throw new Error(`Tabla sin whitelist de escritura: ${table}`);
  }
  const bad = cols.filter(
    c => FORBIDDEN_SYSTEM_COLUMNS.has(c) || !allowed.has(c)
  );
  if (bad.length) {
    throw new Error(`Columnas no permitidas en ${table}: ${bad.join(', ')}`);
  }
}

module.exports = {
  ALLOWED_TABLES,
  APPEND_ONLY_TABLES,
  WRITABLE_COLUMNS,
  RELATIONS,
  isIdent,
  quoteIdent,
  assertTable,
  assertOperation,
  assertWritableColumns,
};
