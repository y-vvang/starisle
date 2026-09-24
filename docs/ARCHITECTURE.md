# 架构 · Architecture

星屿是一个**有状态**的全栈应用:注册、审核、发起项目、加入项目、关注都会真实改变服务端数据。数据落在 PostgreSQL 里,进程重启、容器重建都不会丢数据(卷持久化)。

**没有两套运行时。** Cloudflare Workers、Durable Object、`app/core.js`、`worker/index.js`、`wrangler.jsonc` 这一整条"传输无关核心 + Node/边缘双运行时"的设计已经在重写中整体删除(见 git log 里的 `删除旧后端:内存 core、dummy 数据、Cloudflare Worker、早期原型`)。当前只有一种运行方式:Bun 进程 + PostgreSQL,本地这样跑,生产也这样跑,唯一的差别是外面套不套反向代理和 TLS。

---

## 1. 分层

```
┌─────────────────────────────────────────────┐
│  前端(Vue 3 + Vite)                         │
│   app/frontend/src/portal   主站(3 个页面)  │
│   app/frontend/src/admin    控制台(4 个页面)│
│      构建 → app/public-dist(静态文件)       │
├─────────────────────────────────────────────┤
│  路由分发 + 鉴权守卫                         │
│   app/routes/index.ts  handle(ctx)           │
│   app/auth/guard.ts    needsAdmin() 默认拒绝 │
├─────────────────────────────────────────────┤
│  业务路由(app/routes/*.ts)                  │
│   auth · domains · settings · projects       │
│   users · notifications                      │
├─────────────────────────────────────────────┤
│  数据访问                                    │
│   app/db/pool.ts   pg 连接池 + 事务助手 tx() │
│   app/auth/session.ts / password.ts          │
├─────────────────────────────────────────────┤
│  PostgreSQL(app/db/migrations/*.sql)         │
└─────────────────────────────────────────────┘
```

`app/server.ts` 是最外层的 Node `http` 包装:解析 cookie、读 body、把请求包成 `ctx` 对象交给 `handle(ctx)`,再把返回的 `{status, data}` 写成 JSON 响应;`/api/` 之外的路径直接从 `app/public-dist` 读静态文件。它是唯一的入口,没有第二套(边缘)入口。

---

## 2. 请求怎么走一遍

以 `POST /api/projects/foo/join`(登录用户申请加入项目)为例:

1. `app/server.ts` 的 `http.createServer` 回调收到请求,解析 cookie 拿 `starisle_sid`,调 `getSession()` 查 `sessions` 表(join `users`)换出 `ctx.user`;非 GET 请求先把 body 读完(限 1MB,超限直接断连,见该文件里关于请求走私的详细注释)。
2. 组装 `ctx = { method, path, seg, query, body, session, user, userAgent, ip }` 交给 `app/routes/index.ts#handle(ctx)`。`seg` 是**完整、未剥离 `/api` 前缀**的路径分段 —— 这是一个显式契约,因为 `guard.needsAdmin` 假定 `seg[0]==='api'`。
3. `handle()` 先跑 `needsAdmin(ctx.method, ctx.seg)`。这条路径命中 `PUBLIC_ROUTES` 里的 `POST /api/projects/:slug/join`,不需要站长身份,往下走。
4. 依次把 `ctx` 交给 `HANDLERS` 数组里的每个路由模块(`auth → domains → settings → projects → users → notifications`),第一个返回非空结果的模块胜出。`projects.ts` 里对应的分支执行业务逻辑:查项目、查是否已是成员、查是否已有待处理申请、`INSERT INTO project_join_requests`、写一条通知给项目 owner。
5. 结果 `{status, data}` 被 `server.ts` 序列化成 JSON 写回,响应头带 `Cache-Control: no-store`。

鉴权守卫在**第 3 步**统一执行,业务路由模块内部不需要(也不应该)重新判断"这条路径是不是要登录" —— 但业务模块仍然要自己判断更细的权限(比如"是不是项目 owner"),守卫只解决"要不要站长身份"这一层。详见 `docs/API.md`。

---

## 3. 鉴权与会话

- **密码**:`app/auth/password.ts`,scrypt(`N=2^16, r=8, p=2`),自定义 `scrypt$N$r$p$salt$hash` 存储格式,`timingSafeEqual` 比对。登录接口对"账号不存在"也跑一次等代价的哈希,避免响应时间侧信道。
- **会话**:`app/auth/session.ts`,32 字节随机 id,存在 `sessions` 表,默认 30 天过期,靠 `HttpOnly` cookie(`starisle_sid`)下发。没有 JWT、没有无状态 token —— 每次请求都会查一次数据库换会话。
- **路由分级**:`app/auth/guard.ts#needsAdmin()`,见 `docs/API.md` 的"鉴权"一节,核心是**默认拒绝** —— 新端点不主动登记进白名单就自动变成后台端点。**例外**:白名单里的三条 `:param` 通配符规则(`GET /api/projects/:slug`、`PATCH /api/projects/:slug`、`GET /api/members/:username`)会让任何形状凑巧撞上的未来路由被静默判为公开,不经过默认拒绝这一步。缓解手段不是改 guard 的匹配逻辑,而是纪律:**任何站长专属的新端点必须挂在 `/api/admin/` 前缀下**,这样第①层判定会在通配符匹配之前把它拦成后台。详见 `docs/API.md`。

---

## 4. 数据访问

`app/db/pool.ts` 包一个 `pg.Pool`(`max: 10`),导出 `query(text, params)` 与 `tx(fn)`(BEGIN/COMMIT/ROLLBACK helper,回调拿到独立 client)。多步写操作(比如"创建项目 + 把发起人写入 project_members"、"处理加入申请 + 插入成员")都用 `tx()` 包成一个事务,不存在"看起来成功但其实只改了一半"的中间态。

---

## 5. 前端

`app/frontend`(Vue 3 + Vite)构建成两个入口:

- **主站(portal)**:`HomePage` / `ProjectsPage` / `ProjectDetailPage` 三个页面,`app/frontend/src/lib/router.ts` 的极简哈希路由驱动。
- **控制台(admin)**:`MembersPage` / `ProjectsReviewPage` / `SiteSettingsPage` / `UserReviewPage` 四个页面,登录后校验 `role==='admin'` 才放行。**没有权限组** —— 站长就是站长,不存在"内容运营/用户运营/资源运营"这类分组,旧文档里那套侧栏分组随旧前端一起被删了。

`bun run build`(在 `app/frontend` 目录下)把两个入口编译进 `app/public-dist`,`app/server.ts` 直接从这里读静态文件。**没有独立的前端开发服务器部署形态** —— `vite dev` 只用于本地热更,生产永远是构建产物。

---

## 6. Docker

`Dockerfile` 是多阶段构建:第一阶段 `oven/bun:1` 装前端依赖并 `bun run build`,第二阶段只拷贝生产依赖(`pg`)、`app/` 源码和第一阶段产出的 `public-dist`,启动命令是 `bun app/db/migrate.ts && bun app/server.ts` —— **容器启动即自动跑迁移**,不需要手动执行一步"迁移"。`docker-compose.yml` 定义 `db`(`postgres:17-alpine`,带 healthcheck)与 `app` 两个服务。详见 `docs/DEPLOY.md`。

---

## 7. 测试

`bun test`(等价 `npm test`)(bun test 单进程顺序执行所有测试文件 —— 多个测试文件共用同一个测试数据库,单进程正是共享成立的前提;因此不要在任何测试文件里 `pool.end()`,连接池交给进程退出回收)。测试连的是 `TEST_DATABASE_URL`(`test/helpers/env.ts` + `bunfig.toml` 的 `[test]` preload 双保险覆写 `DATABASE_URL`,兜底成 `postgres://starisle:devpass@localhost:5432/starisle_test`,绝不读生产的开发库连接串),连库的测试文件(13 个里的 11 个,`guard` 与 `password` 是纯单元测试,不碰数据库)在**每个用例前** `TRUNCATE ... RESTART IDENTITY CASCADE` 清空表(`test/helpers/db.ts` 的 `resetDb`,挂在 `beforeEach`)。当前 `bun test` 报 **178 个测试**,覆盖后端(密码哈希、会话、路由守卫、slug 生成、账号路由、项目路由、项目互动、项目内容字段、HTTP 层、建站长 CLI、分页钉桩)。**没有前端测试** —— 前端类型正确性靠 `vue-tsc --noEmit`(挂在 build 前)把关。
