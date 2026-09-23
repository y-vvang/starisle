'use strict';
// 星屿 Starisle · Node HTTP 包装(零依赖,Node >= 18)。
// 启动: node server.js  →  http://localhost:4870
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./routes');
const { getSession, cleanupExpired } = require('./auth/session');

const PORT = process.env.PORT || 4870;
const SECURE = process.env.SESSION_SECURE === '1';
const COOKIE = 'starisle_sid';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const PUB = path.join(__dirname, 'public-dist');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    // 首个同名 cookie 生效(first-wins),后面重复的丢弃。这是主流实现
    // (npm `cookie`、`cookie-parser`)的选择,比"后来者覆盖"更抗
    // "同源下的兄弟子域塞一个同名 cookie 把后端读到的会话顶替掉"这类
    // cookie-tossing 手法。
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, clear } = {}) {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (SECURE) bits.push('Secure');
  bits.push(`Max-Age=${clear ? 0 : Math.floor(maxAge)}`);
  return bits.join('; ');
}

const BODY_LIMIT = 1e6;

// 解析后的 body 必须是"纯对象"(非 null、非数组),下游 handler 才能放心 body.xxx。
const isPlainBody = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// PostgreSQL 的 text/jsonb 一律不接受 U+0000(NUL),但 JSON 规范允许 "\u0000",
// 于是任何能走到 INSERT/UPDATE 的字符串字段被塞进一个 NUL,就会在数据库层抛出
// 未处理异常 → 500。实测项目名、注册显示名、项目内容字段全部中招,匿名可复现,
// 是一个廉价的"刷 500 + 刷错误日志"面。NUL 在合法文本里没有任何用途,直接剥掉,
// 剩下的字符原样保留(不做别的清洗——转义是各消费端自己的事,这里只解决"存不进去")。
//
// 放在 body 解析这一层而不是各路由的 str():str() 有两份副本(auth.js / projects.js),
// 而且新写的路由不会记得调它;边界清洗对所有现在和将来的端点一次生效。
const NUL_DEPTH_MAX = 100; // 业务 body 不可能嵌套这么深;超过就原样放行,
                           // 免得清洗本身变成一个爆栈的新 DoS 面
function stripNul(v, depth = 0) {
  if (depth > NUL_DEPTH_MAX) return v;
  if (typeof v === 'string') return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v;
  if (Array.isArray(v)) return v.map(x => stripNul(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[stripNul(k, depth + 1)] = stripNul(v[k], depth + 1);
    return out;
  }
  return v;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Buffer 攒起来,末尾一次性 toString('utf8') —— 不能像旧实现那样
    // `raw += chunk` 逐块解码:Buffer 转 string 是按块独立跑 UTF-8 解码器,
    // 一个多字节字符(中文都是 3 字节)如果被 TCP 分片切在两个 chunk 中间,
    // 前一半解码成 U+FFFD、后一半又单独解码成另一个 U+FFFD —— 两个都是
    // 合法的 JSON 字符串字符,JSON.parse 不会报错,坏数据直接静默落库。
    const chunks = [];
    let bytes = 0;
    let settled = false;
    // 保证 end / close / error 无论谁先到都只 settle 一次:close 在正常路径下
    // 也会跟在 end 后面再触发一次,不能被它二次 resolve/reject 覆盖掉结果。
    const finish = fn => { if (settled) return; settled = true; fn(); };

    req.on('data', chunk => {
      if (settled) return; // 已经因超限/关闭/出错 settle,后续数据只丢弃,不再攒内存
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > BODY_LIMIT) {
        // 超限:立刻 reject,不等 end/close —— 这正是要修的"永远 pending"。
        // 不在这里尝试写一个"体面"的 413 body:req/res 共用同一个 socket,
        // 官方 http 文档给"body 过大"的示例做法就是直接 nuke 掉 socket、不
        // 回应,原因是"先 res.end() 再 destroy() 同一个 socket"能不能把
        // 那几个字节冲出去是不确定的,而"已回应但没排空剩余 body"在
        // keep-alive 连接上还会把没读完的字节错当成下一个请求的开头,造成
        // 请求走私。直接断连是唯一确定、不会打架的结果。
        const err = new Error('request body too large');
        err.statusCode = 413;
        finish(() => reject(err));
        req.destroy();
      }
    });

    req.on('end', () => {
      finish(() => {
        if (!bytes) return resolve({});
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return resolve({}); }
        resolve(isPlainBody(parsed) ? stripNul(parsed) : {});
      });
    });

    // req.destroy()(上面超限触发)或客户端提前断开连接都只会走 close,
    // 不会走 end —— 这里必须 settle,否则 Promise 永远 pending,是这次要修
    // 的泄漏本体:那个悬挂的 await 连同它闭包住的 req/res 会活过整个进程
    // 生命周期,攻击者循环发超限 body 就能把它堆到进程爆掉。
    req.on('close', () => {
      finish(() => {
        const err = new Error('request closed before body completed');
        err.statusCode = 400;
        reject(err);
      });
    });

    req.on('error', err => finish(() => reject(err)));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // 契约③:守卫看到的路径和分发用的路径必须是同一个字符串,同样(不)解码。
  // u.pathname 是 WHATWG URL 已归一化但仍是原样(未整体 decodeURIComponent)的
  // percent-encoded 形式 —— ctx.path 和 ctx.seg 都从这一个变量派生,不单独
  // 再解码一次,避免"守卫看原始串、分发看解码串"这种可以被利用的分歧。
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      // 契约②:HEAD/OPTIONS 的方法名做精确字符串比对进不了白名单,会落到默认
      // 拒绝(401)。这对未登录探测是安全的,但语义是错的 —— 401 会被误读成
      // "需要登录",而真实原因是"这个方法压根没实现"。这里在守卫之前显式挡成
      // 405:一是把错误原因说清楚,二是明确堵死"OPTIONS 被将来的 CORS 预检逻辑
      // 悄悄映射成 GET 从而绕过鉴权"这个口子 —— 没有隐式放行,只有显式 405。
      if (req.method === 'HEAD' || req.method === 'OPTIONS') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'GET, POST, PATCH, DELETE' });
        return res.end(JSON.stringify({ error: 'method not allowed' }));
      }
      const cookies = parseCookies(req.headers.cookie);
      const session = await getSession(cookies[COOKIE]);
      let body = {};
      if (req.method !== 'GET') {
        try {
          body = await readBody(req);
        } catch (e) {
          // 超限(413)时 socket 已经被 readBody 里的 req.destroy() 掐断,
          // 客户端提前断开(400)/传输层出错时 socket 大概率也已经不可写。
          // 不管哪种,都不能落进下面通用的 catch(e) 再去 res.writeHead —— 那
          // 是给 handle()/getSession() 之类"意料之外"的错误用的,对着一个
          // 可能已经死掉的 socket 硬写只会再抛一次异常。这里 best-effort 尝试
          // 一次(如果 socket 还活着就能写出确定的状态码),写不出去就算了,
          // 但函数必须在此处结束 —— 绝不会带着 413/400 的半截 body 走进 handle()。
          try {
            if (!res.writableEnded && !res.destroyed) {
              const status = e.statusCode || 400;
              res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: status === 413 ? '请求体过大' : '请求错误' }));
            }
          } catch { /* socket 已经没了,尽力而为 */ }
          return;
        }
      }
      const r = await handle({
        method: req.method, path: p,
        // 契约①:seg 必须是完整、未剥离 /api 前缀的分段 —— guard.needsAdmin
        // 的第①层直接假定 seg[0]==='api' 并检查 seg[1]==='admin'。这里传的是
        // 对 FULL pathname 做 split('/').filter(Boolean),不做任何前缀剥离。
        seg: p.split('/').filter(Boolean),
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

// require.main 守卫(与 app/bin/create-admin.js 同一模式):被测试 require() 时
// 不自动 listen——test/server-http.test.js 需要自己在 ephemeral 端口(0)上
// 起停这个真实 server 来验证 readBody() 的 socket 层行为,不能每次 require
// 就绑死一个固定端口、测试还没法在结束时干净关掉它。
// 作为 CLI 直接执行(node app/server.js / npm start)时行为不变。
if (require.main === module) {
  server.listen(PORT, async () => {
    const n = await cleanupExpired().catch(() => 0);
    console.log(`\n  ✦ 星屿 Starisle`);
    console.log(`  主站     http://localhost:${PORT}/`);
    console.log(`  控制台   http://localhost:${PORT}/admin.html`);
    if (n) console.log(`  清理了 ${n} 条过期会话`);
    console.log('');
  });
}

module.exports = { server };
