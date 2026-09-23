import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { resetDb, query } from './helpers/db';
import { slugify, uniqueSlug } from '../app/lib/slug';

beforeEach(resetDb);

test('英文名转 slug', () => {
  assert.strictEqual(slugify('Lumen 学伴'), 'lumen');
  assert.strictEqual(slugify('Polaris  Agent'), 'polaris-agent');
  assert.strictEqual(slugify('--Hello__World--'), 'hello-world');
  assert.strictEqual(slugify('AirGrid v2.0'), 'airgrid-v2-0');
});

test('纯中文名 slug 化后为空', () => {
  assert.strictEqual(slugify('接力中继'), '');
  assert.strictEqual(slugify('   '), '');
});

test('uniqueSlug 冲突时追加序号', async () => {
  await query(`INSERT INTO users (username,password_hash,display_name,email,role,status)
               VALUES ('u','x','U','u@x.com','member','approved')`);
  const uid = (await query(`SELECT id FROM users WHERE username='u'`)).rows[0].id;
  const mk = (slug: string) => query(
    `INSERT INTO projects (slug,name,owner_id,status) VALUES ($1,'n',$2,'approved')`, [slug, uid]);

  assert.strictEqual(await uniqueSlug('Lumen'), 'lumen');
  await mk('lumen');
  assert.strictEqual(await uniqueSlug('Lumen'), 'lumen-2');
  await mk('lumen-2');
  assert.strictEqual(await uniqueSlug('Lumen'), 'lumen-3');
});

test('slug 化为空时回退到 p-<随机>', async () => {
  const s = await uniqueSlug('接力中继');
  assert.match(s, /^p-[a-z0-9]{6}$/);
});

test('reserved words 不能作为 slug', async () => {
  // Reserved words: review, decide, grant, clear, pending, suspend
  // (单一事实源:app/lib/slug.ts 的 RESERVED_WORDS 现在直接引用 guard 的 ADMIN_VERBS)
  // Test that these words cannot be used as slugs even when generated from different casings
  assert.notStrictEqual(await uniqueSlug('Review'), 'review');
  assert.notStrictEqual(await uniqueSlug('DECIDE'), 'decide');
  assert.notStrictEqual(await uniqueSlug('Grant'), 'grant');
});
