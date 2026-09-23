import { handle } from '../../app/routes';
import type { SessionUser } from '../../app/auth/session';
import type { Result } from '../../app/routes/types';

// 构造 ctx 直调 handle(),绕过真实 HTTP 层 —— 这是除 server-http 外全部测试的
// 架构特征(见 test/server-http.test.ts 头部注释)。session 只是个假壳:真实
// 路径里 ctx.user 由 getSession() 从 session 行 join 出来,这里由 user 参数
// 直接给定,session 仅需"非空"以模拟已登录形态。
// (原先 6 个文件各有一份逐字近似副本,收敛到这里;userAgent/ip 的取值
// 没有任何断言依赖,统一成一份。)
export const call = (
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  user: SessionUser | null = null,
  qs = '',
): Promise<Result> =>
  handle({
    method, path,
    seg: path.split('/').filter(Boolean),
    query: new URLSearchParams(qs), body, user,
    session: user ? ({ id: 'fake' } as any) : null,
    userAgent: 'test', ip: '127.0.0.1',
  });
