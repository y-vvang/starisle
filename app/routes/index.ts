import { needsAdmin } from '../auth/guard';
import type { Ctx, D as DFn, Result, RouteHandler } from './types';
import authRoutes from './auth';
import domainRoutes from './domains';
import settingsRoutes from './settings';
import projectRoutes from './projects';
import courseRoutes from './courses';
import mentorRoutes from './mentors';
import userRoutes from './users';
import notificationRoutes from './notifications';

export const D: DFn = (data, status = 200) => ({ status, data });

const HANDLERS: RouteHandler[] = [
  authRoutes,
  domainRoutes,
  settingsRoutes,
  projectRoutes,
  courseRoutes,
  mentorRoutes,
  userRoutes,
  notificationRoutes,
];
// D 的实现形状即 types.ts 里的 D 类型;导入那个类型名会与本地函数声明冲突
// (declaration merging),所以这里只实现、不再 import type。

export async function handle(ctx: Ctx): Promise<Result> {
  // ctx.seg 必须是完整、未剥离前缀的路径分段(见 guard.ts:needsAdmin 的契约①,
  // 它假定 seg[0]==='api'、检查 seg[1]==='admin')。调用方(server.ts)只能传
  // pathname.split('/').filter(Boolean) 的原样结果,不能先掐掉 /api。
  if (needsAdmin(ctx.method, ctx.seg) && (!ctx.user || ctx.user.role !== 'admin')) {
    return D({ error: '需要站长身份', code: 'admin_required' }, ctx.user ? 403 : 401);
  }
  for (const h of HANDLERS) {
    const r = await h(ctx, D);
    if (r) return r;
  }
  return D({ error: 'unknown api' }, 404);
}
