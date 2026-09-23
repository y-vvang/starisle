'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { handle } = require('../app/routes');
const { hash, verify } = require('../app/auth/password');
const S = require('../app/auth/session');

const call = (method, path, body = {}, user = null) =>
  handle({ method, path, seg: path.split('/').filter(Boolean),
           query: new URLSearchParams(), body, user,
           session: user ? { id: 'fake' } : null, userAgent: 'test', ip: '127.0.0.1' });

const REG = { username: 'alice', password: 'hunter2hunter2', display_name: 'Alice',
              email: 'alice@example.com', repo_url: 'https://gitee.com/a/b',
              apply_note: '我想加入这个社区一起做项目,已经写过一个小工具' };

async function seedAdmin() {
  const r = await query(
    `INSERT INTO users (username,password_hash,display_name,email,role,status)
     VALUES ('root',$1,'站长','root@x.com','admin','approved') RETURNING id`,
    [await hash('rootpassword')]);
  // Number(...):pg 把 bigint 列读成字符串,而真实请求里 ctx.user.id 来自
  // getSession()(现在钉死为 Number)。call() 直接手工构造 ctx.user、绕过了
  // getSession(),不转型的话 admin.id 会是 "1" 这样的字符串,没能真实
  // 模拟生产路径,会让自我停用防护的测试失真。
  return { id: Number(r.rows[0].id), username: 'root', role: 'admin', status: 'approved' };
}

test.beforeEach(resetDb);
test.after(closeDb);

test('注册成功 → status 为 pending', async () => {
  const r = await call('POST', '/api/auth/register', REG);
  assert.strictEqual(r.status, 200);
  const u = await query('SELECT status, role FROM users WHERE username=$1', ['alice']);
  assert.strictEqual(u.rows[0].status, 'pending');
  assert.strictEqual(u.rows[0].role, 'member');
});

test('注册不落明文密码', async () => {
  await call('POST', '/api/auth/register', REG);
  const u = await query('SELECT password_hash FROM users WHERE username=$1', ['alice']);
  assert.ok(!u.rows[0].password_hash.includes('hunter2'));
});

test('用户名重复 → 409', async () => {
  await call('POST', '/api/auth/register', REG);
  const r = await call('POST', '/api/auth/register', { ...REG, email: 'other@x.com' });
  assert.strictEqual(r.status, 409);
});

test('邮箱重复 → 409', async () => {
  await call('POST', '/api/auth/register', REG);
  const r = await call('POST', '/api/auth/register', { ...REG, username: 'bob' });
  assert.strictEqual(r.status, 409);
});

test('密码太短 → 400', async () => {
  const r = await call('POST', '/api/auth/register', { ...REG, password: 'short' });
  assert.strictEqual(r.status, 400);
});

test('关闭注册后 → 403', async () => {
  await query(`UPDATE settings SET value='false'::jsonb WHERE key='registration_open'`);
  try {
    const r = await call('POST', '/api/auth/register', REG);
    assert.strictEqual(r.status, 403);
  } finally {
    await query(`UPDATE settings SET value='true'::jsonb WHERE key='registration_open'`);
  }
});

test('待审用户不能登录', async () => {
  await call('POST', '/api/auth/register', REG);
  const r = await call('POST', '/api/auth/login', { username: 'alice', password: 'hunter2hunter2' });
  assert.strictEqual(r.status, 403);
  assert.ok(!r.setSession);
});

test('被拒用户不能登录', async () => {
  await call('POST', '/api/auth/register', REG);
  await query(`UPDATE users SET status='rejected' WHERE username='alice'`);
  const r = await call('POST', '/api/auth/login', { username: 'alice', password: 'hunter2hunter2' });
  assert.strictEqual(r.status, 403);
});

test('被停用用户不能登录', async () => {
  await call('POST', '/api/auth/register', REG);
  await query(`UPDATE users SET status='suspended' WHERE username='alice'`);
  const r = await call('POST', '/api/auth/login', { username: 'alice', password: 'hunter2hunter2' });
  assert.strictEqual(r.status, 403);
});

test('通过后能登录并拿到会话', async () => {
  await call('POST', '/api/auth/register', REG);
  await query(`UPDATE users SET status='approved' WHERE username='alice'`);
  const r = await call('POST', '/api/auth/login', { username: 'alice', password: 'hunter2hunter2' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.setSession && r.setSession.id);
});

test('错密码 → 401,且与用户不存在的响应一致(不泄露账号是否存在)', async () => {
  await call('POST', '/api/auth/register', REG);
  await query(`UPDATE users SET status='approved' WHERE username='alice'`);
  const bad  = await call('POST', '/api/auth/login', { username: 'alice',  password: 'wrong-password' });
  const none = await call('POST', '/api/auth/login', { username: 'ghost',  password: 'wrong-password' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(none.status, 401);
  assert.deepStrictEqual(bad.data, none.data);
});

test('未登录 me → user 为 null', async () => {
  const r = await call('GET', '/api/auth/me');
  assert.strictEqual(r.data.user, null);
});

test('登出会带 clearSession', async () => {
  const admin = await seedAdmin();
  const r = await call('POST', '/api/auth/logout', {}, admin);
  assert.ok(r.clearSession);
});

test('settings/public 不泄露非公开配置', async () => {
  const r = await call('GET', '/api/settings/public');
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['registration_open']);
});

// 安全审查裁决:guard.js 把 review/decide/grant/clear/pending/suspend 六个词当保留动词,
// 出现在路径任意一段都会被判成后台路由(见 app/auth/guard.js ADMIN_VERBS)。
// 用户名若正好是这六个词之一,GET /api/members/:username 会被误判成后台路由,
// 永久打不开自己的主页——因此注册阶段必须拒绝这六个保留词作用户名。
test('用户名为保留动词(如 review)→ 400,防止 /api/members/:username 被误判为后台路由', async () => {
  const r = await call('POST', '/api/auth/register', { ...REG, username: 'review', email: 'review@example.com' });
  assert.strictEqual(r.status, 400);
  const u = await query('SELECT 1 FROM users WHERE username=$1', ['review']);
  assert.strictEqual(u.rowCount, 0);
});

test('站长通过后,该用户能登录且收到通知', async () => {
  const admin = await seedAdmin();
  await call('POST', '/api/auth/register', REG);
  const uid = (await query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;

  const rev = await call('POST', `/api/admin/users/${uid}/review`, { decision: 'approve' }, admin);
  assert.strictEqual(rev.status, 200);

  const login = await call('POST', '/api/auth/login', { username: 'alice', password: 'hunter2hunter2' });
  assert.strictEqual(login.status, 200);

  const n = await query('SELECT * FROM notifications WHERE user_id=$1', [uid]);
  assert.strictEqual(n.rowCount, 1);
});

// 修复回归(Fix 2):旧实现是 `body.decision === 'approve' ? 'approved' : 'rejected'`——
// 任何不是 'approve' 的值(空对象、拼写错、大小写不对)都会静默落到 rejected,
// 返回 200 {ok:true},且这是不可逆的:审核要求 status==='pending',第二次调用会
// 409,当事人也没法重新注册(用户名/邮箱已被占用),旧账号永久卡死。
// 同一份代码里 join-requests 的 /decision 端点早就验证了 decision 并 400——
// 这里补齐同一条规则。
test('格式错误的 decision(如 {})→ 400,不落到默认 rejected,行也不变', async () => {
  const admin = await seedAdmin();
  await call('POST', '/api/auth/register', REG);
  const uid = (await query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;
  const r = await call('POST', `/api/admin/users/${uid}/review`, {}, admin);
  assert.strictEqual(r.status, 400);
  const u = await query('SELECT status FROM users WHERE id=$1', [uid]);
  assert.strictEqual(u.rows[0].status, 'pending');
});

test('decision 拼写/大小写错误(如 "Approve")→ 400,不落到默认 rejected', async () => {
  const admin = await seedAdmin();
  await call('POST', '/api/auth/register', REG);
  const uid = (await query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;
  const r = await call('POST', `/api/admin/users/${uid}/review`, { decision: 'Approve' }, admin);
  assert.strictEqual(r.status, 400);
  const u = await query('SELECT status FROM users WHERE id=$1', [uid]);
  assert.strictEqual(u.rows[0].status, 'pending');
});

test('重复审核 → 409', async () => {
  const admin = await seedAdmin();
  await call('POST', '/api/auth/register', REG);
  const uid = (await query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;
  await call('POST', `/api/admin/users/${uid}/review`, { decision: 'approve' }, admin);
  const again = await call('POST', `/api/admin/users/${uid}/review`, { decision: 'approve' }, admin);
  assert.strictEqual(again.status, 409);
});

test('审核记录操作人', async () => {
  const admin = await seedAdmin();
  await call('POST', '/api/auth/register', REG);
  const uid = (await query(`SELECT id FROM users WHERE username='alice'`)).rows[0].id;
  await call('POST', `/api/admin/users/${uid}/review`, { decision: 'approve' }, admin);
  const u = (await query('SELECT reviewed_by, reviewed_at FROM users WHERE id=$1', [uid])).rows[0];
  assert.strictEqual(Number(u.reviewed_by), Number(admin.id));
  assert.ok(u.reviewed_at);
});

test('成员目录只含已通过的,且不含邮箱', async () => {
  await call('POST', '/api/auth/register', REG);                       // pending
  await call('POST', '/api/auth/register', { ...REG, username: 'bob', email: 'b@x.com' });
  await query(`UPDATE users SET status='approved' WHERE username='bob'`);
  const r = await call('GET', '/api/members');
  assert.strictEqual(r.data.members.length, 1);
  assert.strictEqual(r.data.members[0].username, 'bob');
  assert.ok(!('email' in r.data.members[0]), '成员目录不应含邮箱');
});

test('普通成员访问后台端点 → 403', async () => {
  const member = { id: 999, username: 'm', role: 'member', status: 'approved' };
  const r = await call('GET', '/api/admin/users/pending', {}, member);
  assert.strictEqual(r.status, 403);
});

test('匿名访问后台端点 → 401', async () => {
  const r = await call('GET', '/api/admin/users/pending');
  assert.strictEqual(r.status, 401);
});

// 修复回归:suspend 的自我停用防护是 `id === ctx.user.id`,pg 把 bigint
// 读成字符串,若 ctx.user.id 不是 Number 这个比较永远为 false,站长能把
// 自己停用并被立刻踢下线。session.js 的 getSession() 已把 user.id 钉死
// 为 Number(见 test/session.test.js),这里从 users.js 端点验证同一条防线。
test('站长停用自己的账号 → 400,状态不变', async () => {
  const admin = await seedAdmin();
  const r = await call('POST', `/api/admin/users/${admin.id}/suspend`, {}, admin);
  assert.strictEqual(r.status, 400);
  const u = await query('SELECT status FROM users WHERE id=$1', [admin.id]);
  assert.strictEqual(u.rows[0].status, 'approved');
});

// 修复回归(Fix 4):改密码 + 踢会话现在用 tx() 包成一个事务(app/routes/auth.js
// PATCH /api/me)。这里验证包完之后正常路径还是原来的行为:密码真的改了、
// 所有既有会话真的被清空——不是只测"包了 tx()"这件事本身(那个只能靠制造
// ROLLBACK 场景验证,单元测试里不好模拟第二条语句失败),而是确认原子化
// 这层包装没有破坏原有语义。
test('改密码:新密码生效,且该用户所有会话被清空(改密码+踢会话原子执行)', async () => {
  const admin = await seedAdmin();
  const s1 = await S.createSession(admin.id, {});
  const s2 = await S.createSession(admin.id, {});

  const r = await call('PATCH', '/api/me',
    { current_password: 'rootpassword', new_password: 'newpassword123' }, admin);
  assert.strictEqual(r.status, 200);
  assert.ok(r.clearSession);

  const u = await query('SELECT password_hash FROM users WHERE id=$1', [admin.id]);
  assert.ok(await verify('newpassword123', u.rows[0].password_hash), '密码哈希应该已经更新为新密码');
  assert.ok(!await verify('rootpassword', u.rows[0].password_hash), '旧密码不应该还能验证通过');

  assert.strictEqual(await S.getSession(s1.id), null);
  assert.strictEqual(await S.getSession(s2.id), null);
});

test('改密码:当前密码不对 → 403,密码和会话都不变', async () => {
  const admin = await seedAdmin();
  const s1 = await S.createSession(admin.id, {});

  const r = await call('PATCH', '/api/me',
    { current_password: 'wrong-password', new_password: 'newpassword123' }, admin);
  assert.strictEqual(r.status, 403);

  const u = await query('SELECT password_hash FROM users WHERE id=$1', [admin.id]);
  assert.ok(await verify('rootpassword', u.rows[0].password_hash), '密码不应该被改动');
  assert.ok(await S.getSession(s1.id), '会话不应该被踢');
});
