# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

星屿 Starisle:面向 AI 青少年的项目协作社区。**Bun + TypeScript** 后端(`Bun.serve` 零 HTTP 框架,数据层 Drizzle ORM на pg Pool)+ PostgreSQL 17,Vue 3 `<script setup lang="ts">` + Vite 前端(主站 portal + 控制台 admin 两个入口),`bun test` 后端测试(178 个用例,无前端测试)。主线:注册 → 站长审核 → 登录;发起项目 → 审核 → 公开;课程目录与导师目录。

仓库所有文档、注释、错误文案均为**中文**,写代码、注释、提交说明请沿用中文。

2026-09 本仓库完成了 Bun + TS + Drizzle 的全量重构与列表分页(历史提交 `f9337a2`/`16a8f9c`/`9e1ee39`/`2090f13`/`4c98a77`),文档已随之更新;若文档与本文件冲突,以代码为准。

## 常用命令

### 后端(仓库根;Bun 自动加载 `.env`,无需 --env-file)

| 命令 | 作用 |
|---|---|
| `bun run start` | 起服务(默认端口 4870)= `bun app/server.ts` |
| `bun run db:up` | `docker compose up -d db`,只起 Postgres |
| `bun run migrate` | 应用 `app/db/migrations/*.sql`(幂等,记入 `schema_migrations` 表) |
| `bun run create-admin` | 交互式建站长账号(也可用环境变量 ADMIN_USER/ADMIN_PASSWORD 非交互) |
| `bun run seed -- mentors` | 幂等导入 `app/db/seed/*.json`(all/courses/mentors/partners) |
| `bun test` | **全部测试文件单进程顺序执行**——必须先准备测试库(见下) |
| `bun run typecheck` | `tsc --noEmit`(只查后端 + 测试;前端独立 tsconfig) |

单个测试文件 / 按用例名过滤:

```bash
bun test test/guard.test.ts
bun test -t "保留动词"
```

### 前端(`app/frontend/`,独立 package.json + tsconfig)

| 命令 | 作用 |
|---|---|
| `bun run dev` | Vite 热更(5173,`/api` 代理到 4870) |
| `bun run typecheck` | `vue-tsc --noEmit` |
| `bun run build` | `vue-tsc --noEmit && vite build`,产物到 `app/public-dist/`(gitignored;后端从这里读静态文件) |

### 测试库准备(一次性)

测试绝不连开发库:`test/helpers/env.ts` 把 `DATABASE_URL` 覆写为 `TEST_DATABASE_URL`(兜底 `postgres://starisle:devpass@localhost:5432/starisle_test`)。它只读真实进程环境变量(`.env` 里的 TEST_DATABASE_URL 也会被 Bun 注入进程环境,同样生效):

```bash
docker exec starisle-db-local createdb -U starisle starisle_test
DATABASE_URL=postgres://starisle:devpass@localhost:5432/starisle_test bun run migrate
```

连库的测试文件每个用例前 `TRUNCATE ... RESTART IDENTITY CASCADE` 清空全部表(`test/helpers/db.ts` 的 `resetDb`,挂在 `beforeEach`)。**bun test 单进程跑所有文件**:不要在任何文件里 `pool.end()`(helpers 已刻意不导出 closeDb),连接池交给进程退出回收。

### 环境变量(坑)

- Bun 会自动加载 `.env`( Jerome 集比 Node `--env-file` 大:`.env.local`、`.env.{NODE_ENV}` 等;`.gitignore` 已忽略)。所有 `bun app/...` 命令直接生效;但**进程已有同名变量时 .env 不覆盖**——测试正是依赖这一点做覆写。
- Docker Compose 与本地跑共用同一个 `.env` 文件,但 host 要求不同:本地 `localhost`,compose 内必须是服务名 `db`。compose 里 `DATABASE_URL`、`POSTGRES_PASSWORD` 无默认值,缺失直接拒绝启动。
- 生产必须设 `SESSION_SECURE=1`(cookie 才带 Secure)。完整部署手册见 `docs/DEPLOY.md`。

## 架构

### 请求流

```
app/server.ts(Bun.serve 入口)
  解析 cookie → getSession() 查库换出 ctx.user → 非 GET 读 body
  → app/routes/index.ts#handle(ctx)
      ① guard.needsAdmin(method, seg) 不过 → 直接 401/403
      ② 依次传给 HANDLERS:auth → domains → settings → projects → courses
         → mentors → users → notifications;第一个返回非空结果的模块胜出
  → {status, data} 序列化为 JSON 回写
```

每个路由模块导出一个 `(ctx, D) => Promise<result|undefined>` 函数(默认导出,或命名导出辅助函数 + 默认导出 handler),按数组顺序短路。模块内部**不需要**判断「要不要站长身份」(守卫统一做),但要自己判断细粒度权限(如项目 owner)。

### 必须保持的不变量(行为契约)

- **`ctx.seg` 是完整路径分段,不剥离 `/api`**:`guard.needsAdmin` 假定 `seg[0]==='api'` 并检查 `seg[1]==='admin'`,server.ts 与所有调用方都依赖此契约。`ctx.path`/`ctx.seg` 从同一个 `new URL(req.url).pathname` 派生,不做二次解码。
- **守卫默认拒绝**:`needsAdmin` 四层判定——① `/api/admin/*` → ② 保留动词(`review/decide/grant/clear/pending/suspend`,路径任意一段命中即后台)→ ③ 白名单 `PUBLIC_ROUTES` → ④ 默认后台。新端点忘登记白名单 = 匿名拿 401,响亮失败是特性。
- **站长专属端点必须挂 `/api/admin/` 前缀**:白名单里 5 条「通配符在末段」的规则(`GET/PATCH /api/projects/:slug`、`GET /api/members/:username`、`GET /api/courses/:slug`、`GET /api/mentors/:slug`)会让形状凑巧撞上的新路由被静默判公开。`test/guard.test.ts` 最后一条用例把这份清单钉死;想加第 6 条必须在该测试注释里写下评估,不是把数组改长了事。
- **敏感字段序列化白名单只写一处**:`publicUser()`(auth.ts)/ `card()`(users.ts,成员卡不含 email)/ `publicMentor()`(mentors.ts,**唯一**剥 `contact_email` 的地方)。全系统只有 `GET /api/admin/users/pending` 会返回他人 email、`GET /api/admin/mentor-requests` 会返回导师邮箱。导师申请只收 4 个非 PII 字段(`interest/background/questions/weekly_hours`),`real_name`/`school`/`contact` 一律不读——这是产品隐私约束,不是疏忽。
- **多步写必须包 `tx()`**(`app/db/pool.ts`,回调拿到 drizzle client);**禁用 `db.transaction()`**(drizzle 自管事务与自管 tx 并存必出双 BEGIN)。`release(err)` 的「中毒连接不回池」语义要保留。
- **Drizzle schema 属性名一律 snake_case 与列名同名**(schema.ts 头部注释):builder 查询行键名取自属性名,直映列名才保证 API 响应形状与序列化白名单零漂移。**23505 捕获用 `pgCode(e)`**(drizzle ≥0.36 把驱动错误包在 `.cause`,裸路径在 `.code`);**raw `db.execute(sql\`\`)` 里 jsonb 仍要手工 stringify**,builder 路径不用。
- **body 边界处理**(server.ts):1MB 上限由 `Bun.serve({maxRequestBodySize})` 在 HTTP 层强制(带 Content-Length 的超限请求不进 fetch,Bun 直接回 413);`req.json()` 失败一律归 `{}`;`stripNul` 剥 U+0000(深度上限 100)。多字节字符跨 TCP 分片的解码安全由 Bun 的 `req.json()` 整体解码保证,由 test/server-http.test.ts 的分片用例钉住。
- **bigint 解析**:pool.ts 对 pg OID 20 全局注册 `setTypeParser(20, Number)`,所有 id/COUNT 出来即 number;drizzle `bigint({mode:'number'})` 是无害幂等。换驱动时要等价保留。
- **掩护性 404**:未过审项目/课程/隐藏导师对非 owner 一律 404 而非 403,避免向无关者泄露存在性。
- **并发兜底靠部分唯一索引**(项目加入申请、课程报名的「已有 pending/approved 则 409」),不是先查后插。
- `app/server.ts` 有 `import.meta.main` 守卫:被 import 时不自动 listen(`test/server-http.test.ts` 用 `createApp({port:0})` 自行起停)。
- 会话是数据库服务端会话(30 天,HttpOnly cookie `starisle_sid`),无 JWT;登录对不存在的账号也跑一次等代价 scrypt 抹平时序侧信道。
- **分页**:列表端点用 `?page=&per_page=`(默认 1/20,per_page 夹 [1,100]),响应是「原列表键 + `pagination` 兄弟键」(`{page,per_page,total,total_pages}`;some 端点另有 `domain_counts`)。所有分页查询的 ORDER BY **必须带唯一 tiebreaker**(现有做法:`created_at DESC, id DESC`)。助手在 `app/lib/pagination.ts` / `like.ts` / `statuses.ts`。哪些端点分页、哪些刻意不分页(枚举/有界/全量消费),清单与理由在 docs/API.md。
- `?q=` 搜索必须 `escapeLike()`(用户提供输入里的 %/_ 是 LIKE 元字符);`?status=` 多值用 `statusesParam(qs, 本端点白名单)`(accepted/approved/completed 各类别不同)。

### 数据库

- PostgreSQL 17(本机开发也可能是别的版本),5 份迁移(`001_init` … `005_mentors`),逐字段表结构见 `docs/DATA-MODEL.md`。
- **schema 纪律**:手写 SQL 迁移是结构唯一真源;`app/db/schema.ts` 是它的类型化镜像(改表先迁移、再同步 schema);事务只用自管 `tx()`,禁 `db.transaction()`。
- **新增表要同步改 `test/helpers/db.ts` 的 TABLES 清单**:TRUNCATE CASCADE 清不掉没有外键指回 `users` 的表(`mentors`、`partner_orgs` 就因此单独列着),漏了会跨用例累积数据。
- Dockerfile 为多阶段构建(前端 build → 只拷 `pg` 依赖与源码),容器启动命令自动跑迁移再起服务。

### 前端

- 两个 Vite 入口:`index.html`(portal)+ `admin.html`(admin),产物都在 `app/public-dist`,由后端静态服务,无独立前端部署形态。
- 极简三段哈希路由(`src/lib/router.ts`:page/param/sub);`PortalApp.vue` 的 PAGES 表决定哪个路由名真有页面,`members`/`u` 已登记但无页面(静默落回首页)。
- 全局状态是 `src/portal/store.ts` 的 reactive 对象;`boot()` 只拉 me/domains/stats/settings。列表数据在页面级:**ProjectsSection 用 `store.projectsState` 分页缓存**(首次 `refreshProjects({reset:true})`,翻页/筛选带参),Courses/Mentors/MyCourses 各自持有 page 状态。
- API 封装在 `src/lib/api.ts`:cookie 会话(`credentials:'same-origin'`),遇 401 广播 `starisle:unauthorized` 事件。通知与后台待办角标**都不轮询**(角标读 `pagination.total`,只拉 per_page=1)。
- 分页 UI:`components/PaginationBar.vue`(页码 + 上/下页 + total);admin 审核页操作后按「当前页删空退回 total_pages」钳制。

### 已知空壳(改动前的必读)

`docs/MODULES.md` 记录前端重写过渡期刻意留下的空壳:首页 4 条不请求任何接口的空 strip、项目列表页恒为 0 的状态筛选 tab(分页改造时已把计数改读 pagination.total/domain_counts 的部分收紧,chip 仍然恒 0 不可点)、详情页写死的 `platform:'Gitee'`/`activity:0`、DrawerView 的死壳字段(growth/portfolio/timeline/关注),以及后端已有但前端没入口的 `PATCH /api/me`、`POST /api/projects/:slug/members`。这些是过渡状态不是 bug。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/API.md` | 全部端点、鉴权分级、保留动词、分页约定与不分页清单、未实现功能(改 API 前必读) |
| `docs/ARCHITECTURE.md` | 分层与请求流细节 |
| `docs/DATA-MODEL.md` | 逐字段表结构与隐私说明(Drizzle schema 镜像纪律) |
| `docs/MODULES.md` | 前端页面细节与空壳清单 |
| `docs/DEPLOY.md` | Docker Compose 运行手册 |

`web/`、`demo/` 是重写时留下的辅助材料(手写 API 走查页、演示脚本),不是应用的一部分;demo 脚本已同步为 bun 命令。
