// 修复回归(Fix 7):create-admin 建站长账号时没有套注册端点自己的两条校验
// (保留动词 / 用户名格式),站长要是给自己取名叫 pending 就永久打不开自己的
// 主页(GET /api/members/:username 会被路由守卫当成后台路径)。这里把 CLI
// 脚本当子进程真的跑起来(走 ADMIN_USER/ADMIN_PASSWORD 环境变量这条 Docker
// 首启会走的路径,不需要 TTY),断言坏用户名被拒绝、不落库,合法用户名正常建号。
import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { resetDb, query } from './helpers/db';

const SCRIPT = join(import.meta.dir, '..', 'app', 'bin', 'create-admin.ts');

interface RunResult { code: number; stdout: string; stderr: string }

function runCreateAdmin(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    // bun test 下 process.execPath 指向 bun 可执行文件,子进程即
    // `bun app/bin/create-admin.ts` —— bun 直接跑 TS,不需要转译产物。
    // env 里继承的 DATABASE_URL 已被 helpers/env.ts 覆写成测试库
    // (Bun 不会用 .env 覆盖已存在的进程环境变量),子进程建的站长落测试库。
    execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      timeout: 15000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0,
                stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

beforeEach(resetDb);

// 三个用例都要起子进程 + scrypt(N=65536)+ pg 连接,远超 bun test 默认的
// 单用例 5s 超时,显式放宽到 30s(execFile 自身 15s 先兜)。
test('ADMIN_USER 是保留动词(如 pending)→ CLI 拒绝创建,不落库', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'pending', ADMIN_PASSWORD: 'longenough123' });
  assert.notStrictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /保留词/);
  const row = await query('SELECT 1 FROM users WHERE username=$1', ['pending']);
  assert.strictEqual(row.rowCount, 0);
}, 30000);

test('ADMIN_USER 不满足用户名格式(含大写字母)→ CLI 拒绝创建,不落库', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'Root', ADMIN_PASSWORD: 'longenough123' });
  assert.notStrictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /字母、数字、下划线或连字符/);
  const row = await query('SELECT 1 FROM users WHERE username=$1', ['Root']);
  assert.strictEqual(row.rowCount, 0);
}, 30000);

test('合法用户名 → 正常建站长账号(role=admin, status=approved)', async () => {
  const r = await runCreateAdmin({ ADMIN_USER: 'siteroot', ADMIN_PASSWORD: 'longenough123' });
  assert.strictEqual(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  const row = await query(`SELECT role, status FROM users WHERE username='siteroot'`);
  assert.strictEqual(row.rowCount, 1);
  assert.strictEqual((row.rows[0] as any).role, 'admin');
  assert.strictEqual((row.rows[0] as any).status, 'approved');
}, 30000);
