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
