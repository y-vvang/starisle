import { eq } from 'drizzle-orm';
import { db } from '../db/pool';
import { settings } from '../db/schema';
import type { RouteHandler } from './types';

export async function getSetting(key: string, fallback: unknown) {
  const r = await db.select().from(settings).where(eq(settings.key, key));
  return r.length ? r[0].value : fallback;
}

const settingsRoutes: RouteHandler = async (ctx, D) => {
  const { method, path } = ctx;

  if (method === 'GET' && path === '/api/settings/public') {
    return D({ registration_open: await getSetting('registration_open', true) });
  }

  if (method === 'PATCH' && path === '/api/admin/settings') {
    if (typeof ctx.body.registration_open === 'boolean') {
      // jsonb 列在 builder 路径直接收 JS 值(drizzle 内部序列化),
      // 不再手工 JSON.stringify(那是裸 pg 路径的要求)。
      await db.insert(settings)
        .values({ key: 'registration_open', value: ctx.body.registration_open })
        .onConflictDoUpdate({ target: settings.key, set: { value: ctx.body.registration_open } });
    }
    return D({ ok: true, registration_open: await getSetting('registration_open', true) });
  }
};

export default settingsRoutes;
