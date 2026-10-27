const { query } = require('./db');
const {
  RELATIONS,
  quoteIdent,
  assertTable,
  assertOperation,
  assertWritableColumns,
  isIdent,
} = require('./tables');

const MAX_LIMIT = 500;
const MAX_EMBED_DEPTH = 3;

// alias:relacion!hint( ... ) -> el alias y el hint son opcionales (sintaxis PostgREST).
const EMBED_START = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_]*)(?:!([a-zA-Z_][a-zA-Z0-9_]*))?\s*\(/;

function parseSelect(select) {
  const src = String(select || '*')
    .replace(/\s+/g, ' ')
    .trim();
  const embeds = [];
  let rest = '';
  let i = 0;
  while (i < src.length) {
    const slice = src.slice(i);
    const m = slice.match(EMBED_START);
    if (m) {
      i += m[0].length;
      let depth = 1;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      }
      embeds.push({
        name: m[1] || m[2],
        relation: m[2],
        inner: m[3] === 'inner',
        select: src.slice(start, i - 1).trim() || '*',
      });
      while (src[i] === ',' || src[i] === ' ') i += 1;
      continue;
    }
    rest += src[i];
    i += 1;
  }
  const columns = rest
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return { columns: columns.length ? columns : ['*'], embeds };
}

function parseOrClause(raw) {
  const parts = String(raw).split(',');
  const out = [];
  for (const part of parts) {
    const m = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.*)$/);
    if (!m) continue;
    out.push({ column: m[1], op: m[2], value: m[3] });
  }
  return out;
}

function coerceOrValue(op, value) {
  if (op === 'is') {
    if (value === 'null') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function sqlOp(op) {
  switch (op) {
    case 'eq':
      return '=';
    case 'neq':
      return '<>';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    case 'like':
      return 'LIKE';
    case 'ilike':
      return 'ILIKE';
    default:
      throw new Error(`Operador no soportado: ${op}`);
  }
}

function addFilter(parts, params, filter) {
  if (filter.type === 'or') {
    const clauses = parseOrClause(filter.raw);
    if (!clauses.length) return;
    const bits = [];
    for (const c of clauses) {
      if (c.op === 'is' && coerceOrValue('is', c.value) === null) {
        bits.push(`${quoteIdent(c.column)} IS NULL`);
        continue;
      }
      params.push(coerceOrValue(c.op, c.value));
      bits.push(`${quoteIdent(c.column)} ${sqlOp(c.op)} $${params.length}`);
    }
    parts.push(`(${bits.join(' OR ')})`);
    return;
  }
  if (filter.type === 'is') {
    if (filter.value === null) parts.push(`${quoteIdent(filter.column)} IS NULL`);
    else if (filter.value === true) parts.push(`${quoteIdent(filter.column)} IS TRUE`);
    else if (filter.value === false) parts.push(`${quoteIdent(filter.column)} IS FALSE`);
    else {
      params.push(filter.value);
      parts.push(`${quoteIdent(filter.column)} = $${params.length}`);
    }
    return;
  }
  if (filter.type === 'in') {
    const values = Array.isArray(filter.value) ? filter.value : [];
    if (!values.length) {
      parts.push('FALSE');
      return;
    }
    const placeholders = values.map(v => {
      params.push(v);
      return `$${params.length}`;
    });
    parts.push(`${quoteIdent(filter.column)} IN (${placeholders.join(',')})`);
    return;
  }
  params.push(filter.value);
  parts.push(`${quoteIdent(filter.column)} ${sqlOp(filter.type)} $${params.length}`);
}

function columnsWithForeignKeys(table, parsed) {
  if (parsed.columns.includes('*')) return parsed.columns;
  const rels = RELATIONS[table] || {};
  const extra = [];
  for (const embed of parsed.embeds) {
    const rel = findRelation(rels, embed);
    if (rel && !parsed.columns.includes(rel.from) && !extra.includes(rel.from)) extra.push(rel.from);
  }
  return extra.length ? [...parsed.columns, ...extra] : parsed.columns;
}

function selectSql(table, columns) {
  if (columns.length === 1 && columns[0] === '*') return '*';
  return columns.map(c => (c === '*' ? '*' : quoteIdent(c))).join(', ');
}

function findRelation(rels, embed) {
  if (rels[embed.relation]) return rels[embed.relation];
  if (rels[embed.name]) return rels[embed.name];
  // alias sobre la clave ajena: alumnos:alumno_id(...)
  return Object.values(rels).find(r => r.from === embed.relation) || null;
}

async function hydrateEmbeds(table, rows, embeds, depth = 0) {
  if (!rows.length || !embeds.length) return rows;
  if (depth >= MAX_EMBED_DEPTH) {
    throw new Error(`Profundidad de embeds limitada a ${MAX_EMBED_DEPTH}`);
  }
  const rels = RELATIONS[table] || {};
  let current = rows;
  for (const embed of embeds) {
    const rel = findRelation(rels, embed);
    if (!rel || !ALLOWED_NEST(rel.toTable)) {
      // Sin relación declarada no hay nada que unir: se avisa y se deja la clave vacía
      // para que el cliente no reciba un `undefined` silencioso.
      console.warn(`[query] relación no declarada: ${table}.${embed.relation}`);
      current = current.map(row => ({ ...row, [embed.name]: null }));
      continue;
    }
    const parsed = parseSelect(embed.select);
    // La unión se hace por la clave ajena. Si el select no la pide
    // (alumnos(nombre)), el hijo no trae `id` y el emparejado queda vacío.
    const embedColumns = parsed.columns.includes('*') || parsed.columns.includes(rel.to)
      ? parsed.columns
      : [...parsed.columns, rel.to];
    const ids = [
      ...new Set(current.map(r => r[rel.from]).filter(v => v !== null && v !== undefined)),
    ];
    let children = [];
    if (ids.length) {
      const params = [];
      const placeholders = ids.map(id => {
        params.push(id);
        return `$${params.length}`;
      });
      const sql = `SELECT ${selectSql(rel.toTable, embedColumns)} FROM ${quoteIdent(
        rel.toTable
      )} WHERE ${quoteIdent(rel.to)} IN (${placeholders.join(',')})`;
      const result = await query(sql, params);
      children = result.rows;
      if (parsed.embeds.length) {
        children = await hydrateEmbeds(rel.toTable, children, parsed.embeds, depth + 1);
      }
    }
    current = current.map(row => {
      if (rel.many) {
        const nested = children.filter(c => String(c[rel.to]) === String(row[rel.from]));
        return { ...row, [embed.name]: nested };
      }
      const nested = children.find(c => String(c[rel.to]) === String(row[rel.from])) || null;
      return { ...row, [embed.name]: nested };
    });
    if (embed.inner) {
      current = current.filter(row => {
        const nested = row[embed.name];
        return rel.many ? nested.length > 0 : nested !== null;
      });
    }
  }
  return current;
}

function ALLOWED_NEST(table) {
  try {
    assertTable(table);
    return true;
  } catch {
    return false;
  }
}

function returningClause(plan) {
  if (plan.head) return '';
  const parsed = parseSelect(plan.select || '*');
  if (!parsed.embeds.length && parsed.columns.length === 1 && parsed.columns[0] === '*') {
    return ' RETURNING *';
  }
  if (!parsed.embeds.length) {
    return ` RETURNING ${selectSql('x', parsed.columns)}`;
  }
  return ' RETURNING *';
}

async function runQuery(plan) {
  const table = assertTable(plan.table);
  const op = plan.op || 'select';
  assertOperation(table, op);
  const filters = Array.isArray(plan.filters) ? plan.filters : [];
  const params = [];
  const whereParts = [];
  for (const f of filters) {
    if (!f.column && f.type !== 'or') continue;
    if (f.column && !isIdent(f.column) && f.type !== 'or') {
      throw new Error(`Columna no permitida: ${f.column}`);
    }
    addFilter(whereParts, params, f);
  }
  const where = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';
  if ((op === 'update' || op === 'delete') && !where) {
    throw new Error(`Un ${op} sin filtros afectaría a toda la tabla ${table}`);
  }

  if (op === 'select') {
    let exactCount = null;
    if (plan.head || plan.count === 'exact') {
      const countSql = `SELECT COUNT(*)::int AS count FROM ${quoteIdent(table)}${where}`;
      const counted = await query(countSql, params);
      exactCount = counted.rows[0]?.count || 0;
      if (plan.head) return { data: null, error: null, count: exactCount };
    }
    const parsed = parseSelect(plan.select || '*');
    const selected = columnsWithForeignKeys(table, parsed);
    let sql = `SELECT ${selectSql(table, selected)} FROM ${quoteIdent(table)}${where}`;
    if (Array.isArray(plan.order)) {
      const orders = plan.order
        .filter(o => o && isIdent(o.column))
        .map(o => `${quoteIdent(o.column)} ${o.ascending === false ? 'DESC' : 'ASC'}`);
      if (orders.length) sql += ` ORDER BY ${orders.join(', ')}`;
    }
    const offset = plan.offset != null ? Number(plan.offset) : null;
    const paginando = offset !== null && Number.isInteger(offset) && offset >= 0;
    // Las páginas solo encajan si el orden es total; ctid desempata filas iguales.
    if (paginando) sql += /ORDER BY/.test(sql) ? ', ctid' : ' ORDER BY ctid';
    // Sin limit el proxy podría volcar tablas enteras; tope duro de seguridad.
    let limit = plan.limit != null ? Number(plan.limit) : MAX_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) limit = MAX_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    if (!plan.single && !plan.maybeSingle) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
      if (paginando) {
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
      }
    } else {
      params.push(Math.min(limit, 2));
      sql += ` LIMIT $${params.length}`;
    }
    const result = await query(sql, params);
    let rows = result.rows;
    if (parsed.embeds.length) rows = await hydrateEmbeds(table, rows, parsed.embeds);
    const count = exactCount !== null ? exactCount : rows.length;
    if (plan.single || plan.maybeSingle) {
      if (plan.single && rows.length !== 1) {
        return {
          data: null,
          error: {
            message: rows.length ? 'Too many rows' : 'Row not found',
            code: rows.length ? 'PGRST102' : 'PGRST116',
          },
          count,
        };
      }
      return { data: rows[0] || null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  if (op === 'insert' || op === 'upsert') {
    const rows = Array.isArray(plan.data) ? plan.data : [plan.data];
    if (!rows.length || !rows[0] || typeof rows[0] !== 'object') {
      return { data: null, error: { message: 'Sin datos para insertar' } };
    }
    const cols = Object.keys(rows[0]).filter(isIdent);
    if (!cols.length) return { data: null, error: { message: 'Sin columnas' } };
    assertWritableColumns(table, cols);
    const valuesSql = [];
    const insertParams = [];
    for (const row of rows) {
      const placeholders = cols.map(col => {
        insertParams.push(row[col] === undefined ? null : row[col]);
        return `$${insertParams.length}`;
      });
      valuesSql.push(`(${placeholders.join(',')})`);
    }
    let sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(',')}) VALUES ${valuesSql.join(',')}`;
    if (op === 'upsert' && plan.onConflict) {
      const conflictCols = String(plan.onConflict)
        .split(',')
        .map(s => s.trim())
        .filter(isIdent);
      if (!conflictCols.length) throw new Error('onConflict inválido');
      const updates = cols
        .filter(c => !conflictCols.includes(c))
        .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
      sql += ` ON CONFLICT (${conflictCols.map(quoteIdent).join(',')}) DO UPDATE SET ${
        updates.length ? updates.join(',') : `${quoteIdent(conflictCols[0])} = EXCLUDED.${quoteIdent(conflictCols[0])}`
      }`;
    }
    sql += returningClause(plan);
    const result = await query(sql, insertParams);
    let out = result.rows;
    const parsed = parseSelect(plan.select || '*');
    if (parsed.embeds.length) out = await hydrateEmbeds(table, out, parsed.embeds);
    if (plan.single || plan.maybeSingle) return { data: out[0] || null, error: null };
    return { data: Array.isArray(plan.data) ? out : out[0] || out, error: null };
  }

  if (op === 'update') {
    const patch = plan.data && !Array.isArray(plan.data) ? plan.data : null;
    if (!patch) return { data: null, error: { message: 'Sin datos para actualizar' } };
    const cols = Object.keys(patch).filter(isIdent);
    if (!cols.length) return { data: null, error: { message: 'Sin columnas' } };
    assertWritableColumns(table, cols);
    const sets = cols.map(col => {
      params.push(patch[col] === undefined ? null : patch[col]);
      return `${quoteIdent(col)} = $${params.length}`;
    });
    const sql = `UPDATE ${quoteIdent(table)} SET ${sets.join(',')}${where}${returningClause(plan)}`;
    const result = await query(sql, params);
    let out = result.rows;
    const parsed = parseSelect(plan.select || '*');
    if (parsed.embeds.length) out = await hydrateEmbeds(table, out, parsed.embeds);
    if (plan.single || plan.maybeSingle) return { data: out[0] || null, error: null };
    return { data: out, error: null };
  }

  if (op === 'delete') {
    const sql = `DELETE FROM ${quoteIdent(table)}${where}${plan.select ? returningClause(plan) : ''}`;
    const result = await query(sql, params);
    if (plan.single || plan.maybeSingle) return { data: result.rows[0] || null, error: null };
    return { data: plan.select ? result.rows : null, error: null };
  }

  return { data: null, error: { message: `Operación no soportada: ${op}` } };
}

module.exports = { runQuery, parseSelect };
