import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './pool';

const DIR = join(import.meta.dir, 'migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const done = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map(r => (r as any).name)
  );
  const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (done.has(f)) { console.log(`  跳过 ${f}(已应用)`); continue; }
    const sql = readFileSync(join(DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`  应用 ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`  失败 ${f}: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log('migration 完成');
}

// 原 CJS 版没有 require.main 守卫(顶层直接 main(),被 require 即执行迁移)。
// 转 ESM 时补上守卫,与 bin/ 下两个 CLI 的模式一致。
if (import.meta.main) {
  main();
}
