const { Pool, types } = require('pg');

// node-pg convierte `date` en Date (acaba en JSON como 2026-06-21T00:00:00.000Z)
// y `numeric` en string. El frontend viene de PostgREST: espera YYYY-MM-DD
// y números, y monta la hora con `${fecha}T${hora}`.
types.setTypeParser(1082, value => value);
types.setTypeParser(1700, value => (value == null || value === '' ? null : Number(value)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withClient };
