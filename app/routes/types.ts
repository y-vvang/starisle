// 路由层的共享类型:ctx 的形状、handler 的签名、响应结果的形状。
// 单独放一个文件而不是放进 routes/index.ts,是为了避免「index import 各
// handler、各 handler 又 import index 拿类型」的环(虽然 import type 会被
// 擦除,独立文件更直白)。
import type { Session, SessionUser } from '../auth/session';

export interface Ctx {
  method: string;
  path: string;
  // 契约①:seg 必须是完整、未剥离 /api 前缀的路径分段 —— guard.needsAdmin
  // 的第①层直接假定 seg[0]==='api' 并检查 seg[1]==='admin'。调用方(server.ts)
  // 只能传 pathname.split('/').filter(Boolean) 的原样结果。
  seg: string[];
  query: URLSearchParams;
  // 已解析的 JSON 纯对象(非纯对象/解析失败一律 {});NUL 已在 server.ts 剥掉。
  // 值类型刻意保持 unknown:请求体是外部输入,路由代码必须经过 typeof/校验
  // 才能当具体类型用 —— 这本来就是现有代码的写法。
  body: Record<string, unknown>;
  session: Session | null;
  user: SessionUser | null;
  userAgent: string | null;
  ip: string | null;
}

export interface Result {
  status: number;
  // data 是直接 JSON 序列化回给客户端的响应体,形状因端点而异;测试代码
  // 会直接深访问(r.data.project.status 这类),标 any 是刻意的务实选择,
  // A2(Drizzle)引入行类型后再考虑收窄。
  data: any;
  // 仅 auth 路由使用:登录签发会话 / 登出·改密码吊销会话,由 server.ts
  // 映射成 Set-Cookie。
  setSession?: { id: string; maxAge: number };
  clearSession?: boolean;
}

export type D = (data: any, status?: number) => Result;

// 每个路由模块导出一个这样的函数,由 routes/index.ts 按序分发;
// 返回 undefined 表示「这条路径不归我管」,落到下一个模块。
export type RouteHandler = (ctx: Ctx, D: D) => Promise<Result | undefined>;
