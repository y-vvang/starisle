'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const S = require('../app/auth/session');

async function makeUser(over = {}) {
  const u = { username: 'alice', email: 'a@x.com', display_name: 'Alice',
              role: 'member', status: 'approved', ...over };
  const r = await query(
    `INSERT INTO users (username, password_hash, display_name, email, role, status)
     VALUES ($1,'x',$2,$3,$4,$5) RETURNING id`,
    [u.username, u.display_name, u.email, u.role, u.status]);
  // pg 把 bigint 列读成字符串;这里转成 Number 是为了让 uid 和
  // S.getSession() 返回的 user.id(现在定死为 Number)类型一致,
  // 否则下面「签发的会话能查回来」测试里的 strictEqual 会因为
  // Number !== String 而失败,即便两边数值相同。
  return Number(r.rows[0].id);
}

test.beforeEach(resetDb);
test.after(closeDb);

test('签发的会话能查回来,并带上用户', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, { userAgent: 'ua', ip: '127.0.0.1' });
  assert.ok(id.length >= 32);
  const s = await S.getSession(id);
  assert.strictEqual(s.user.id, uid);
  assert.strictEqual(s.user.username, 'alice');
  assert.strictEqual(s.user.role, 'member');
});

test('不存在的会话 id 返回 null', async () => {
  assert.strictEqual(await S.getSession('nope'), null);
  assert.strictEqual(await S.getSession(''), null);
  assert.strictEqual(await S.getSession(null), null);
});

test('过期会话查不到', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, {});
  await query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
  assert.strictEqual(await S.getSession(id), null);
});

test('吊销后查不到', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, {});
  await S.destroySession(id);
  assert.strictEqual(await S.getSession(id), null);
});

test('吊销某用户全部会话', async () => {
  const uid = await makeUser();
  const a = await S.createSession(uid, {});
  const b = await S.createSession(uid, {});
  await S.destroyUserSessions(uid);
  assert.strictEqual(await S.getSession(a.id), null);
  assert.strictEqual(await S.getSession(b.id), null);
});

test('两次签发的 id 不同', async () => {
  const uid = await makeUser();
  const a = await S.createSession(uid, {});
  const b = await S.createSession(uid, {});
  assert.notStrictEqual(a.id, b.id);
});

test('cleanupExpired 只删过期的', async () => {
  const uid = await makeUser();
  const live = await S.createSession(uid, {});
  const dead = await S.createSession(uid, {});
  await query(`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id=$1`, [dead.id]);
  const n = await S.cleanupExpired();
  assert.strictEqual(n, 1);
  assert.ok(await S.getSession(live.id));
});

test('用户被删时会话级联删除', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, {});
  await query('DELETE FROM users WHERE id=$1', [uid]);
  assert.strictEqual(await S.getSession(id), null);
});

// pg 默认把 bigint/int8 列读成字符串,getSession() 若原样透传会让 ctx.user.id
// 变成字符串,导致下游任何 `Number(x) === ctx.user.id` 的比较永远为 false
// (真实案例:suspend 端点的自我停用防护是死代码)。这里把类型钉死,防止回归。
test('session.user.id 是 Number,不是字符串(pg bigint 边界类型钉死)', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, {});
  const s = await S.getSession(id);
  assert.strictEqual(typeof s.user.id, 'number');
});

// 修复回归(Fix 3):停用今天之所以"看起来"生效,完全是因为 suspend 端点先
// UPDATE users SET status='suspended',再另开一条独立语句删 sessions——这两步
// 不是原子的。如果第二步(删 sessions)因为任何原因失败,用户的会话行原封
// 不动、也没过期,getSession() 原来的 WHERE 只看 s.expires_at,压根不读它已经
// SELECT 出来的 u.status,于是这个人会在最长 30 天内继续被当成正常已登录用户。
// 这里直接跳过 suspend 端点、只改 status 不动 sessions 表,模拟"第二步失败"
// 的现场,断言 getSession 仍然必须返回 null——停用要在每次请求都生效,
// 不能只靠"顺便把会话也删了"这个副作用。
test('用户被直接改成 suspended(不动 sessions 表)→ getSession 立刻查不到,不用等会话过期或被删', async () => {
  const uid = await makeUser();
  const { id } = await S.createSession(uid, {});
  assert.ok(await S.getSession(id), '前置条件:改状态之前会话应该是有效的');
  await query(`UPDATE users SET status='suspended' WHERE id=$1`, [uid]);
  assert.strictEqual(await S.getSession(id), null);
  // sessions 表本身完全没动:证明这不是靠"会话被清理/过期"这条旧路径生效的。
  const row = await query('SELECT 1 FROM sessions WHERE id=$1', [id]);
  assert.strictEqual(row.rowCount, 1);
});
