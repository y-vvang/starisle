// 星屿 Starisle · Bun HTTP 入口(Bun.serve,零 HTTP 框架依赖)。
// 启动: bun app/server.ts  →  http://localhost:4870
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { handle } from './routes';
import { getSession, cleanupExpired } from './auth/session';
import type { Ctx } from './routes/types';

const COOKIE = 'starisle_sid';
const SECURE = process.env.SESSION_SECURE === '1';
// 整个 JSON 请求体的字节上限。同时作为 Bun.serve 的 maxRequestBodySize 传入,
// 超限请求(带 Content-Length 或 chunked)由 Bun 在 HTTP 层直接回 413 并掐断
// 连接 —— 探针实测(bun 1.4.2,见 git 历史里的方案文档):带长度声明的超限
// 请求根本不会进 fetch;chunked 超限则会带着被掐断的 body 进来,由下面读
// body 的 try/catch 兜住,不 500、不悬挂。原 node 实现里"超限 destroy socket
// 不写响应"的防请求走私语义由 Bun 的 HTTP 解析层接管。
const BODY_LIMIT = 1e6;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const PUB = resolve(import.meta.dir, 'public-dist');

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  // fetch 规范把多个 Cookie 头用 '; ' 合并,headers.get('cookie') 一次拿全串。
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    // 首个同名 cookie 生效(first-wins),后面重复的丢弃。这是主流实现
    // (npm `cookie`、`cookie-parser`)的选择,比"后来者覆盖"更抗
    // "同源下的兄弟子域塞一个同名 cookie 把后端读到的会话顶替掉"这类
    // cookie-tossing 手法。
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    // 畸形 percent-encoding(如 "sid=%")会让 decodeURIComponent 抛。原 node
    // 实现里它会顺着外层 catch 变 500 —— 这里改为回退原串,是有意的行为修复。
    const raw = part.slice(i + 1).trim();
    let v = raw;
    try { v = decodeURIComponent(raw); } catch { /* 保留原串 */ }
    out[name] = v;
  }
  return out;
}

function serializeCookie(name: string, value: string, { maxAge, clear }: { maxAge?: number; clear?: boolean } = {}): string {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (SECURE) bits.push('Secure');
  bits.push(`Max-Age=${clear ? 0 : Math.floor(maxAge ?? 0)}`);
  return bits.join('; ');
}

// 解析后的 body 必须是"纯对象"(非 null、非数组),下游 handler 才能放心 body.xxx。
const isPlainBody = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// PostgreSQL 的 text/jsonb 一律不接受 U+0000(NUL),但 JSON 规范允许 "\u0000",
// 于是任何能走到 INSERT/UPDATE 的字符串字段被塞进一个 NUL,就会在数据库层抛出
// 未处理异常 → 500。实测项目名、注册显示名、项目内容字段全部中招,匿名可复现,
// 是一个廉价的"刷 500 + 刷错误日志"面。NUL 在合法文本里没有任何用途,直接剥掉,
// 剩下的字符原样保留(不做别的清洗——转义是各消费端自己的事,这里只解决"存不进去")。
//
// 放在 body 解析这一层而不是各路由的 str():str() 有多份副本,而且新写的路由
// 不会记得调它;边界清洗对所有现在和将来的端点一次生效。
const NUL_DEPTH_MAX = 100; // 业务 body 不可能嵌套这么深;超过就原样放行,
                           // 免得清洗本身变成一个爆栈的新 DoS 面
function stripNul<T>(v: T, depth = 0): T {
  if (depth > NUL_DEPTH_MAX) return v;
  if (typeof v === 'string') return (v.includes('\u0000') ? v.replace(/\u0000/g, '') : v) as T;
  if (Array.isArray(v)) return v.map(x => stripNul(x, depth + 1)) as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      out[stripNul(k, depth + 1) as string] = stripNul((v as Record<string, unknown>)[k], depth + 1);
    }
    return out as T;
  }
  return v;
}

const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...extra,
});

const json = (data: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: jsonHeaders(extra) });

export async function handler(req: Request, srv: any): Promise<Response> {
  // 契约③:守卫看到的路径和分发用的路径必须是同一个字符串,同样(不)解码。
  // new URL(req.url).pathname 是 WHATWG URL 已归一化但仍是原样(未整体
  // decodeURIComponent)的 percent-encoded 形式 —— ctx.path 和 ctx.seg 都从
  // 这一个变量派生,不单独再解码一次,避免"守卫看原始串、分发看解码串"这种
  // 可以被利用的分歧。(node 版用 new URL(req.url, 'http://x'),Bun 的
  // request.url 本身就是绝对 URL,两者得到的 pathname 同构。)
  const u = new URL(req.url);
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      // 契约②:HEAD/OPTIONS 的方法名做精确字符串比对进不了白名单,会落到默认
      // 拒绝(401)。这对未登录探测是安全的,但语义是错的 —— 401 会被误读成
      // "需要登录",而真实原因是"这个方法压根没实现"。这里在守卫之前显式挡成
      // 405:一是把错误原因说清楚,二是明确堵死"OPTIONS 被将来的 CORS 预检逻辑
      // 悄悄映射成 GET 从而绕过鉴权"这个口子 —— 没有隐式放行,只有显式 405。
      if (req.method === 'HEAD' || req.method === 'OPTIONS') {
        return json({ error: 'method not allowed' }, 405, { Allow: 'GET, POST, PATCH, DELETE' });
      }
      const cookies = parseCookies(req.headers.get('cookie'));
      const session = await getSession(cookies[COOKIE]);
      let body: Record<string, unknown> = {};
      if (req.method !== 'GET') {
        try {
          const parsed = await req.json();
          body = isPlainBody(parsed) ? stripNul(parsed) : {};
        } catch {
          // 三种情况都归 {}:空 body、坏 JSON、被 maxRequestBodySize 掐断的 body。
          // (多字节字符跨 TCP 分片的解码由 Bun 的 req.json() 整体完成,
          // 原 node 实现里"Buffer 攒齐再 toString"的动机不复存在 —— 这条
          // 保证现在由 test/server-http.test.ts 的分片用例钉住。)
          body = {};
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
        userAgent: req.headers.get('user-agent'),
        ip: srv.requestIP(req)?.address ?? null,
      });
      const headers: Record<string, string> = {};
      if (r.setSession) headers['Set-Cookie'] = serializeCookie(COOKIE, r.setSession.id, { maxAge: r.setSession.maxAge });
      if (r.clearSession) headers['Set-Cookie'] = serializeCookie(COOKIE, '', { clear: true });
      return json(r.data, r.status, headers);
    }
    const file = p === '/' ? '/index.html' : p;
    const full = join(PUB, normalize(file));
    if (!full.startsWith(PUB)) return new Response(null, { status: 403 });
    try {
      const data = await readFile(full);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' },
      });
    } catch {
      return new Response('404', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  } catch (e) {
    console.error('[api]', e);
    return json({ error: '服务端错误' }, 500);
  }
}

export function createApp(opts: { port?: number; hostname?: string } = {}) {
  return Bun.serve({
    port: opts.port ?? Number(process.env.PORT || 4870),
    hostname: opts.hostname,
    maxRequestBodySize: BODY_LIMIT,
    fetch: handler,
  });
}

// import.meta.main 守卫(与 bin/ 下两个 CLI 同一模式):被 import 时
// 不自动 listen——test/server-http.test.ts 需要自己用 createApp() 在
// ephemeral 端口(0)上起停真实 server,不能每次 import 就绑死一个固定端口。
// 作为 CLI 直接执行(bun app/server.ts / npm start)时行为不变。
if (import.meta.main) {
  try {
    const server = createApp();
    // Bun.serve 返回即已监听(无 node 的 listen 回调;探针实测 bun 1.4.2
    // 上 server.ready 不存在、返回后立即可请求),banner 直接打。
    const n = await cleanupExpired().catch(() => 0);
    console.log(`\n  ✦ 星屿 Starisle`);
    console.log(`  主站     http://localhost:${server.port}/`);
    console.log(`  控制台   http://localhost:${server.port}/admin.html`);
    if (n) console.log(`  清理了 ${n} 条过期会话`);
    console.log('');
  } catch (e) {
    if ((e as any)?.code === 'EADDRINUSE') {
      console.error(`端口 ${process.env.PORT || 4870} 已被占用`);
      process.exit(1);
    }
    throw e;
  }
}
