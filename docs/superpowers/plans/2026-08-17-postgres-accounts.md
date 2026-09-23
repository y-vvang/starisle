# 星屿 PostgreSQL 重构 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把星屿从内存态演示改造成跑在 PostgreSQL 上的真实小型社区站：站长审核放人进来，成员发布归属于自己的项目。

**Architecture:** 后端从「一个 1050 行 if 链 + 内存对象」拆成分层模块（`db/` `auth/` `routes/`），数据落 PostgreSQL。身份从「请求体自述 + 共享口令」改为「用户名密码 + 服务端会话表 + HttpOnly cookie」。P0 那张**默认拒绝**的路由分级表整体保留，只把判定依据从「口令是否匹配」换成「会话对应的 `user.role` 是否为 admin」。

**Tech Stack:** Node 24（CommonJS）、PostgreSQL 17、`pg`（唯一新增运行时依赖）、`node:crypto` scrypt、`node:test`、Vue 3 + Vite（前端沿用）、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-08-17-postgres-accounts-design.md`

## Global Constraints

- **唯一允许新增的运行时依赖是 `pg`。** 密码哈希用 `node:crypto` 的 scrypt，测试用 `node:test`，不引 argon2 / bcrypt / express / jest。
- **后端一律 CommonJS**（`require`/`module.exports`），与现有 `app/server.js` 一致；根 `package.json` 不加 `"type": "module"`。
- **不写任何 dummy / 种子业务数据。** migration 只种 6 行 `domains` 与 1 行 `settings`。
- **默认拒绝**：任何新端点若未登记进 `PUBLIC_ROUTES`，必须被判为后台。这条有回归测试守着，不得放宽。
- **不收未成年人敏感信息**：注册字段只有 username / password / display_name / email / repo_url / apply_note。不加真名、年龄、学校、手机。
- **前端改动一律用 `browser-eyes` skill 在真实浏览器里看过再算完成**（CLAUDE.md 要求）。
- Shell 用 PowerShell 5.1 时注意：没有 `&&`，用 `A; if ($?) { B }`。

## 前置条件（开工前人工确认）

- [ ] **Docker Desktop 正在运行**（当前实测未运行：`docker ps` 报 `failed to connect to the docker API at npipe:...`）。阶段①第一步就要起 Postgres 容器。
- [ ] 当前分支 `pg-rewrite`（基于 `p0-admin-auth` 的 `465b79d`）。`p0-admin-auth` 尚未推送到 origin——若要先合进 master，现在是最后的干净时机。

## 文件结构

```
app/
  server.js                   HTTP 入口:静态文件、cookie 解析/写入、把请求交给 routes/index
  db/pool.js                  pg Pool 单例 + query() + tx() 助手
  db/migrate.js               按文件名顺序执行 migrations/*.sql,记录进 schema_migrations
  db/migrations/001_init.sql  全部建表 + domains/settings 种子
  auth/password.js            hash() / verify()          —— 无 DB 依赖,纯函数,好测
  auth/session.js             create/get/destroy/destroyAllForUser/cleanupExpired
  auth/guard.js               ADMIN_VERBS/ADMIN_ROUTES/PUBLIC_ROUTES + needsAdmin()
  lib/slug.js                 slugify() / uniqueSlug()
  routes/index.js             分发 + guard,唯一知道「所有路由」的地方
  routes/auth.js  users.js  projects.js  domains.js  notifications.js  settings.js
  bin/create-admin.js         建站长账号 CLI
test/
  helpers/db.js               连测试库 + resetDb()(TRUNCATE ... RESTART IDENTITY CASCADE)
  password.test.js  session.test.js  guard.test.js  slug.test.js
  auth-routes.test.js  projects-routes.test.js
```

**为什么这样切**：`password.js` 与 `guard.js` 无 DB 依赖，是纯函数，能被最快最密地测；`session.js` 只碰 sessions/users 两张表；每个 `routes/*.js` 只负责一个资源。现有 `core.js` 把路由、鉴权、业务、数据访问四件事塞在一个文件里，是这次要解决的问题本身。

---

# 阶段① 地基

产出：一个能连库、能建站长账号、密码与会话有测试保护的后端骨架。此阶段结束时前台仍是旧的，不影响。

### Task 1: Postgres 容器 + 依赖 + npm 脚本

**Files:**
- Modify: `docker-compose.yml`（当前只有 `app` 一个服务）
- Modify: `package.json`
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 环境变量 `DATABASE_URL`、`TEST_DATABASE_URL`；npm 脚本 `db:up` `migrate` `test`

- [ ] **Step 1: 改写 `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:17-alpine
    container_name: starisle-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: starisle
      POSTGRES_USER: starisle
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-devpass}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U starisle -d starisle"]
      interval: 3s
      timeout: 3s
      retries: 20

volumes:
  pgdata:
```

> `app` 服务先删掉——它现在 build 出来的镜像里是旧代码，留着只会误导。阶段⑤再加回来。

- [ ] **Step 2: 装 `pg`,改脚本**

```bash
npm install pg@^8.13.0
```

`package.json` 的 `scripts` 改成（**删掉 `dev:worker` 与 `deploy` 两个 wrangler 脚本**）：

```json
"scripts": {
  "start": "node app/server.js",
  "db:up": "docker compose up -d db",
  "migrate": "node app/db/migrate.js",
  "create-admin": "node app/bin/create-admin.js",
  "test": "node --test test/"
}
```

- [ ] **Step 3: `.env.example`**

```
DATABASE_URL=postgres://starisle:devpass@localhost:5432/starisle
TEST_DATABASE_URL=postgres://starisle:devpass@localhost:5432/starisle_test
SESSION_SECURE=0
PORT=4870
```

`.gitignore` 里已有 `.env` 与 `.env.*`，确认无需再加。

- [ ] **Step 4: 起库并建测试库**

```bash
npm run db:up
docker exec starisle-db psql -U starisle -d starisle -c "CREATE DATABASE starisle_test OWNER starisle;"
```

预期：第二条输出 `CREATE DATABASE`。

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml package.json package-lock.json .env.example
git commit -m "地基:Postgres 容器 + pg 依赖 + npm 脚本"
```

---

### Task 2: 连接池与 migration runner

**Files:**
- Create: `app/db/pool.js`
- Create: `app/db/migrate.js`
- Create: `app/db/migrations/001_init.sql`

**Interfaces:**
- Produces: `pool`、`query(text, params)`、`tx(fn)`；命令 `npm run migrate`

- [ ] **Step 1: `app/db/pool.js`**

```js
'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺少 DATABASE_URL。复制 .env.example 并按其中说明设置。');
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 10 });

pool.on('error', (err) => {
  // 空闲连接被服务端掐断时会走到这里;不要让它掀翻进程
  console.error('[db] 空闲连接出错:', err.message);
});

const query = (text, params) => pool.query(text, params);

// 事务助手:回调拿到 client,抛异常自动回滚
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
```

- [ ] **Step 2: `app/db/migrations/001_init.sql`**

照抄 spec「二、数据库」一节的全部建表语句，并在末尾追加种子：

```sql
INSERT INTO domains (id, name, color, sort) VALUES
  ('agent',    'Agent 与工具',  '#2f6fd0', 1),
  ('edu',      '教育公平',      '#c2891b', 2),
  ('climate',  '气候与环境',    '#2f6fd0', 3),
  ('health',   '医疗健康',      '#c2891b', 4),
  ('creative', '创意与艺术',    '#c2891b', 5),
  ('infra',    '开源基础设施',  '#2f6fd0', 6);

INSERT INTO settings (key, value) VALUES ('registration_open', 'true'::jsonb);
```

> 领域的 id/name/color 与 `app/data/seed.js:18-25` 现有定义一致——前端的领域配色沿用，视觉不会突变。

- [ ] **Step 3: `app/db/migrate.js`**

```js
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
```

- [ ] **Step 4: 跑 migration,两次**

```bash
node -r dotenv/config app/db/migrate.js   # 若不想引 dotenv,先手动 set DATABASE_URL
```

PowerShell 下：
```powershell
$env:DATABASE_URL='postgres://starisle:devpass@localhost:5432/starisle'; npm run migrate
```

预期第一次输出 `应用 001_init.sql`，**第二次输出 `跳过 001_init.sql(已应用)`**——这一条验证幂等，别省。

- [ ] **Step 5: 对测试库也跑一遍**

```powershell
$env:DATABASE_URL='postgres://starisle:devpass@localhost:5432/starisle_test'; npm run migrate
```

- [ ] **Step 6: 验证表结构**

```bash
docker exec starisle-db psql -U starisle -d starisle -c "\dt"
```
预期看到 8 张表（7 张业务表 + `schema_migrations`）。

```bash
docker exec starisle-db psql -U starisle -d starisle -c "SELECT id,name FROM domains ORDER BY sort;"
```
预期 6 行。

- [ ] **Step 7: Commit**

```bash
git add app/db/
git commit -m "地基:连接池、migration runner、初始 schema"
```

---

### Task 3: 密码哈希

**Files:**
- Create: `app/auth/password.js`
- Test: `test/password.test.js`

**Interfaces:**
- Produces: `hash(plain) -> Promise<string>`、`verify(plain, stored) -> Promise<boolean>`
- 存储格式：`scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>`

- [ ] **Step 1: 写失败的测试 `test/password.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hash, verify } = require('../app/auth/password');

test('哈希结果不包含明文', async () => {
  const h = await hash('correct horse battery staple');
  assert.ok(!h.includes('correct'));
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
});

test('同一密码两次哈希不同(盐生效)', async () => {
  const a = await hash('same-password');
  const b = await hash('same-password');
  assert.notStrictEqual(a, b);
});

test('正确密码通过', async () => {
  const h = await hash('s3cret-pw');
  assert.strictEqual(await verify('s3cret-pw', h), true);
});

test('错误密码不通过', async () => {
  const h = await hash('s3cret-pw');
  assert.strictEqual(await verify('s3cret-pwX', h), false);
  assert.strictEqual(await verify('', h), false);
});

test('畸形存储值返回 false 而不是抛异常', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$x$y$z$w']) {
    assert.strictEqual(await verify('any', bad), false, `畸形值应返回 false: ${bad}`);
  }
});

test('长度不同的哈希不会因 timingSafeEqual 抛异常', async () => {
  const h = await hash('pw');
  const tampered = h.slice(0, -4);           // 截断 base64
  assert.strictEqual(await verify('pw', tampered), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/password.test.js
```
预期：`Cannot find module '../app/auth/password'`

- [ ] **Step 3: 写 `app/auth/password.js`**

```js
'use strict';
const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');

// N=2^15。注意:scrypt 内存约 128*N*r = 32MB,正好等于 Node 默认 maxmem,
// 不显式抬高 maxmem 会直接抛 "memory limit exceeded"。
const N = 32768, R = 8, P = 1, KEYLEN = 32, MAXMEM = 96 * 1024 * 1024;

const derive = (plain, salt, n, r, p) =>
  new Promise((resolve, reject) => {
    scrypt(plain, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });

async function hash(plain) {
  const salt = randomBytes(16);
  const key = await derive(String(plain), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verify(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(String(plain), salt, +n, +r, +p);
    // 长度不等时 timingSafeEqual 会抛,先挡掉
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

module.exports = { hash, verify };
```

- [ ] **Step 4: 跑测试确认全过**

```bash
node --test test/password.test.js
```
预期：6 个测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add app/auth/password.js test/password.test.js
git commit -m "地基:scrypt 密码哈希 + 测试"
```

---

### Task 4: 测试库助手

**Files:**
- Create: `test/helpers/db.js`

**Interfaces:**
- Produces: `resetDb()`（清空全部业务表并重置自增）、`closeDb()`

> 采用 TRUNCATE 而非事务回滚：模块级连接池下让一个测试内所有查询共用同一个 client 很别扭，而本项目表少、数据量小，TRUNCATE 又快又不会出错。

- [ ] **Step 1: 写 `test/helpers/db.js`**

```js
'use strict';
// 测试一律打 TEST_DATABASE_URL,绝不碰开发库
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://starisle:devpass@localhost:5432/starisle_test';

const { pool, query } = require('../../app/db/pool');

// 顺序无所谓,CASCADE 会处理外键
const TABLES = ['sessions', 'notifications', 'project_members', 'projects', 'users'];

async function resetDb() {
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

const closeDb = () => pool.end();

module.exports = { resetDb, closeDb, query, pool };
```

> 注意 `domains` 与 `settings` **不在** TRUNCATE 列表里——它们是 migration 种下的配置数据，清掉会让后续测试莫名其妙地失败。

- [ ] **Step 2: 冒烟验证**

```bash
node -e "const {resetDb,closeDb,query}=require('./test/helpers/db');(async()=>{await resetDb();const r=await query('SELECT count(*) FROM domains');console.log('domains 仍在:',r.rows[0].count);await closeDb();})()"
```
预期输出 `domains 仍在: 6`。

- [ ] **Step 3: Commit**

```bash
git add test/helpers/db.js
git commit -m "地基:测试库助手"
```

---

### Task 5: 会话

**Files:**
- Create: `app/auth/session.js`
- Test: `test/session.test.js`

**Interfaces:**
- Consumes: `db/pool.js` 的 `query`
- Produces:
  - `createSession(userId, { userAgent, ip, days }) -> Promise<{ id, expiresAt }>`
  - `getSession(id) -> Promise<{ id, user: {id, username, display_name, role, status} } | null>`
  - `destroySession(id) -> Promise<void>`
  - `destroyUserSessions(userId) -> Promise<void>`
  - `cleanupExpired() -> Promise<number>`

- [ ] **Step 1: 写失败的测试 `test/session.test.js`**

```js
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
  return r.rows[0].id;
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/session.test.js
```
预期：`Cannot find module '../app/auth/session'`

- [ ] **Step 3: 写 `app/auth/session.js`**

```js
'use strict';
const { randomBytes } = require('node:crypto');
const { query } = require('../db/pool');

const DEFAULT_DAYS = 30;

async function createSession(userId, { userAgent = null, ip = null, days = DEFAULT_DAYS } = {}) {
  const id = randomBytes(32).toString('base64url');
  const r = await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)
     RETURNING expires_at`,
    [id, userId, String(days), userAgent, ip]
  );
  return { id, expiresAt: r.rows[0].expires_at };
}

async function getSession(id) {
  if (!id || typeof id !== 'string') return null;
  const r = await query(
    `SELECT s.id, u.id AS user_id, u.username, u.display_name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id]
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return {
    id: x.id,
    user: { id: x.user_id, username: x.username, display_name: x.display_name,
            role: x.role, status: x.status },
  };
}

const destroySession = (id) => query('DELETE FROM sessions WHERE id=$1', [id]).then(() => undefined);
const destroyUserSessions = (userId) =>
  query('DELETE FROM sessions WHERE user_id=$1', [userId]).then(() => undefined);
const cleanupExpired = () =>
  query('DELETE FROM sessions WHERE expires_at <= now()').then(r => r.rowCount);

module.exports = { createSession, getSession, destroySession, destroyUserSessions, cleanupExpired };
```

- [ ] **Step 4: 跑测试确认全过**

```bash
node --test test/session.test.js
```
预期：8 个测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add app/auth/session.js test/session.test.js
git commit -m "地基:会话表与签发/吊销 + 测试"
```

---

### Task 6: 建站长账号 CLI

**Files:**
- Create: `app/bin/create-admin.js`

**Interfaces:**
- Consumes: `auth/password.js` 的 `hash`、`db/pool.js` 的 `query`
- Produces: `npm run create-admin`

- [ ] **Step 1: 写 `app/bin/create-admin.js`**

```js
'use strict';
// 建站长账号。交互式;也支持环境变量(docker 首启用)。
const readline = require('node:readline');
const { query, pool } = require('../db/pool');
const { hash } = require('../auth/password');

function ask(rl, q, { silent = false } = {}) {
  if (!silent) return new Promise(res => rl.question(q, res));
  // 静默输入:不回显密码
  return new Promise(res => {
    const onData = (ch) => {
      if (['\n', '\r', ''].includes(ch.toString())) {
        process.stdin.removeListener('data', onData);
      } else {
        process.stdout.write('\x1B[2K\x1B[200D' + q + '*'.repeat(rl.line.length));
      }
    };
    process.stdin.on('data', onData);
    rl.question(q, (v) => { process.stdout.write('\n'); res(v); });
  });
}

async function main() {
  const envUser = process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD;

  let username, password, email, displayName;

  if (envUser && envPass) {
    username = envUser; password = envPass;
    email = process.env.ADMIN_EMAIL || `${envUser}@localhost`;
    displayName = process.env.ADMIN_DISPLAY_NAME || envUser;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username    = (await ask(rl, '用户名: ')).trim();
    displayName = (await ask(rl, '显示名: ')).trim() || username;
    email       = (await ask(rl, '邮箱: ')).trim();
    password    = await ask(rl, '密码: ', { silent: true });
    rl.close();
  }

  if (!username || !password || !email) {
    console.error('用户名、密码、邮箱都不能为空'); process.exit(1);
  }
  if (password.length < 8) {
    console.error('密码至少 8 位'); process.exit(1);
  }

  const dup = await query('SELECT 1 FROM users WHERE username=$1 OR email=$2', [username, email]);
  if (dup.rowCount) {
    console.error('该用户名或邮箱已存在'); process.exit(1);
  }

  const password_hash = await hash(password);
  const r = await query(
    `INSERT INTO users (username, password_hash, display_name, email, role, status)
     VALUES ($1,$2,$3,$4,'admin','approved') RETURNING id`,
    [username, password_hash, displayName, email]
  );
  console.log(`站长账号已创建:${username}(id=${r.rows[0].id})`);
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: 建一个站长账号**

```powershell
$env:DATABASE_URL='postgres://starisle:devpass@localhost:5432/starisle'; npm run create-admin
```

- [ ] **Step 3: 验证落库且密码可校验**

```bash
docker exec starisle-db psql -U starisle -d starisle -c "SELECT id,username,role,status,left(password_hash,12) FROM users;"
```
预期：一行，`role=admin`、`status=approved`、`password_hash` 以 `scrypt$32768` 开头。

- [ ] **Step 4: 验证重复建号被拒**

再跑一次 `npm run create-admin`，用同一个用户名。预期：`该用户名或邮箱已存在`，退出码 1。

- [ ] **Step 5: Commit**

```bash
git add app/bin/create-admin.js
git commit -m "地基:建站长账号 CLI"
```

**阶段① 验收**：`npm test` 全绿（password + session 共 14 个用例）；库里有一个站长账号；`npm run migrate` 幂等。

---

# 阶段② 账号闭环

产出：curl 能走完「注册 → 待审不能登录 → 站长通过 → 能登录」。

### Task 7: 路由分级守卫

**Files:**
- Create: `app/auth/guard.js`（从 `app/core.js` 搬 `ADMIN_VERBS`/`matchRoute`/`needsAdmin` 并换成新 API 面）
- Test: `test/guard.test.js`

**Interfaces:**
- Produces: `needsAdmin(method, seg) -> boolean`，其中 `seg = pathname.split('/').filter(Boolean)`

- [ ] **Step 1: 写失败的测试 `test/guard.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { needsAdmin } = require('../app/auth/guard');

const seg = p => p.split('/').filter(Boolean);
const isAdmin  = (m, p) => assert.strictEqual(needsAdmin(m, seg(p)), true,  `${m} ${p} 应为后台`);
const isPublic = (m, p) => assert.strictEqual(needsAdmin(m, seg(p)), false, `${m} ${p} 应为公开`);

test('公开端点', () => {
  isPublic('POST', '/api/auth/register');
  isPublic('POST', '/api/auth/login');
  isPublic('POST', '/api/auth/logout');
  isPublic('GET',  '/api/auth/me');
  isPublic('GET',  '/api/domains');
  isPublic('GET',  '/api/stats');
  isPublic('GET',  '/api/projects');
  isPublic('GET',  '/api/projects/lumen');
  isPublic('GET',  '/api/members');
  isPublic('GET',  '/api/members/alice');
  isPublic('GET',  '/api/settings/public');
});

test('登录成员端点也走公开档(由 handler 自己校验登录态)', () => {
  isPublic('POST',  '/api/projects');
  isPublic('PATCH', '/api/projects/lumen');
  isPublic('POST',  '/api/projects/lumen/members');
  isPublic('GET',   '/api/notifications');
  isPublic('POST',  '/api/notifications/read');
  isPublic('PATCH', '/api/me');
});

test('后台端点', () => {
  isAdmin('GET',   '/api/admin/users/pending');
  isAdmin('POST',  '/api/admin/users/7/review');
  isAdmin('POST',  '/api/admin/users/7/suspend');
  isAdmin('GET',   '/api/admin/projects/pending');
  isAdmin('POST',  '/api/admin/projects/7/review');
  isAdmin('PATCH', '/api/admin/settings');
});

test('任何 /api/admin/* 一律后台,包括还没写的', () => {
  isAdmin('GET',    '/api/admin/whatever');
  isAdmin('POST',   '/api/admin/a/b/c/d');
  isAdmin('DELETE', '/api/admin/users/1');
});

test('保留动词即后台,不依赖有人记得改表', () => {
  isAdmin('POST', '/api/projects/7/review');
  isAdmin('GET',  '/api/courses/pending');
  isAdmin('POST', '/api/anything/decide');
});

test('默认拒绝:未登记的路径判为后台', () => {
  isAdmin('GET',  '/api/nonexistent');
  isAdmin('POST', '/api/some/new/endpoint');
  isAdmin('GET',  '/api/users');            // 老的 PII 端点,已不存在,也必须是后台
});

test('方法敏感:GET 公开不等于 DELETE 公开', () => {
  isPublic('GET',    '/api/projects');
  isAdmin ('DELETE', '/api/projects');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/guard.test.js
```

- [ ] **Step 3: 写 `app/auth/guard.js`**

```js
'use strict';
/* 路由分级。判定顺序:
   ① /api/admin/* 一律后台 → ② 保留动词 → ③ 公开白名单 → ④ 默认拒绝。
   ④ 是刻意的:漏登记的新端点会立刻 401(响亮),而不是静默公开(致命)。 */

const ADMIN_VERBS = new Set(['review', 'decide', 'grant', 'clear', 'pending', 'suspend']);

const PUBLIC_ROUTES = [
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/domains', 'GET /api/stats', 'GET /api/settings/public',
  'GET /api/projects', 'POST /api/projects',
  'GET /api/projects/:slug', 'PATCH /api/projects/:slug',
  'POST /api/projects/:slug/members',
  'GET /api/members', 'GET /api/members/:username',
  'GET /api/notifications', 'POST /api/notifications/read',
  'PATCH /api/me',
];

function matchRoute(rule, method, seg) {
  const sp = rule.indexOf(' ');
  if (rule.slice(0, sp) !== method) return false;
  const rs = rule.slice(sp + 1).split('/').filter(Boolean);
  if (rs.length !== seg.length) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i][0] !== ':' && rs[i] !== seg[i]) return false;
  }
  return true;
}

function needsAdmin(method, seg) {
  if (seg[1] === 'admin') return true;                              // ①
  if (seg.some(s => ADMIN_VERBS.has(s))) return true;               // ②
  if (PUBLIC_ROUTES.some(r => matchRoute(r, method, seg))) return false; // ③
  return true;                                                       // ④
}

module.exports = { needsAdmin, matchRoute, PUBLIC_ROUTES, ADMIN_VERBS };
```

> 与 P0 版本的差别：新增了「`/api/admin/*` 一律后台」这一层，比逐条登记更难出错；`ADMIN_ROUTES` 显式表因此不再需要。「登录成员」端点走公开档，登录与否由各 handler 自己判——守卫只管「是不是站长专属」，不管「要不要登录」，两件事分开更清楚。

- [ ] **Step 4: 跑测试确认全过**

```bash
node --test test/guard.test.js
```
预期：7 个测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add app/auth/guard.js test/guard.test.js
git commit -m "账号:路由分级守卫(默认拒绝)+ 测试"
```

---

### Task 8: HTTP 骨架与 cookie

**Files:**
- Rewrite: `app/server.js`
- Create: `app/routes/index.js`

**Interfaces:**
- Produces: `routes/index.js` 导出 `handle(ctx) -> Promise<{status, data, cookies?}>`；`ctx = { method, path, seg, query, body, user, session, userAgent, ip }`

- [ ] **Step 1: 写 `app/routes/index.js`**

```js
'use strict';
const { needsAdmin } = require('../auth/guard');

const D = (data, status = 200) => ({ status, data });

const HANDLERS = [
  require('./auth'),
  require('./domains'),
  require('./settings'),
  require('./projects'),
  require('./users'),
  require('./notifications'),
];

async function handle(ctx) {
  if (needsAdmin(ctx.method, ctx.seg) && (!ctx.user || ctx.user.role !== 'admin')) {
    return D({ error: '需要站长身份', code: 'admin_required' }, ctx.user ? 403 : 401);
  }
  for (const h of HANDLERS) {
    const r = await h(ctx, D);
    if (r) return r;
  }
  return D({ error: 'unknown api' }, 404);
}

module.exports = { handle, D };
```

> 每个 `routes/*.js` 导出 `async (ctx, D) => 命中则返回 {status,data},否则返回 undefined`。这样「所有路由在哪」只有 `HANDLERS` 一处答案。

- [ ] **Step 2: 重写 `app/server.js`**

保留现有的静态文件服务与 MIME 表（`app/server.js` 现有实现可直接沿用），替换 `/api/*` 分支：

```js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./routes');
const { getSession, cleanupExpired } = require('./auth/session');

const PORT = process.env.PORT || 4870;
const SECURE = process.env.SESSION_SECURE === '1';
const COOKIE = 'starisle_sid';

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json',
  '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2' };
const PUB = path.join(__dirname, 'public-dist');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, clear } = {}) {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (SECURE) bits.push('Secure');
  bits.push(`Max-Age=${clear ? 0 : Math.floor(maxAge)}`);
  return bits.join('; ');
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      const cookies = parseCookies(req.headers.cookie);
      const session = await getSession(cookies[COOKIE]);
      const body = (req.method === 'GET' || req.method === 'HEAD') ? {} : await readBody(req);
      const r = await handle({
        method: req.method, path: p, seg: p.split('/').filter(Boolean),
        query: u.searchParams, body,
        session, user: session ? session.user : null,
        userAgent: req.headers['user-agent'] || null,
        ip: req.socket.remoteAddress || null,
      });
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (r.setSession) headers['Set-Cookie'] = serializeCookie(COOKIE, r.setSession.id, { maxAge: r.setSession.maxAge });
      if (r.clearSession) headers['Set-Cookie'] = serializeCookie(COOKIE, '', { clear: true });
      res.writeHead(r.status, headers);
      return res.end(JSON.stringify(r.data));
    }
    const file = p === '/' ? '/index.html' : p;
    const full = path.join(PUB, path.normalize(file));
    if (!full.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error('[api]', e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '服务端错误' }));
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`端口 ${PORT} 已被占用`); process.exit(1); }
  throw e;
});

server.listen(PORT, async () => {
  const n = await cleanupExpired().catch(() => 0);
  console.log(`\n  ✦ 星屿 Starisle`);
  console.log(`  主站     http://localhost:${PORT}/`);
  console.log(`  控制台   http://localhost:${PORT}/admin.html`);
  if (n) console.log(`  清理了 ${n} 条过期会话`);
  console.log('');
});
```

- [ ] **Step 3: 建 6 个空 handler 占位,让 `require` 不炸**

对 `auth` `domains` `settings` `projects` `users` `notifications` 各建一个：

```js
'use strict';
module.exports = async function (ctx, D) { return undefined; };
```

- [ ] **Step 4: 启动确认不崩**

```powershell
$env:DATABASE_URL='postgres://starisle:devpass@localhost:5432/starisle'; npm start
```
另开一个终端：
```bash
curl -i http://localhost:4870/api/nonexistent
```
预期：**401**（默认拒绝生效，且未登录），body 含 `admin_required`。

- [ ] **Step 5: Commit**

```bash
git add app/server.js app/routes/
git commit -m "账号:HTTP 骨架、cookie 解析、路由分发"
```

---

### Task 9: 注册 / 登录 / 登出 / me

**Files:**
- Rewrite: `app/routes/auth.js`
- Rewrite: `app/routes/settings.js`
- Test: `test/auth-routes.test.js`

**Interfaces:**
- Consumes: `auth/password.js`、`auth/session.js`、`db/pool.js`
- Produces: handler 返回值可带 `setSession: {id, maxAge}` / `clearSession: true`

- [ ] **Step 1: 写失败的测试 `test/auth-routes.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { handle } = require('../app/routes');
const { hash } = require('../app/auth/password');

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
  return { id: r.rows[0].id, username: 'root', role: 'admin', status: 'approved' };
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
  const r = await call('POST', '/api/auth/register', REG);
  assert.strictEqual(r.status, 403);
  await query(`UPDATE settings SET value='true'::jsonb WHERE key='registration_open'`);
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/auth-routes.test.js
```

- [ ] **Step 3: 写 `app/routes/settings.js`**

```js
'use strict';
const { query } = require('../db/pool');

async function getSetting(key, fallback) {
  const r = await query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}

module.exports = async function settingsRoutes(ctx, D) {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/settings/public') {
    return D({ registration_open: await getSetting('registration_open', true) });
  }

  if (method === 'PATCH' && path === '/api/admin/settings') {
    if (typeof ctx.body.registration_open === 'boolean') {
      await query(
        `INSERT INTO settings (key, value) VALUES ('registration_open', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(ctx.body.registration_open)]
      );
    }
    return D({ ok: true, registration_open: await getSetting('registration_open', true) });
  }
};

module.exports.getSetting = getSetting;
```

- [ ] **Step 4: 写 `app/routes/auth.js`**

```js
'use strict';
const { query } = require('../db/pool');
const { hash, verify } = require('../auth/password');
const { createSession, destroySession, destroyUserSessions } = require('../auth/session');
const { getSetting } = require('./settings');

const DAYS = 30;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const publicUser = u => ({ id: u.id, username: u.username, display_name: u.display_name,
                           email: u.email, repo_url: u.repo_url, bio: u.bio,
                           role: u.role, status: u.status, created_at: u.created_at });

module.exports = async function authRoutes(ctx, D) {
  const { method, path, body } = ctx;

  if (method === 'POST' && path === '/api/auth/register') {
    if (await getSetting('registration_open', true) !== true) {
      return D({ error: '暂未开放注册' }, 403);
    }
    const username = str(body.username, 32).toLowerCase();
    const password = String(body.password || '');
    const display_name = str(body.display_name, 32) || username;
    const email = str(body.email, 120).toLowerCase();
    const repo_url = str(body.repo_url, 200);
    const apply_note = str(body.apply_note, 500);

    if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
      return D({ error: '用户名只能是 3–32 位的字母、数字、下划线或连字符' }, 400);
    }
    if (password.length < 8) return D({ error: '密码至少 8 位' }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return D({ error: '邮箱格式不对' }, 400);
    if (apply_note.length < 10) return D({ error: '请写至少 10 字的申请说明' }, 400);

    const dup = await query('SELECT 1 FROM users WHERE username=$1 OR email=$2', [username, email]);
    if (dup.rowCount) return D({ error: '该用户名或邮箱已被使用' }, 409);

    await query(
      `INSERT INTO users (username,password_hash,display_name,email,repo_url,apply_note,role,status)
       VALUES ($1,$2,$3,$4,$5,$6,'member','pending')`,
      [username, await hash(password), display_name, email, repo_url || null, apply_note]
    );
    return D({ ok: true, note: '已提交,站长审核通过后即可登录。' });
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const username = str(body.username, 32).toLowerCase();
    const password = String(body.password || '');
    const r = await query('SELECT * FROM users WHERE username=$1', [username]);
    const u = r.rows[0];
    // 用户不存在时也跑一次哈希,避免用响应时间区分账号是否存在
    const ok = u ? await verify(password, u.password_hash)
                 : await verify(password, 'scrypt$32768$8$1$AAAA$AAAA');
    if (!u || !ok) return D({ error: '用户名或密码不对' }, 401);

    if (u.status === 'pending')   return D({ error: '申请审核中,通过后即可登录' }, 403);
    if (u.status === 'rejected')  return D({ error: '申请未通过' }, 403);
    if (u.status === 'suspended') return D({ error: '账号已被停用' }, 403);

    const s = await createSession(u.id, { userAgent: ctx.userAgent, ip: ctx.ip, days: DAYS });
    return { status: 200, data: { ok: true, user: publicUser(u) },
             setSession: { id: s.id, maxAge: DAYS * 86400 } };
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    if (ctx.session) await destroySession(ctx.session.id);
    return { status: 200, data: { ok: true }, clearSession: true };
  }

  if (method === 'GET' && path === '/api/auth/me') {
    if (!ctx.user) return D({ user: null });
    const r = await query('SELECT * FROM users WHERE id=$1', [ctx.user.id]);
    return D({ user: r.rowCount ? publicUser(r.rows[0]) : null });
  }

  if (method === 'PATCH' && path === '/api/me') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    const sets = [], vals = [];
    for (const f of ['display_name', 'bio', 'repo_url']) {
      if (typeof body[f] === 'string') { sets.push(`${f}=$${sets.length + 1}`); vals.push(str(body[f], 500)); }
    }
    if (body.new_password) {
      const cur = await query('SELECT password_hash FROM users WHERE id=$1', [ctx.user.id]);
      if (!await verify(String(body.current_password || ''), cur.rows[0].password_hash)) {
        return D({ error: '当前密码不对' }, 403);
      }
      if (String(body.new_password).length < 8) return D({ error: '新密码至少 8 位' }, 400);
      sets.push(`password_hash=$${sets.length + 1}`);
      vals.push(await hash(String(body.new_password)));
    }
    if (!sets.length) return D({ error: '没有要改的内容' }, 400);
    vals.push(ctx.user.id);
    await query(`UPDATE users SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    if (body.new_password) {
      await destroyUserSessions(ctx.user.id);   // 改密码踢掉所有会话
      return { status: 200, data: { ok: true, note: '密码已改,请重新登录' }, clearSession: true };
    }
    return D({ ok: true });
  }
};
```

- [ ] **Step 5: 跑测试确认全过**

```bash
node --test test/auth-routes.test.js
```
预期：14 个测试全 pass。

- [ ] **Step 6: Commit**

```bash
git add app/routes/auth.js app/routes/settings.js test/auth-routes.test.js
git commit -m "账号:注册/登录/登出/me + 站点开关 + 测试"
```

---

### Task 10: 用户审核与成员目录

**Files:**
- Rewrite: `app/routes/users.js`
- Rewrite: `app/routes/notifications.js`
- Test: 追加到 `test/auth-routes.test.js`

**Interfaces:**
- Consumes: `db/pool.js`
- Produces: `notify(userId, kind, title, body)` 供 projects 复用（从 `routes/notifications.js` 导出）

- [ ] **Step 1: 追加测试**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/auth-routes.test.js
```

- [ ] **Step 3: 写 `app/routes/notifications.js`**

```js
'use strict';
const { query } = require('../db/pool');

async function notify(userId, kind, title, body) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, kind, title, body) VALUES ($1,$2,$3,$4)',
    [userId, kind, String(title).slice(0, 120), String(body || '').slice(0, 500)]
  );
}

module.exports = async function notificationRoutes(ctx, D) {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/notifications') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    const r = await query(
      `SELECT id, kind, title, body, read_at, created_at FROM notifications
        WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [ctx.user.id]);
    const unread = r.rows.filter(n => !n.read_at).length;
    return D({ notifications: r.rows, unread });
  }

  if (method === 'POST' && path === '/api/notifications/read') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
                [ctx.user.id]);
    return D({ ok: true });
  }
};

module.exports.notify = notify;
```

- [ ] **Step 4: 写 `app/routes/users.js`**

```js
'use strict';
const { query } = require('../db/pool');
const { destroyUserSessions } = require('../auth/session');
const { notify } = require('./notifications');

const card = u => ({ id: u.id, username: u.username, display_name: u.display_name,
                     bio: u.bio, repo_url: u.repo_url, created_at: u.created_at });

module.exports = async function userRoutes(ctx, D) {
  const { method, path, seg, body } = ctx;

  if (method === 'GET' && path === '/api/members') {
    const r = await query(
      `SELECT id,username,display_name,bio,repo_url,created_at FROM users
        WHERE status='approved' ORDER BY created_at DESC`);
    return D({ members: r.rows.map(card) });
  }

  if (method === 'GET' && seg[1] === 'members' && seg[2] && !seg[3]) {
    const r = await query(
      `SELECT id,username,display_name,bio,repo_url,created_at FROM users
        WHERE username=$1 AND status='approved'`, [seg[2]]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    const u = r.rows[0];
    const pj = await query(
      `SELECT p.slug,p.name,p.tagline,p.domain_id FROM projects p
         JOIN project_members pm ON pm.project_id=p.id
        WHERE pm.user_id=$1 AND p.status='approved' ORDER BY p.created_at DESC`, [u.id]);
    return D({ member: card(u), projects: pj.rows });
  }

  if (method === 'GET' && path === '/api/admin/users/pending') {
    const r = await query(
      `SELECT id,username,display_name,email,repo_url,apply_note,created_at FROM users
        WHERE status='pending' ORDER BY created_at ASC`);
    return D({ users: r.rows });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'review') {
    const id = Number(seg[3]);
    const r = await query('SELECT id,status,username FROM users WHERE id=$1', [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    if (r.rows[0].status !== 'pending') return D({ error: '该申请已处理' }, 409);

    const status = body.decision === 'approve' ? 'approved' : 'rejected';
    await query(
      `UPDATE users SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
        WHERE id=$4`,
      [status, String(body.note || '').slice(0, 300), ctx.user.id, id]);

    await notify(id, 'account',
      status === 'approved' ? '申请已通过' : '申请未通过',
      status === 'approved' ? '欢迎加入星屿,现在可以登录了。' : '这次未通过,可补充作品后再申请。');
    return D({ ok: true, status, username: r.rows[0].username });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'suspend') {
    const id = Number(seg[3]);
    if (id === ctx.user.id) return D({ error: '不能停用自己' }, 400);
    const r = await query(
      `UPDATE users SET status='suspended', updated_at=now() WHERE id=$1 RETURNING username`, [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    await destroyUserSessions(id);          // 停用即踢下线
    return D({ ok: true, username: r.rows[0].username });
  }
};
```

- [ ] **Step 5: 跑测试确认全过**

```bash
node --test test/auth-routes.test.js
```
预期：20 个测试全 pass。

- [ ] **Step 6: 端到端 curl 验收**

```bash
npm start   # 另开终端
B=http://localhost:4870
curl -s -X POST -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2","display_name":"Alice","email":"a@x.com","apply_note":"我想加入这个社区一起做项目"}' \
  $B/api/auth/register
curl -s -X POST -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' $B/api/auth/login    # → 403 审核中
# 站长登录
curl -s -c admin.txt -X POST -H 'content-type: application/json' \
  -d '{"username":"<站长名>","password":"<站长密码>"}' $B/api/auth/login
curl -s -b admin.txt $B/api/admin/users/pending
curl -s -b admin.txt -X POST -H 'content-type: application/json' \
  -d '{"decision":"approve"}' $B/api/admin/users/2/review
curl -s -c alice.txt -X POST -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' $B/api/auth/login    # → 200 + Set-Cookie
curl -s -b alice.txt $B/api/auth/me
```

- [ ] **Step 7: Commit**

```bash
git add app/routes/users.js app/routes/notifications.js test/auth-routes.test.js
git commit -m "账号:用户审核、成员目录、通知"
```

**阶段② 验收**：上面那串 curl 全部符合预期；`npm test` 全绿。

---

# 阶段③ 项目与领域

### Task 11: 领域与统计端点

**Files:**
- Rewrite: `app/routes/domains.js`

- [ ] **Step 1: 写 `app/routes/domains.js`**

```js
'use strict';
const { query } = require('../db/pool');

module.exports = async function domainRoutes(ctx, D) {
  if (ctx.method === 'GET' && ctx.path === '/api/domains') {
    const r = await query('SELECT id,name,color FROM domains ORDER BY sort');
    return D({ domains: r.rows });
  }
  if (ctx.method === 'GET' && ctx.path === '/api/stats') {
    const r = await query(`
      SELECT (SELECT count(*) FROM users    WHERE status='approved')::int AS members,
             (SELECT count(*) FROM projects WHERE status='approved')::int AS projects`);
    return D(r.rows[0]);
  }
};
```

- [ ] **Step 2: 验证**

```bash
curl -s http://localhost:4870/api/domains | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).domains.length))"
```
预期输出 `6`。

```bash
curl -s http://localhost:4870/api/stats
```
预期 `{"members":1,"projects":0}`（只有站长）。

- [ ] **Step 3: Commit**

```bash
git add app/routes/domains.js
git commit -m "项目:领域与统计端点"
```

---

### Task 12: slug 生成

**Files:**
- Create: `app/lib/slug.js`
- Test: `test/slug.test.js`

**Interfaces:**
- Produces: `slugify(name) -> string`、`uniqueSlug(name) -> Promise<string>`

- [ ] **Step 1: 写失败的测试 `test/slug.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { slugify, uniqueSlug } = require('../app/lib/slug');

test.beforeEach(resetDb);
test.after(closeDb);

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
  const mk = (slug) => query(
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/slug.test.js
```

- [ ] **Step 3: 写 `app/lib/slug.js`**

```js
'use strict';
const { randomBytes } = require('node:crypto');
const { query } = require('../db/pool');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // 非字母数字(含中文)一律转连字符
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
}

async function uniqueSlug(name) {
  let base = slugify(name);
  if (!base) base = 'p-' + randomBytes(3).toString('hex');
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const r = await query('SELECT 1 FROM projects WHERE slug=$1', [candidate]);
    if (!r.rowCount) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

module.exports = { slugify, uniqueSlug };
```

- [ ] **Step 4: 跑测试确认全过**

```bash
node --test test/slug.test.js
```
预期：4 个测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add app/lib/slug.js test/slug.test.js
git commit -m "项目:slug 生成 + 测试"
```

---

### Task 13: 项目 CRUD 与审核

**Files:**
- Rewrite: `app/routes/projects.js`
- Test: `test/projects-routes.test.js`

**Interfaces:**
- Consumes: `lib/slug.js`、`routes/notifications.js` 的 `notify`、`db/pool.js` 的 `tx`

- [ ] **Step 1: 写失败的测试 `test/projects-routes.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { handle } = require('../app/routes');
const { hash } = require('../app/auth/password');

const call = (method, path, body = {}, user = null) =>
  handle({ method, path, seg: path.split('/').filter(Boolean),
           query: new URLSearchParams(), body, user,
           session: user ? { id: 'fake' } : null, userAgent: 't', ip: '1.1.1.1' });

async function mkUser(username, role = 'member') {
  const r = await query(
    `INSERT INTO users (username,password_hash,display_name,email,role,status)
     VALUES ($1,$2,$1,$3,$4,'approved') RETURNING id`,
    [username, await hash('pw12345678'), `${username}@x.com`, role]);
  return { id: r.rows[0].id, username, role, status: 'approved' };
}

const NEW = { name: 'Lumen 学伴', tagline: '给县城中学生的离线 AI 学习伙伴',
              description: '一个能在低配安卓机上跑的学习助手,离线优先。',
              repo_url: 'https://gitee.com/x/lumen', domain_id: 'edu' };

test.beforeEach(resetDb);
test.after(closeDb);

test('发起项目 → pending,且不出现在公开列表', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', NEW, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.project.status, 'pending');
  const pub = await call('GET', '/api/projects');
  assert.strictEqual(pub.data.projects.length, 0);
});

test('发起人被记为 owner,且自动进 project_members', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', NEW, alice);
  const p = await query('SELECT owner_id FROM projects WHERE slug=$1', [r.data.project.slug]);
  assert.strictEqual(Number(p.rows[0].owner_id), Number(alice.id));
  const pm = await query(
    `SELECT role FROM project_members pm JOIN projects p ON p.id=pm.project_id
      WHERE p.slug=$1 AND pm.user_id=$2`, [r.data.project.slug, alice.id]);
  assert.strictEqual(pm.rows[0].role, 'owner');
});

test('匿名不能发起项目', async () => {
  const r = await call('POST', '/api/projects', NEW);
  assert.strictEqual(r.status, 401);
});

test('站长通过后进入公开列表并通知发起人', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;

  const rev = await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  assert.strictEqual(rev.status, 200);

  const pub = await call('GET', '/api/projects');
  assert.strictEqual(pub.data.projects.length, 1);

  const n = await query(`SELECT * FROM notifications WHERE user_id=$1 AND kind='project'`, [alice.id]);
  assert.strictEqual(n.rowCount, 1);
});

test('重复审核 → 409', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  const again = await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  assert.strictEqual(again.status, 409);
});

test('owner 能看到自己未过审的项目详情,别人看不到', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = c.data.project.slug;

  assert.strictEqual((await call('GET', `/api/projects/${slug}`, {}, alice)).status, 200);
  assert.strictEqual((await call('GET', `/api/projects/${slug}`, {}, bob)).status, 404);
  assert.strictEqual((await call('GET', `/api/projects/${slug}`)).status, 404);
});

test('只有 owner 能改项目', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = c.data.project.slug;
  assert.strictEqual((await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, bob)).status, 403);
  assert.strictEqual((await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, alice)).status, 200);
});

test('改名不改 slug', async () => {
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = c.data.project.slug;
  await call('PATCH', `/api/projects/${slug}`, { name: '完全不同的名字' }, alice);
  const r = await query('SELECT slug,name FROM projects WHERE slug=$1', [slug]);
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(r.rows[0].name, '完全不同的名字');
});

test('owner 能加成员,非 owner 不能', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = c.data.project.slug;

  assert.strictEqual((await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, carol)).status, 403);
  const ok = await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);
  assert.strictEqual(ok.status, 200);
  const dup = await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);
  assert.strictEqual(dup.status, 409);
  assert.ok(bob);
});

test('非法 domain_id → 400', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', { ...NEW, domain_id: 'nonexistent' }, alice);
  assert.strictEqual(r.status, 400);
});

test('待审列表只有站长能看', async () => {
  const alice = await mkUser('alice');
  await call('POST', '/api/projects', NEW, alice);
  assert.strictEqual((await call('GET', '/api/admin/projects/pending', {}, alice)).status, 403);
  const root = await mkUser('root', 'admin');
  const r = await call('GET', '/api/admin/projects/pending', {}, root);
  assert.strictEqual(r.data.projects.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/projects-routes.test.js
```

- [ ] **Step 3: 写 `app/routes/projects.js`**

```js
'use strict';
const { query, tx } = require('../db/pool');
const { uniqueSlug } = require('../lib/slug');
const { notify } = require('./notifications');

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const card = p => ({ slug: p.slug, name: p.name, tagline: p.tagline, repo_url: p.repo_url,
                     domain_id: p.domain_id, status: p.status, created_at: p.created_at,
                     owner: p.owner_username ? { username: p.owner_username,
                                                 display_name: p.owner_display_name } : undefined });

async function loadProject(slug) {
  const r = await query(
    `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
       FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.slug=$1`, [slug]);
  return r.rows[0] || null;
}

module.exports = async function projectRoutes(ctx, D) {
  const { method, path, seg, body, user } = ctx;

  if (method === 'GET' && path === '/api/projects') {
    const r = await query(
      `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
         FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.status='approved' ORDER BY p.created_at DESC`);
    return D({ projects: r.rows.map(card) });
  }

  if (method === 'POST' && path === '/api/projects') {
    if (!user) return D({ error: '请先登录' }, 401);
    const name = str(body.name, 60);
    const description = str(body.description, 4000);
    if (!name) return D({ error: '请填写项目名' }, 400);
    if (description.length < 20) return D({ error: '简介至少 20 字' }, 400);

    const domain_id = str(body.domain_id, 32) || null;
    if (domain_id) {
      const d = await query('SELECT 1 FROM domains WHERE id=$1', [domain_id]);
      if (!d.rowCount) return D({ error: '未知领域' }, 400);
    }

    const slug = await uniqueSlug(name);
    const project = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO projects (slug,name,tagline,description,repo_url,domain_id,owner_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
        [slug, name, str(body.tagline, 120), description, str(body.repo_url, 200) || null,
         domain_id, user.id]);
      await c.query(
        `INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'owner')`,
        [r.rows[0].id, user.id]);
      return r.rows[0];
    });
    return D({ ok: true, project: card(project),
               note: '已提交,站长审核通过后上线。' });
  }

  if (method === 'GET' && seg[1] === 'projects' && seg[2] && !seg[3]) {
    const p = await loadProject(seg[2]);
    // 未过审的项目只有 owner 与站长看得到
    const maySee = p && (p.status === 'approved' ||
      (user && (Number(user.id) === Number(p.owner_id) || user.role === 'admin')));
    if (!maySee) return D({ error: 'not found' }, 404);
    const mem = await query(
      `SELECT u.username,u.display_name,pm.role FROM project_members pm
         JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1 ORDER BY pm.joined_at`, [p.id]);
    return D({ project: { ...card(p), description: p.description }, members: mem.rows });
  }

  if (method === 'PATCH' && seg[1] === 'projects' && seg[2] && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    if (Number(p.owner_id) !== Number(user.id) && user.role !== 'admin') {
      return D({ error: '只有发起人能修改' }, 403);
    }
    const sets = [], vals = [];
    for (const f of ['name', 'tagline', 'description', 'repo_url']) {
      if (typeof body[f] === 'string') { sets.push(`${f}=$${sets.length + 1}`); vals.push(str(body[f], 4000)); }
    }
    if (typeof body.domain_id === 'string') {
      const d = await query('SELECT 1 FROM domains WHERE id=$1', [body.domain_id]);
      if (!d.rowCount) return D({ error: '未知领域' }, 400);
      sets.push(`domain_id=$${sets.length + 1}`); vals.push(body.domain_id);
    }
    if (!sets.length) return D({ error: '没有要改的内容' }, 400);
    vals.push(p.id);
    // slug 一经创建不再变更,避免外链失效
    await query(`UPDATE projects SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    return D({ ok: true });
  }

  if (method === 'POST' && seg[1] === 'projects' && seg[2] && seg[3] === 'members') {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    if (Number(p.owner_id) !== Number(user.id)) return D({ error: '只有发起人能加成员' }, 403);

    const u = await query(
      `SELECT id,display_name FROM users WHERE username=$1 AND status='approved'`,
      [str(body.username, 32).toLowerCase()]);
    if (!u.rowCount) return D({ error: '没找到该成员' }, 404);

    const dup = await query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2',
                            [p.id, u.rows[0].id]);
    if (dup.rowCount) return D({ error: 'TA 已经在项目里了' }, 409);

    await query(`INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'member')`,
                [p.id, u.rows[0].id]);
    await notify(u.rows[0].id, 'project', '你被加入了一个项目', `${user.display_name || user.username} 把你加进了「${p.name}」。`);
    return D({ ok: true });
  }

  if (method === 'GET' && path === '/api/admin/projects/pending') {
    const r = await query(
      `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
         FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.status='pending' ORDER BY p.created_at ASC`);
    return D({ projects: r.rows.map(p => ({ ...card(p), id: p.id, description: p.description })) });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'projects' && seg[3] && seg[4] === 'review') {
    const id = Number(seg[3]);
    const r = await query('SELECT id,name,status,owner_id FROM projects WHERE id=$1', [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    if (r.rows[0].status !== 'pending') return D({ error: '该项目已处理' }, 409);

    const status = body.decision === 'approve' ? 'approved' : 'rejected';
    await query(
      `UPDATE projects SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
        WHERE id=$4`,
      [status, String(body.note || '').slice(0, 300), ctx.user.id, id]);
    await notify(r.rows[0].owner_id, 'project',
      status === 'approved' ? '项目已上线' : '项目未通过',
      status === 'approved' ? `你发起的「${r.rows[0].name}」已通过审核。`
                            : `「${r.rows[0].name}」这次未通过,可补充后重新提交。`);
    return D({ ok: true, status, name: r.rows[0].name });
  }
};
```

- [ ] **Step 4: 跑测试确认全过**

```bash
node --test test/projects-routes.test.js
```
预期：11 个测试全 pass。

- [ ] **Step 5: 全量测试**

```bash
npm test
```
预期：45+ 个用例全绿。

- [ ] **Step 6: Commit**

```bash
git add app/routes/projects.js test/projects-routes.test.js
git commit -m "项目:CRUD、审核、成员、归属 + 测试"
```

---

### Task 14: 删除旧后端

**Files:**
- Delete: `app/core.js`、`app/data/`、`worker/`、`wrangler.jsonc`、`project_src/`
- Modify: `.dockerignore`

- [ ] **Step 1: 确认没有残留引用**

```bash
grep -rn "require.*core\|data/seed\|data/network\|createGalaxy" app/ worker/ --include=*.js | grep -v node_modules
```
预期：只剩 `worker/index.js` 自己（马上删）。

- [ ] **Step 2: 删除**

```bash
git rm -r app/core.js app/data worker wrangler.jsonc project_src
```

- [ ] **Step 3: 从 `.dockerignore` 删掉 `project_src` 那行**

- [ ] **Step 4: 确认服务仍能起、测试仍全绿**

```bash
npm start      # 起得来
npm test       # 全绿
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "删除旧后端:内存 core、dummy 数据、Cloudflare Worker、早期原型"
```

**阶段③ 验收**：`npm test` 全绿；curl 走完「发起 → 公开面不可见 → 站长通过 → 上线且归属正确」。

---

# 阶段④ 前端替换

> 这一阶段不是 TDD 形状的——主体是删除 35 个文件、改写 15 个文件、新增 6 个页面。验证靠 `browser-eyes` 实际打开，而不是单元测试。任务按「一次能跑通构建」切分。

### Task 15: 前端删除与止血

**Files:** 见 spec 附录 A2、A4

- [ ] **Step 1: 一次性删除 35 个文件**（必须同一提交，否则 Vite import 分析失败）

```bash
cd app/frontend/src
git rm lib/galaxy.js components/MatchCard.vue \
  portal/pages/AboutPage.vue portal/pages/PeoplePage.vue \
  portal/sections/{AcademySection,BriefsSection,CoursesSection,GateSection,GatheringsSection,HighlightsSection,OverviewSection,PeopleSection,PermissionsSection,PersonaBar,PolarisSection,PresenterPanel,ResourcesSection,TalentSection,TopicForm,VisionSection,WorkbenchDrawer}.vue \
  admin/pages/{DashPage,GatePage,CuratorPage,SynergyPage,BoardPage,BriefsAdminPage,ScoutsAdminPage,GatheringsAdminPage,AcademyAdminPage,ResourcesAdminPage,RiskPage,CoursesAdminPage,OrgReviewPage,DirectoryPage}.vue
```

- [ ] **Step 2: 处理三个「构建不报错、运行时才坏」的点**（spec 附录 A4）

1. `portal/store.js` — 删 `focusConstellation` 定义与 `openMember` 里对它的调用
2. `portal/store.js` — 删 `closeDrawer` 里的 `store.galaxyCtl.focus(null)`
3. `portal/sections/IdentityRibbon.vue` — 通知改打 `GET /api/notifications`，不再拼 persona id

- [ ] **Step 3: 清掉 `PortalApp.vue` / `AdminApp.vue` 里指向已删文件的 import 与映射**

`AdminApp.vue:178` 的 `:is="PAGES[page] || DashPage"` 兜底要改指向新的待审用户页。

- [ ] **Step 4: 删依赖与脚本**

```bash
cd app/frontend && npm uninstall qrcode-generator
```

- [ ] **Step 5: 构建必须通过**

```bash
cd app/frontend && npm run build
```
预期：无 "Failed to resolve import"。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "前端:删除演示身份、银河图与 12 个模块"
```

---

### Task 16: store 与 api 层改接会话

**Files:** `portal/store.js`、`lib/api.js`、`lib/router.js`

- [ ] **Step 1: `lib/api.js`** — 删掉 Bearer 全套（`setAdminToken`/`getAdminToken`/`onAuthLost`），改成：

```js
export const api = (p, opt) => {
  const o = { credentials: 'same-origin', ...(opt || {}) };
  return fetch('/api' + p, o).then(r => r.json().catch(() => ({ error: 'bad response' })));
};
```

同时删掉已成孤儿的 `countUp` / `tzLabel` / `STAGE`。

- [ ] **Step 2: `portal/store.js`** — 删 persona 全套（state、`PERM`、`can`、`userGroup`、`GROUP_LABEL`、`becomePersona`、`enterDefault`…），`boot()` 改成：

```js
export async function boot() {
  const [me, domains, projects, stats] = await Promise.all([
    api('/auth/me'), api('/domains'), api('/projects'), api('/stats'),
  ]);
  store.user     = me.user || null;
  store.domains  = domains.domains || [];
  store.dcolor   = Object.fromEntries(store.domains.map(d => [d.id, d.color]));
  store.dname    = Object.fromEntries(store.domains.map(d => [d.id, d.name]));
  store.projects = projects.projects || [];
  store.stats    = stats || {};
  store.ready    = true;
}
```

> 注意每个字段都带 `|| []` 兜底——这正是旧代码 `graph.domains.map()` 白屏的根因。

`requireMember()` 改成检查 `store.user`。

- [ ] **Step 3: `lib/router.js`** — `ROUTES` 改为
  `['', 'projects', 'project', 'members', 'u', 'login', 'register', 'me']`

- [ ] **Step 4: `npm run build` 通过 + 用 browser-eyes 打开首页**，确认 console 无异常、无 4xx。

- [ ] **Step 5: Commit**

---

### Task 17: 登录 / 注册 / 我的 页面

**Files:** 新建 `portal/pages/{LoginPage,RegisterPage,MePage,MembersPage,ProfilePage}.vue`；改写 `portal/sections/IdentityRibbon.vue`（顶栏账号菜单 + 通知）；`JoinModal.vue` 字段换成 spec 决策 5 的六项。

- [ ] **Step 1** 逐页实现，每页完成后 `npm run build`
- [ ] **Step 2** browser-eyes 走完：注册 → 提示待审 → 登录被拒 → （另开控制台通过）→ 登录成功 → 顶栏显示自己 → 退出
- [ ] **Step 3** Commit

---

### Task 18: 后台 4 页

**Files:** 改写 `admin/AdminApp.vue`（删 `MODULES`/`ROLES`/`reset`/`refreshBadges` 里 8 个已删端点，登录卡改成账号密码打 `/api/auth/login`）；保留 `UserReviewPage`、`ProjectsReviewPage` 并改接新接口；`HomeConfigPage` 改成站点设置页；新建成员管理页。

- [ ] **Step 1** 实现四页
- [ ] **Step 2** browser-eyes 走完：站长登录 → 看到待审用户 → 通过 → 看到待审项目 → 通过 → 关闭注册开关 → 前台注册入口消失
- [ ] **Step 3** Commit

---

### Task 19: 样式清理

**Files:** `styles/global.css`

- [ ] **Step 1** 按 spec 附录 A3 删约 270 行（银河 HUD、跑马灯、Polaris、Gate、Curator、Synergy、直播模式、演示模式、氛围模式、二维码浮层）
- [ ] **Step 2** **保留 `.form-field`**（在 Gate 区块里，但被 JoinModal / ProjectsSection / 设置页使用）
- [ ] **Step 3** `index.html` 启动占位背景 `#04060f` 改成浅色，消除加载闪黑
- [ ] **Step 4** `Icon.vue` 删 `gate` `compass` `shield` `scale` `clock` `eye` 六个孤儿图标
- [ ] **Step 5** browser-eyes 全站扫一遍确认没删错
- [ ] **Step 6** Commit

---

# 阶段⑤ 部署

### Task 20: Dockerfile 多阶段构建

**Files:** `Dockerfile`、`docker-compose.yml`

- [ ] **Step 1: 改 `Dockerfile` 为多阶段**

```dockerfile
FROM node:24-alpine AS fe
WORKDIR /fe
COPY app/frontend/package*.json ./
RUN npm ci
COPY app/frontend/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev
COPY app/ app/
COPY --from=fe /public-dist app/public-dist
EXPOSE 4870
CMD ["sh","-c","node app/db/migrate.js && node app/server.js"]
```

> `COPY --from` 的路径是 `/public-dist` 不是 `/fe/public-dist`:`vite.config.js:11` 的
> `outDir: resolve(__dirname, '../public-dist')` 是相对 `vite.config.js` 自身位置解析的,
> 在 `fe` 阶段 `__dirname` 是 `/fe`,所以产物落在容器根下的 `/public-dist`。

> 现状是「宿主机先 build 才有前端」——`.dockerignore` 排除 `app/frontend` 源码，而产物 `app/public-dist` 被 gitignore。改成镜像内构建后，`.dockerignore` 里的 `app/frontend` 那行要删掉。

- [ ] **Step 2: `docker-compose.yml` 加回 `app` 服务**，`depends_on: db: condition: service_healthy`
- [ ] **Step 3: 本地 `docker compose up --build` 全链路验证**：注册 → 审核 → 登录 → 发项目 → 审核 → 上线
- [ ] **Step 4: `docker compose restart app` 后数据仍在**（这是本次重构的核心承诺）
- [ ] **Step 5: Commit**

### Task 21: 服务器部署与文档

- [ ] **Step 1** 服务器 compose 起库与应用；用 `ADMIN_USER` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` 首启建站长（`app/bin/create-admin.js` 在这三个环境变量齐全时走非交互分支）
- [ ] **Step 2** nginx 反代 + TLS；`SESSION_SECURE=1`
- [ ] **Step 3** 域名切过来（原 Cloudflare Worker 下线）
- [ ] **Step 4** 改写 `README.md`、`docs/DEPLOY.md`、`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/DATA-MODEL.md`、`docs/MODULES.md`——删掉全部 wrangler / Worker / persona / 已删模块的描述
- [ ] **Step 5** Commit

---

## 自查记录

- **Spec 覆盖**：spec 的 9 节 + 附录 A 均有对应任务。「零、先做 domains」对应 Task 2（建表种子）与 Task 11（端点）与 Task 16（前端改接），三处都在删除 `galaxyGraph()`（Task 14）之前。
- **类型一致**：`needsAdmin(method, seg)`（Task 7）与 `routes/index.js`（Task 8）的调用一致；`createSession` 返回 `{id, expiresAt}`（Task 5），`auth.js` 用的是 `s.id`（Task 9），一致；`notify(userId, kind, title, body)`（Task 10）被 `projects.js`（Task 13）以同签名调用；每个 `routes/*.js` 的签名统一为 `async (ctx, D) => 命中返回 {status,data},否则 undefined`。
- **自查中修掉的两处**：Dockerfile 里 `COPY --from=fe` 的源路径原本推成了 `/app/public-dist`，实测 `vite.config.js:11` 的 outDir 相对自身解析，在构建阶段是 `/public-dist`；Task 21 的环境变量名原本打成 `ADMIP_PASSWORD`。
- **与守卫设计的一处有意偏离**：spec 里写的分级是「① 保留动词 → ② 后台显式表 → ③ 公开白名单 → ④ 默认拒绝」。计划里改成「① `/api/admin/*` 一律后台 → ② 保留动词 → ③ 公开白名单 → ④ 默认拒绝」——新 API 面把后台端点全部收进 `/api/admin/` 前缀后，前缀判定比逐条维护 `ADMIN_ROUTES` 更难出错，那张显式表因此不再需要。Task 7 的测试里有一条 `任何 /api/admin/* 一律后台,包括还没写的` 守着这个性质。
