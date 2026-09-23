import { randomBytes } from 'node:crypto';
import { eq, or, sql } from 'drizzle-orm';
import { db, tx, pgCode } from '../db/pool';
import { sessions, users } from '../db/schema';
import { hash, verify, N as SCRYPT_N, R as SCRYPT_R, P as SCRYPT_P } from '../auth/password';
import { createSession, destroySession } from '../auth/session';
import { getSetting } from './settings';
import { ADMIN_VERBS } from '../auth/guard';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const DAYS = 30;
const publicUser = (u: { id: number; username: string; display_name: string;
                         email: string; repo_url: string | null; bio: string | null;
                         role: string; status: string; created_at: Date }) =>
  ({ id: u.id, username: u.username, display_name: u.display_name,
     email: u.email, repo_url: u.repo_url, bio: u.bio,
     role: u.role, status: u.status, created_at: u.created_at });

// 用户不存在时,登录仍要跑一次和真实校验同代价的 scrypt,靠响应时间抹平
// "账号存在与否"的差异。代价参数(N/R/P)直接从 password.ts 引入单一事实源,
// 不再另外硬编码一份——上一次就是硬编码的第二份参数在 password.ts 提高代价
// 后没跟着改,导致这道防线名存实亡。salt/hash 段只要求解码后长度非零就会让
// derive() 跑满全价,但给出 16 字节盐、32 字节哈希这种"看起来像真的"的长度,
// 免得以后有人为了"精简"把它改成会被提前短路的畸形值。
const DUMMY_HASH =
  `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$` +
  `${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;

const authRoutes: RouteHandler = async (ctx, D) => {
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
    // 路由守卫把这六个词当保留动词,出现在路径任意一段都会被判成后台路由
    // (见 app/auth/guard.ts ADMIN_VERBS)。用户名若正好是其中之一,
    // GET /api/members/:username 会被误判成后台路由,永久打不开自己的主页。
    if (ADMIN_VERBS.has(username)) {
      return D({ error: '该用户名是系统保留词,换一个吧' }, 400);
    }
    if (password.length < 8) return D({ error: '密码至少 8 位' }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return D({ error: '邮箱格式不对' }, 400);
    if (apply_note.length < 10) return D({ error: '请写至少 10 字的申请说明' }, 400);

    const dup = await db.select({ one: sql`1` }).from(users)
      .where(or(eq(users.username, username), eq(users.email, email)));
    if (dup.length) return D({ error: '该用户名或邮箱已被使用' }, 409);

    await db.insert(users).values({
      username, password_hash: await hash(password), display_name, email,
      repo_url: repo_url || null, apply_note, role: 'member', status: 'pending',
    });
    return D({ ok: true, note: '已提交,站长审核通过后即可登录。' });
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const username = str(body.username, 32).toLowerCase();
    const password = String(body.password || '');
    const r = await db.select().from(users).where(eq(users.username, username));
    const u = r[0];
    // 用户不存在时也跑一次哈希,避免用响应时间区分账号是否存在
    const ok = u ? await verify(password, u.password_hash)
                 : await verify(password, DUMMY_HASH);
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
    const r = await db.select().from(users).where(eq(users.id, ctx.user.id));
    return D({ user: r.length ? publicUser(r[0]) : null });
  }

  if (method === 'PATCH' && path === '/api/me') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    // PATCH 动态列集合是裸 SQL 的强项:drizzle builder 逐列 .set() 也行,
    // 但列集合在运行时才知道,拼一个 Record<string, unknown> 传给 .set()
    // 等价且直接。值已全部过校验,不存在注入面。
    const sets: Record<string, unknown> = {};
    for (const f of ['display_name', 'bio', 'repo_url']) {
      if (typeof body[f] === 'string') sets[f] = str(body[f], 500);
    }
    if (body.new_password) {
      const cur = await db.select({ password_hash: users.password_hash })
        .from(users).where(eq(users.id, ctx.user.id));
      if (!await verify(String(body.current_password || ''), cur[0].password_hash)) {
        return D({ error: '当前密码不对' }, 403);
      }
      if (String(body.new_password).length < 8) return D({ error: '新密码至少 8 位' }, 400);
      sets.password_hash = await hash(String(body.new_password));
    }
    if (!Object.keys(sets).length) return D({ error: '没有要改的内容' }, 400);
    sets.updated_at = sql`now()`;
    if (body.new_password) {
      // 改密码 + 踢会话必须原子:旧实现是两条独立语句,第二条(删 sessions)一旦
      // 抛异常,密码已经改了但攻击者原来那个会话安然无恙——而这恰恰是"怀疑账号
      // 被盗、赶紧改密码"这个场景下唯一要保证生效的部分。用 tx() 包住,失败就
      // 整体回滚,不会留下"密码改了但没踢人"的中间态。
      await tx(async (c) => {
        await c.update(users).set(sets).where(eq(users.id, ctx.user!.id));
        await c.delete(sessions).where(eq(sessions.user_id, ctx.user!.id));
      });
      return { status: 200, data: { ok: true, note: '密码已改,请重新登录' }, clearSession: true };
    }
    await db.update(users).set(sets).where(eq(users.id, ctx.user.id));
    return D({ ok: true });
  }
};

export default authRoutes;
