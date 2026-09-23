# 架构 · Architecture

星屿是一个**有状态**的全栈应用:注册、审核、发起项目、加入项目、关注都会真实改变服务端数据。数据落在 PostgreSQL 里,进程重启、容器重建都不会丢数据(卷持久化)。

**没有两套运行时。** Cloudflare Workers、Durable Object、`app/core.js`、`worker/index.js`、`wrangler.jsonc` 这一整条"传输无关核心 + Node/边缘双运行时"的设计已经在重写中整体删除(见 git log 里的 `删除旧后端:内存 core、dummy 数据、Cloudflare Worker、早期原型`)。当前只有一种运行方式:Node 进程 + PostgreSQL,本地这样跑,生产也这样跑,唯一的差别是外面套不套反向代理和 TLS。

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
│   app/routes/index.js  handle(ctx)           │
│   app/auth/guard.js    needsAdmin() 默认拒绝 │
├─────────────────────────────────────────────┤
│  业务路由(app/routes/*.js)                  │
│   auth · domains · settings · projects       │
│   users · notifications                      │
├─────────────────────────────────────────────┤
│  数据访问                                    │
│   app/db/pool.js   pg 连接池 + 事务助手 tx() │
│   app/auth/session.js / password.js          │
├─────────────────────────────────────────────┤
│  PostgreSQL(app/db/migrations/*.sql)         │
└─────────────────────────────────────────────┘
```

`app/server.js` 是最外层的 Node `http` 包装:解析 cookie、读 body、把请求包成 `ctx` 对象交给 `handle(ctx)`,再把返回的 `{status, data}` 写成 JSON 响应;`/api/` 之外的路径直接从 `app/public-dist` 读静态文件。它是唯一的入口,没有第二套(边缘)入口。

---

## 2. 请求怎么走一遍

以 `POST /api/projects/foo/join`(登录用户申请加入项目)为例:

1. `app/server.js` 的 `http.createServer` 回调收到请求,解析 cookie 拿 `starisle_sid`,调 `getSession()` 查 `sessions` 表(join `users`)换出 `ctx.user`;非 GET 请求先把 body 读完(限 1MB,超限直接断连,见该文件里关于请求走私的详细注释)。
2. 组装 `ctx = { method, path, seg, query, body, session, user, userAgent, ip }` 交给 `app/routes/index.js#handle(ctx)`。`seg` 是**完整、未剥离 `/api` 前缀**的路径分段 —— 这是一个显式契约,因为 `guard.needsAdmin` 假定 `seg[0]==='api'`。
3. `handle()` 先跑 `needsAdmin(ctx.method, ctx.seg)`。这条路径命中 `PUBLIC_ROUTES` 里的 `POST /api/projects/:slug/join`,不需要站长身份,往下走。
4. 依次把 `ctx` 交给 `HANDLERS` 数组里的每个路由模块(`auth → domains → settings → projects → users → notifications`),第一个返回非空结果的模块胜出。`projects.js` 里对应的分支执行业务逻辑:查项目、查是否已是成员、查是否已有待处理申请、`INSERT INTO project_join_requests`、写一条通知给项目 owner。
5. 结果 `{status, data}` 被 `server.js` 序列化成 JSON 写回,响应头带 `Cache-Control: no-store`。

鉴权守卫在**第 3 步**统一执行,业务路由模块内部不需要(也不应该)重新判断"这条路径是不是要登录" —— 但业务模块仍然要自己判断更细的权限(比如"是不是项目 owner"),守卫只解决"要不要站长身份"这一层。详见 `docs/API.md`。

---

## 3. 鉴权与会话

- **密码**:`app/auth/password.js`,scrypt(`N=2^16, r=8, p=2`),自定义 `scrypt$N$r$p$salt$hash` 存储格式,`timingSafeEqual` 比对。登录接口对"账号不存在"也跑一次等代价的哈希,避免响应时间侧信道。
- **会话**:`app/auth/session.js`,32 字节随机 id,存在 `sessions` 表,默认 30 天过期,靠 `HttpOnly` cookie(`starisle_sid`)下发。没有 JWT、没有无状态 token —— 每次请求都会查一次数据库换会话。
- **路由分级**:`app/auth/guard.js#needsAdmin()`,见 `docs/API.md` 的"鉴权"一节,核心是**默认拒绝** —— 新端点不主动登记进白名单就自动变成后台端点。**例外**:白名单里的三条 `:param` 通配符规则(`GET /api/projects/:slug`、`PATCH /api/projects/:slug`、`GET /api/members/:username`)会让任何形状凑巧撞上的未来路由被静默判为公开,不经过默认拒绝这一步。缓解手段不是改 guard 的匹配逻辑,而是纪律:**任何站长专属的新端点必须挂在 `/api/admin/` 前缀下**,这样第①层判定会在通配符匹配之前把它拦成后台。详见 `docs/API.md`。

---

## 4. 数据访问

`app/db/pool.js` 包一个 `pg.Pool`(`max: 10`),导出 `query(text, params)` 与 `tx(fn)`(BEGIN/COMMIT/ROLLBACK helper,回调拿到独立 client)。多步写操作(比如"创建项目 + 把发起人写入 project_members"、"处理加入申请 + 插入成员")都用 `tx()` 包成一个事务,不存在"看起来成功但其实只改了一半"的中间态。

---

## 5. 前端

`app/frontend`(Vue 3 + Vite)构建成两个入口:

- **主站(portal)**:`HomePage` / `ProjectsPage` / `ProjectDetailPage` 三个页面,`app/frontend/src/lib/router.js` 的极简哈希路由驱动。
- **控制台(admin)**:`MembersPage` / `ProjectsReviewPage` / `SiteSettingsPage` / `UserReviewPage` 四个页面,登录后校验 `role==='admin'` 才放行。**没有权限组** —— 站长就是站长,不存在"内容运营/用户运营/资源运营"这类分组,旧文档里那套侧栏分组随旧前端一起被删了。

`npm run build`(在 `app/frontend` 目录下)把两个入口编译进 `app/public-dist`,`app/server.js` 直接从这里读静态文件。**没有独立的前端开发服务器部署形态** —— `vite dev` 只用于本地热更,生产永远是构建产物。

---

## 6. Docker

`Dockerfile` 是多阶段构建:第一阶段 `node:24-alpine` 装前端依赖并 `npm run build`,第二阶段只拷贝生产依赖(`pg`)、`app/` 源码和第一阶段产出的 `public-dist`,启动命令是 `node app/db/migrate.js && node app/server.js` —— **容器启动即自动跑迁移**,不需要手动执行一步"迁移"。`docker-compose.yml` 定义 `db`(`postgres:17-alpine`,带 healthcheck)与 `app` 两个服务。详见 `docs/DEPLOY.md`。

---

## 7. 测试

`npm test` 即 `node --test --test-concurrency=1`(单进程串行,因为多个测试文件共用同一个测试数据库,并发跑会互相冲掉数据)。测试连的是 `TEST_DATABASE_URL`(`test/helpers/db.js` 里写死兜底成 `postgres://starisle:devpass@localhost:5432/starisle_test`,绝不读生产的 `DATABASE_URL`),连库的测试文件(10 个里的 8 个,`guard` 与 `password` 是纯单元测试,不碰数据库)在**每个用例前** `TRUNCATE ... RESTART IDENTITY CASCADE` 清空表(`test/helpers/db.js` 的 `resetDb`,挂在 `test.beforeEach`)。当前 `npm test` 报 **116 个测试**,全部覆盖后端(密码哈希、会话、路由守卫、slug 生成、账号路由、项目路由、项目互动、项目内容字段、HTTP 层、建站长 CLI)。这个数字和你数出来的可能差一个:10 个 `*.test.js` 里的顶层 `test()` 合计 115 个,第 116 个是 `node --test` 从 cwd 递归发现时把不含任何测试的 `test/helpers/db.js` 也当成测试文件加载所计入的空文件项——无害,但别为这 1 的差额去找不存在的用例。**没有前端测试**。
