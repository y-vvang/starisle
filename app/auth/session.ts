import { randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/pool';
import { sessions, users } from '../db/schema';

const DEFAULT_DAYS = 30;

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
  status: string;
}

export interface Session {
  id: string;
  user: SessionUser;
}

interface CreateSessionOpts {
  userAgent?: string | null;
  ip?: string | null;
  days?: number;
}

export async function createSession(userId: number, { userAgent = null, ip = null, days = DEFAULT_DAYS }: CreateSessionOpts = {}) {
  const id = randomBytes(32).toString('base64url');
  // now() + ($n || ' days')::interval:与原裸 SQL 逐字相同,只是经 drizzle 的
  // sql 模板绑定参数(模板里的 ${} 一律变 $n 占位符,不拼串)。
  const r = await db.insert(sessions).values({
    id,
    user_id: userId,
    expires_at: sql`now() + (${String(days)} || ' days')::interval`,
    user_agent: userAgent,
    ip,
  }).returning({ expires_at: sessions.expires_at });
  return { id, expiresAt: r[0].expires_at };
}

export async function getSession(id: string | null | undefined): Promise<Session | null> {
  if (!id || typeof id !== 'string') return null;
  // AND u.status = 'approved':停用生效必须在这里(每次请求都过一遍),不能只
  // 靠 suspend 端点那条"UPDATE users ... 然后另开一条语句删 sessions"的非原子
  // 组合 —— 第二条语句一旦失败,用户的会话行还在、没过期,后面这条查询原本会
  // 照样把人放进来,状态位形同虚设。把 status 判断挪进 WHERE,即使清理 sessions
  // 那步没跑,下一次请求也会因为这一条件直接查不到人。
  const r = await db.select({
    id: sessions.id,
    user_id: users.id,
    username: users.username,
    display_name: users.display_name,
    role: users.role,
    status: users.status,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.user_id))
    .where(and(eq(sessions.id, id), gt(sessions.expires_at, sql`now()`), eq(users.status, 'approved')));
  if (!r.length) return null;
  const x = r[0];
  return {
    id: x.id,
    // bigint/int8 → Number 现在统一在 db/pool.ts 用 pg 的类型解析器在源头修好
    // (setTypeParser(20, Number)),x.user_id 天生就是 Number,这里不用再
    // 手工 Number(...) 转一次。之前这里是 ctx.user.id 唯一的转型点,是为了让
    // 后续所有 `xxx === ctx.user.id` 的比较不因为「数字 === 字符串」永远为
    // false 而变成死代码(真实案例:suspend 端点的自我停用防护);现在这条
    // 不变量由源头解析器统一保证,不再需要每个出入口各修一次。
    user: { id: x.user_id, username: x.username, display_name: x.display_name,
            role: x.role, status: x.status } satisfies SessionUser,
  };
}

export const destroySession = (id: string): Promise<void> =>
  db.delete(sessions).where(eq(sessions.id, id)).then(() => undefined);
export const destroyUserSessions = (userId: number): Promise<void> =>
  db.delete(sessions).where(eq(sessions.user_id, userId)).then(() => undefined);
export const cleanupExpired = (): Promise<number | null> =>
  db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`).then(r => r.rowCount);
