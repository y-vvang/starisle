import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/pool';
import { notifications } from '../db/schema';
import type { RouteHandler } from './types';

export async function notify(userId: number | null | undefined, kind: string, title: string, body?: string | null) {
  if (!userId) return;
  await db.insert(notifications).values({
    user_id: userId, kind,
    title: String(title).slice(0, 120), body: String(body || '').slice(0, 500),
  });
}

const notificationRoutes: RouteHandler = async (ctx, D) => {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/notifications') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    const r = await db.select({
      id: notifications.id, kind: notifications.kind, title: notifications.title,
      body: notifications.body, read_at: notifications.read_at, created_at: notifications.created_at,
    }).from(notifications)
      .where(eq(notifications.user_id, ctx.user.id))
      .orderBy(desc(notifications.created_at))
      .limit(50);
    const unread = r.filter(n => !n.read_at).length;
    return D({ notifications: r, unread });
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
