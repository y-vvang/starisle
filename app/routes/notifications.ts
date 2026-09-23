import { query } from '../db/pool';
import type { RouteHandler } from './types';

export async function notify(userId: number | null | undefined, kind: string, title: string, body?: string | null) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, kind, title, body) VALUES ($1,$2,$3,$4)',
    [userId, kind, String(title).slice(0, 120), String(body || '').slice(0, 500)]
  );
}

const notificationRoutes: RouteHandler = async (ctx, D) => {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/notifications') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    const r = await query(
      `SELECT id, kind, title, body, read_at, created_at FROM notifications
        WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [ctx.user.id]);
    const unread = r.rows.filter((n: any) => !n.read_at).length;
    return D({ notifications: r.rows, unread });
  }

  if (method === 'POST' && path === '/api/notifications/read') {
    if (!ctx.user) return D({ error: '请先登录' }, 401);
    await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
                [ctx.user.id]);
    return D({ ok: true });
  }
};

export default notificationRoutes;
