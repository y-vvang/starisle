import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/pool';
import { notifications } from '../db/schema';
import { parsePagination, pageMeta } from '../lib/pagination';
import type { RouteHandler } from './types';

export async function notify(userId: number | null | undefined, kind: string, title: string, body?: string | null) {
  if (!userId) return;
  await db.insert(notifications).values({
    user_id: userId, kind,
    title: String(title).slice(0, 120), body: String(body || '').slice(0, 500),
  });
}

const notificationRoutes: RouteHandler = async (ctx, D) => {
  const { method, path, query: qs } = ctx;

  // GET /api/notifications?page=&per_page= —— 默认 per_page=50 与原 LIMIT 50
  // 一致,IdentityRibbon 只消费第一页,"不动"的策略成立。
  if (method === 'GET' && path === '/api/notifications') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    const { page, perPage } = parsePagination(qs, { perPage: 50 });
    const where = eq(notifications.user_id, ctx.user.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(where);
    const r = await db.select({
      id: notifications.id, kind: notifications.kind, title: notifications.title,
      body: notifications.body, read_at: notifications.read_at, created_at: notifications.created_at,
    }).from(notifications)
      .where(where)
      .orderBy(desc(notifications.created_at), desc(notifications.id))
      .limit(perPage).offset((page - 1) * perPage);
    const unread = r.filter(n => !n.read_at).length;
    return D({ notifications: r, unread, pagination: pageMeta(n, page, perPage) });
  }

  if (method === 'POST' && path === '/api/notifications/read') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    await db.update(notifications)
      .set({ read_at: sql`now()` })
      .where(and(eq(notifications.user_id, ctx.user.id), isNull(notifications.read_at)));
    return D({ ok: true });
  }
};

export default notificationRoutes;
