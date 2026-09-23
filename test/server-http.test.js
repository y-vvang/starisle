'use strict';
// 唯一一个真的经过 app/server.js(而不是直接调 handle())的测试文件。
// 其余所有测试都是构造 ctx 直接调 handle(),从没有真的跑过 readBody() 那段
// 逐 socket-chunk 攒 body 的代码——UTF-8 跨 chunk 边界被切坏这个 bug 正是
// 因此活了下来。这里起一个真实 http.Server(ephemeral 端口),用真实 socket
// 把中文 body 故意切成两次 write() 发过去。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resetDb, closeDb, query } = require('./helpers/db');
const { server } = require('../app/server');

let base;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(resetDb);

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

// 发一个 POST,body 按 splitAt(字节偏移)切成两次独立 write(),中间让出一个
// event loop tick(setTimeout),确保服务端真的收到两个独立的 'data' 事件,
// 不会被 Node 悄悄合并回一个 chunk。splitAt 省略时就是一次性整体发送。
function post(path, bodyBuf, splitAt) {
  return new Promise((resolve) => {
    const req = http.request(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bodyBuf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch { /* 超限时对端可能已经把 socket 掐了,body 不是合法 JSON 甚至是空的 */ }
        resolve({ status: res.statusCode, data });
      });
    });
    // 超限触发时 server.js 会直接 req.destroy() 掉那个共用的 socket——客户端
    // 这边看到的就是连接中途被重置,而不是一个体面的 HTTP 响应。这本身就是
    // "被拒绝"的合法证据之一,不能让它把测试断言炸掉。
    req.on('error', () => resolve({ status: null, data: null }));
    if (splitAt == null) {
      req.end(bodyBuf);
    } else {
      req.write(bodyBuf.slice(0, splitAt));
      setTimeout(() => { req.write(bodyBuf.slice(splitAt)); req.end(); }, 20);
    }
  });
}

test('中文 body 被 socket 分片切在多字节字符中间 → 拼回来的值与发送前逐字节一致(不产生 U+FFFD)', async () => {
  // '测' 的 UTF-8 编码是 E6 B5 8B,3 字节。重复 30 次 = 90 字节。
  const marker = '测'.repeat(30);
  const payload = {
    username: 'chunksplit', password: 'hunter2hunter2', display_name: 'Chunk Split',
    email: 'chunksplit@example.com', repo_url: '', apply_note: marker,
  };
  const json = JSON.stringify(payload);
  const bodyBuf = Buffer.from(json, 'utf8');
  const prefixBytes = Buffer.byteLength(json.slice(0, json.indexOf(marker)), 'utf8');
  // +1:切在 marker 第一个字符的第 1/3 个字节之后——这是任务描述里
  // "字节偏移 10/11/13 必坏,只有 12(=4×3,字符边界)能活"这条经验规律里
  // 典型的"必坏"偏移之一(landing mid-character,不是字符边界)。
  const splitAt = prefixBytes + 1;

  const r = await post('/api/auth/register', bodyBuf, splitAt);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));

  const row = await query('SELECT apply_note FROM users WHERE username=$1', ['chunksplit']);
  assert.strictEqual(row.rowCount, 1);
  assert.strictEqual(row.rows[0].apply_note, marker);
  assert.ok(!row.rows[0].apply_note.includes('�'), '不应该出现替换字符 U+FFFD');
});

test('超过 body 大小上限(按字节,不是按字符)→ 请求被拒绝,不落库', async () => {
  // 900,000 个中文字符:JS 字符数(900,000)低于旧实现按 char 数比的 1e6 上限,
  // 但 UTF-8 字节数(2,700,000)远超真正应该生效的 1MB 上限——这正是"用
  // raw.length 卡字符数,导致 1MB 的招牌名不副实,实际能塞进 ~3MB 中文"
  // 那个关联 bug。旧实现不会在这个体量触发拒绝,修复后按字节数会。
  const big = '测'.repeat(900_000);
  const payload = { username: 'toolarge', password: 'hunter2hunter2', display_name: 'x',
                     email: 'toolarge@example.com', apply_note: big };
  const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  assert.ok(bodyBuf.length > 2_000_000, '这条用例的前提是 body 字节数明显超过 1MB');

  const r = await post('/api/auth/register', bodyBuf);
  // 超限时 server.js 走"尽力而为回一个 413,写不出去就直接断连"的路径(见
  // server.js readBody 里的注释),两种表现都是"被拒绝"的合法证据。
  if (r.status !== null) assert.strictEqual(r.status, 413);

  const row = await query('SELECT 1 FROM users WHERE username=$1', ['toolarge']);
  assert.strictEqual(row.rowCount, 0, '超限请求不应该有任何数据落库');
});

test('body 里的 NUL 字节不会让写入端点 500 —— 剥掉后照常落库', async () => {
  // PostgreSQL 的 text/jsonb 一律不接受 U+0000,但 JSON 允许 "\u0000"。
  // 修之前:任何能走到 INSERT/UPDATE 的字符串字段被塞一个 NUL,就会在数据库层
  // 抛未处理异常 → 500。实测项目名、注册显示名、项目内容字段全部中招,匿名可复现。
  // 用 display_name 而不是 username:username 有 /^[a-z0-9_-]{3,32}$/ 挡在落库之前,
  // 到不了数据库,证明不了这条路径。
  const body = Buffer.from(JSON.stringify({
    username: 'nulprobe', password: 'hunter2hunter2',
    display_name: 'NUL\u0000Probe', email: 'nulprobe@example.com',
    apply_note: '这条申请说明足够长,能过十个字的下限校验。',
  }), 'utf8');
  const res = await post('/api/auth/register', body);
  assert.notStrictEqual(res.status, 500, '含 NUL 的请求体不该抛未处理异常');
  assert.strictEqual(res.status, 200);
  const r = await query('SELECT display_name FROM users WHERE username=$1', ['nulprobe']);
  assert.strictEqual(r.rows[0].display_name, 'NULProbe', 'NUL 应被剥掉,其余字符原样保留');
});

test('嵌套很深的 body 不会在清洗时爆栈', async () => {
  // NUL 剥离是递归的,深度必须有上限,否则清洗本身成了新的 DoS 面。
  let deep = '"x"';
  for (let i = 0; i < 2000; i++) deep = '[' + deep + ']';
  const body = Buffer.from(`{"username":"deep","nested":${deep}}`, 'utf8');
  const res = await post('/api/auth/register', body);
  assert.notStrictEqual(res.status, 500, '深嵌套不该把进程打崩或返回 500');
});
