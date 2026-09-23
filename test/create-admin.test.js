'use strict';
// 修复回归(Fix 7):create-admin.js 建站长账号时没有套注册端点自己的两条校验
// (保留动词 / 用户名格式),站长要是给自己取名叫 pending 就永久打不开自己的
// 主页(GET /api/members/:username 会被路由守卫当成后台路径)。这里把 CLI
// 脚本当子进程真的跑起来(走 ADMIN_USER/ADMIN_PASSWORD 环境变量这条 Docker
// 首启会走的路径,不需要 TTY),断言坏用户名被拒绝、不落库,合法用户名正常建号。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resetDb, closeDb, query } = require('./helpers/db');

const SCRIPT = path.join(__dirname, '..', 'app', 'bin', 'create-admin.js');

function runCreateAdmin(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      timeout: 15000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

test.beforeEach(resetDb);
test.after(closeDb);

test('ADMIN_USER 是保留动词(如 pending)→ CLI 拒绝创建,不落库', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'pending', ADMIN_PASSWORD: 'longenough123' });
  assert.notStrictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /保留词/);
  const row = await query('SELECT 1 FROM users WHERE username=$1', ['pending']);
  assert.strictEqual(row.rowCount, 0);
});

test('ADMIN_USER 不满足用户名格式(含大写字母)→ CLI 拒绝创建,不落库', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'Root', ADMIN_PASSWORD: 'longenough123' });
  assert.notStrictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /字母、数字、下划线或连字符/);
  const row = await query('SELECT 1 FROM users WHERE username=$1', ['Root']);
  assert.strictEqual(row.rowCount, 0);
});

test('合法用户名 → 正常建站长账号(role=admin, status=approved)', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'siteroot', ADMIN_PASSWORD: 'longenough123' });
  assert.strictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  const row = await query(`SELECT role, status FROM users WHERE username='siteroot'`);
  assert.strictEqual(row.rowCount, 1);
  assert.strictEqual(row.rows[0].role, 'admin');
  assert.strictEqual(row.rows[0].status, 'approved');
});
