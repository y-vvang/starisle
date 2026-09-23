'use strict';
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const DIR = path.join(__dirname, 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const done = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  );
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (done.has(f)) { console.log(`  跳过 ${f}(已应用)`); continue; }
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`  应用 ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`  失败 ${f}: ${e.message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log('migration 完成');
}

main();
