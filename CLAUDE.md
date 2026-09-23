# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

星屿 Starisle:面向 AI 青少年的项目协作社区。Node 内建 `http`(零 HTTP 框架,生产依赖只有 `pg`)+ PostgreSQL 后端,Vue 3 + Vite 前端(主站 portal + 控制台 admin 两个入口),`node --test` 后端测试(无前端测试)。主线:注册 → 站长审核 → 登录;发起项目 → 审核 → 公开;课程目录与导师目录。

仓库所有文档、注释、错误文案均为**中文**,写代码、注释、提交说明请沿用中文。

## 当前任务(接手目标)

1. **用 Bun + TypeScript 重构后端**(本机 bun 1.4.2 / node 24 均已装)。这是换运行时与语言,**不是重新设计**——下文「必须保持的不变量」里的行为契约在重构后必须逐条仍然成立,现有测试应迁移为 `bun test` 并继续通过。前端暂保持 Vue 3 + Vite 不动。
2. **添加分页**。当前所有列表端点一次返回全部行(唯一例外:`GET /api/notifications` 内置 `LIMIT 50`),全库没有任何 LIMIT/OFFSET/游标分页。分页要覆盖:公开列表(`GET /api/projects`、`/api/courses`、`/api/mentors`、`/api/members`、`/api/partners`)和后台列表(`GET /api/admin/users/pending`、`/api/admin/projects/pending`、`/api/admin/course-enrollments`、`/api/admin/mentor-requests`、`GET /api/projects/:slug/join-requests`)。**改 API 时必须同步改前端消费点**:`app/frontend/src/portal/store.js#boot()` 一次性并行拉 `/projects`、`/members`、`/courses` 等整份塞进全局 store,首页和项目列表页直接渲染整份,API 改成分页后这些地方会拿到空列表。

## 常用命令

### 后端(仓库根,需 Node ≥ 22,`--env-file-if-exists` 标志)

| 命令 | 作用 |
|---|---|
| `npm start` | 起服务(默认端口 4870)= `node --env-file=.env app/server.js` |
| `npm run db:up` | `docker compose up -d db`,只起 Postgres |
| `npm run migrate` | 应用 `app/db/migrations/*.sql`(幂等,记入 `schema_migrations` 表) |
| `npm run create-admin` | 交互式建站长账号 |
| `DATABASE_URL=... node app/bin/import-seed.js [courses\|mentors\|partners]` | 幂等导入 `app/db/seed/*.json`(未列入 npm scripts) |
| `npm test` | `node --test --test-concurrency=1`,**必须串行**——所有测试文件共用同一个测试库 |

单个测试文件 / 按用例名过滤:

```bash
node --env-file-if-exists=.env --test --test-concurrency=1 test/guard.test.js
# 过滤用例名:追加 --test-name-pattern="保留动词"
```

### 前端(`app/frontend/`,独立 package.json,不是 workspace)

| 命令 | 作用 |
|---|---|
| `npm run dev` | Vite 热更(5173,`/api` 代理到 4870) |
| `npm run build` | 构建到 `app/public-dist/`(gitignored;后端从这里读静态文件) |

### 测试库准备(一次性)

测试绝不连开发库:`test/helpers/db.js` 在 require 时把 `DATABASE_URL` 覆写为 `TEST_DATABASE_URL`(兜底 `postgres://starisle:devpass@localhost:5432/starisle_test`)。它**只读真实进程环境变量,`.env` 文件不生效**:

```bash
docker exec starisle-db-local createdb -U starisle starisle_test
DATABASE_URL=postgres://starisle:devpass@localhost:5432/starisle_test npm run migrate
# Windows PowerShell 无内联前缀语法,分两句:$env:DATABASE_URL="..."; npm run migrate
```

`guard.test.js` 与 `password.test.js` 是纯单元测试不碰库;其余测试文件每个用例前 `TRUNCATE ... RESTART IDENTITY CASCADE` 清空全部表。

### 环境变量(坑)

- 后端代码不读 `.env`;`npm start` / `npm run migrate` 靠 Node 的 `--env-file` 标志加载,直接 `node app/...` 则要求变量已在 shell 里。换终端要重新导出。
- Docker Compose 与本地跑共用同一个 `.env` 文件,但 host 要求不同:本地 `localhost`,compose 内必须是服务名 `db`。compose 里 `DATABASE_URL`、`POSTGRES_PASSWORD` 无默认值,缺失直接拒绝启动。
- 生产必须设 `SESSION_SECURE=1`(cookie 才带 Secure)。完整部署手册见 `docs/DEPLOY.md`。

## 架构

### 请求流

```
app/server.js(Node http 入口)
  解析 cookie → getSession() 查库换出 ctx.user → 非 GET 读 body(1MB 上限)
  → app/routes/index.js#handle(ctx)
      ① guard.needsAdmin(method, seg) 不过 → 直接 401/403
      ② 依次传给 HANDLERS:auth → domains → settings → projects → courses
         → mentors → users → notifications;第一个返回非空结果的模块胜出
  → {status, data} 序列化为 JSON 回写
```

每个路由模块导出一个 `(ctx, D) => Promise<result|undefined>` 函数,按数组顺序短路。模块内部**不需要**判断「要不要站长身份」(守卫统一做),但要自己判断细粒度权限(如项目 owner)。

### 必须保持的不变量(Bun+TS 重构时的行为契约)

- **`ctx.seg` 是完整路径分段,不剥离 `/api`**:`guard.needsAdmin` 假定 `seg[0]==='api'` 并检查 `seg[1]==='admin'`,server.js 与所有调用方都依赖此契约。
- **守卫默认拒绝**:`needsAdmin` 四层判定——① `/api/admin/*` → ② 保留动词(`review/decide/grant/clear/pending/suspend`,路径任意一段命中即后台)→ ③ 白名单 `PUBLIC_ROUTES` → ④ 默认后台。新端点忘登记白名单 = 匿名拿 401,响亮失败是特性。
- **站长专属端点必须挂 `/api/admin/` 前缀**:白名单里 5 条「通配符在末段」的规则(`GET/PATCH /api/projects/:slug`、`GET /api/members/:username`、`GET /api/courses/:slug`、`GET /api/mentors/:slug`)会让形状凑巧撞上的新路由被静默判公开。`test/guard.test.js` 最后一条用例把这份清单钉死;想加第 6 条必须在该测试注释里写下评估,不是把数组改长了事。
- **敏感字段序列化白名单只写一处**:`publicUser()`(auth.js)/ `card()`(users.js,成员卡不含 email)/ `publicMentor()`(mentors.js,**唯一**剥 `contact_email` 的地方)。全系统只有 `GET /api/admin/users/pending` 会返回他人 email、`GET /api/admin/mentor-requests` 会返回导师邮箱。导师申请只收 4 个非 PII 字段(`interest/background/questions/weekly_hours`),`real_name`/`school`/`contact` 一律不读——这是产品隐私约束,不是疏忽。
- **多步写必须包 `tx()`**(`app/db/pool.js`:创建项目+写 owner、处理加入申请+插成员等);`client.release(err)` 的「中毒连接不回池」语义要保留。
- **body 边界处理**(server.js,重写为 `Bun.serve` 时要逐条对齐):1MB 上限超限直接断连不写响应(防请求走私);Buffer 攒齐再一次解码(防多字节字符跨 TCP 分片变 U+FFFD 静默落库);`stripNul` 剥 U+0000(PostgreSQL text 不收 NUL,否则 500)。
- **bigint 解析**:pool.js 对 pg OID 20 全局注册 `setTypeParser(20, Number)`,所有 id/COUNT 出来即 number。换驱动时要等价保留,否则 id 变字符串、前后端约定分叉。
- **掩护性 404**:未过审项目/课程/隐藏导师对非 owner 一律 404 而非 403,避免向无关者泄露存在性。
- **并发兜底靠部分唯一索引**(项目加入申请、课程报名的「已有 pending/approved 则 409」),不是先查后插。
- `app/server.js` 有 `require.main === module` 守卫:被 require 时不自动 listen(`test/server-http.test.js` 依赖)。
- 会话是数据库服务端会话(30 天,HttpOnly cookie `starisle_sid`),无 JWT;登录对不存在的账号也跑一次等代价 scrypt 抹平时序侧信道。

### 数据库

- PostgreSQL 17,5 份迁移(`001_init` … `005_mentors`),逐字段表结构见 `docs/DATA-MODEL.md`。
- **新增表要同步改 `test/helpers/db.js` 的 TABLES 清单**:TRUNCATE CASCADE 清不掉没有外键指回 `users` 的表(`mentors`、`partner_orgs` 就因此单独列着),漏了会跨用例累积数据。
- Dockerfile 为多阶段构建(前端 build → 只拷 `pg` 依赖与源码),容器启动命令自动跑迁移再起服务。

### 前端

- 两个 Vite 入口:`index.html`(portal)+ `admin.html`(admin),产物都在 `app/public-dist`,由后端静态服务,无独立前端部署形态。
- 极简三段哈希路由(`src/lib/router.js`:page/param/sub);`PortalApp.vue` 的 PAGES 表决定哪个路由名真有页面,`members`/`u` 已登记但无页面(静默落回首页)。
- 全局状态是 `src/portal/store.js` 的 reactive 对象,`boot()` 一次性拉首屏数据,每个字段带兜底,任一接口失败不阻塞 `store.ready`。
- API 封装在 `src/lib/api.js`:cookie 会话(`credentials:'same-origin'`),遇 401 广播 `starisle:unauthorized` 事件。通知与后台待办角标**都不轮询**。

### 已知空壳(改动前的必读)

`docs/MODULES.md` 详细记录了前端重写过渡期刻意留下的空壳:首页 4 条不请求任何接口的空 strip、项目列表页恒为 0 的筛选标签与恒显「0 名成员」、详情页写死的 `platform:'Gitee'`/`activity:0`,以及后端已有但前端没入口的 `PATCH /api/me`、`POST /api/projects/:slug/members`。这些是过渡状态不是 bug;分页改造会动到的页面(ProjectsPage/CoursesPage/MentorsPage)里就有这些壳。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/API.md` | 全部端点、鉴权分级、保留动词、未实现功能清单(改 API 前必读) |
| `docs/ARCHITECTURE.md` | 分层与请求流细节 |
| `docs/DATA-MODEL.md` | 逐字段表结构与隐私说明 |
| `docs/MODULES.md` | 前端页面细节与空壳清单 |
| `docs/DEPLOY.md` | Docker Compose 运行手册 |

`web/`、`demo/` 是重写时留下的辅助材料(手写 API 走查页、演示脚本),不是应用的一部分。
