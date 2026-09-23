# 星屿 Starisle · 重构设计（spec）

> 2026-08-17 · 内存 DB → PostgreSQL；删除演示身份与全部 dummy 数据；改为站长 + 申请审核制的真实账号体系

## Context

星屿现在是一个**完成度很高的演示**，不是产品：

- 全部数据在内存（`app/core.js` 的 `let db = seed.build()`），进程重启即回种子态；Cloudflare Durable Object 休眠也会静默重置。
- 没有账号。前台 7 个「视角」是演示式换位，点一下就换、无密码；服务端身份完全来自请求体里的自述字段（`founderId`/`memberId`），可任意伪造。
- 72 个成员、24 个项目、995 条贡献事件全部由 `seed.js`/`network.js` 用固定种子生成。
- 16 个模块中大部分对真实运营没有价值，却都在增加理解成本。

上一轮（`465b79d`，分支 `p0-admin-auth`）做了 P0 安全止血：运营口令 + 默认拒绝的路由分级，堵住未成年人 PII 无鉴权外泄。那是止血，这份 spec 是治本。

**目标**：一个能真实使用的小型社区站。站长审核放人进来，成员发布归属于自己的项目，数据落在 PostgreSQL，跑在自有服务器。

## 已确认的决策

| # | 决策 | 取舍 |
|---|---|---|
| 1 | **Node + PostgreSQL，自有服务器** | 放弃 Cloudflare 边缘。Worker 无原生 TCP，连 Postgres 需 Hyperdrive（付费）或第三方 HTTP 驱动；真实账号体系本就不适合内存态 DO。删 `worker/`、`wrangler.jsonc` |
| 2 | **极简内核**：账号 + 项目 + 成员目录 + 通知 | 其余 12 模块与全部 dummy 数据删除 |
| 3 | **自助申请 + 站长审核**，带「开放注册」开关 | 站长可随时关闭报名入口 |
| 4 | **项目保留「提交 → 审核 → 上线」** | 站长发的项目同样走队列 |
| 5 | **注册字段：必需 + 作品链接** | 用户名、密码、显示名、邮箱、申请说明、仓库链接。**不收真名/年龄/学校/手机** |
| 6 | **删除银河图** | `lib/galaxy.js` 及挂载点移除；首屏改为文案 + 项目预览 |

## 零、先做这件事，否则整站白屏

**领域（domains）必须先从银河图里拆出来。**

6 个领域（`agent`/`edu`/`climate`/`health`/`creative`/`infra`，各带 name + color）现在定义在 `app/data/seed.js:18-25`，**搭着 `galaxyGraph()` 的返回值**送到前端（`app/core.js` 的 `/api/galaxy` 末尾 `return { nodes, links, domains: db.domains }`）。

前端在 `portal/store.js:61-66` 这样取：

```js
const [graph, stats] = await Promise.all([api('/galaxy'), api('/stats')]);
store.domains = graph.domains;                                   // ← 删了 galaxy 就是 undefined
store.dcolor  = Object.fromEntries(graph.domains.map(...));      // ← TypeError
store.ready   = true;                                            // ← 永远走不到
```

`api()` 不抛异常（401/500 都 resolve 成 `{error}`），所以这里不会报网络错，而是 `boot()` 直接 reject，`store.ready` 永不为 true，**首页渲染成空壳**。

而领域是留下来的功能在用的，不能一起删：

| 位置 | 用途 |
|---|---|
| `ProjectsSection.vue:73-77` | 领域筛选 chips |
| `ProjectsSection.vue:84` | 发布表单的领域下拉 |
| `ProjectsSection.vue:98-104` | 项目卡主色 + **领域标签** |
| `ProjectDetailPage.vue:12,64` | 详情页主色 + 领域名 |
| `HomePage.vue:54-55` | 首页项目条的色点 |
| `admin/pages/ProjectsReviewPage.vue:31,33,37` | 后台待审项目卡（**这页是保留的**） |
| `DrawerView.vue:47,149,153` | 成员主页兴趣标签 |

**做法**：建 `domains` 表（6 行，migration 种入），加 `GET /api/domains`，把 `store.js` 与 `AdminApp.vue:90-94` 的数据源换过去。**这一步必须早于删除 `galaxyGraph()`。**

## 一、架构

后端不再需要「传输无关」（那是为了同时跑 Node 与 Worker）。取消该约束后可自由使用 Node API 与 npm 依赖。

现有 1050 行单文件 `if` 链缩到约 400 行，且必须拆开——它现在同时承担路由、鉴权、业务、数据访问四件事。

```
app/
  server.js                 HTTP 入口、静态文件、cookie 解析
  db/pool.js                pg Pool，读 DATABASE_URL
  db/migrate.js             顺序执行 migrations/*.sql，记录 schema_migrations
  db/migrations/001_init.sql
  auth/password.js          node:crypto scrypt 哈希/校验
  auth/session.js           签发/查找/吊销/清理过期
  routes/index.js           路由分发 + needsAdmin 守卫（沿用 P0 分级表）
  routes/auth.js            注册/登录/登出/当前用户
  routes/users.js           成员目录/待审/审核
  routes/projects.js        项目 CRUD/审核/成员
  routes/domains.js
  routes/notifications.js
  routes/settings.js
  bin/create-admin.js       建站长账号 CLI
```

**唯一新增运行时依赖是 `pg`。** 密码哈希用 Node 内置 `crypto.scrypt`——argon2/bcrypt 是原生模块，Windows 编译常出问题，而 scrypt 是标准 KDF。

### 从 P0 保留的东西

`needsAdmin(method, seg)` 那张**默认拒绝**的分级表整体保留，只把判断依据从「Bearer 口令是否匹配」换成「会话对应的 `user.role` 是否为 admin」。顺序不变：① 保留动词 → ② 后台显式表 → ③ 公开白名单 → ④ 默认拒绝。

重写后它更值钱：新写的端点若两张表都没登记，匿名访问立刻 401 而非静默公开。`ADMIN_TOKEN` 退役。

## 二、数据库

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE domains (
  id        text PRIMARY KEY,          -- 'agent' / 'edu' / ...
  name      text NOT NULL,
  color     text NOT NULL,
  sort      int  NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id             bigserial PRIMARY KEY,
  username       citext UNIQUE NOT NULL,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  email          citext UNIQUE NOT NULL,
  repo_url       text,
  bio            text,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','suspended')),
  apply_note     text,
  review_note    text,
  reviewed_by    bigint REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,                    -- 32 随机字节 base64url
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

CREATE TABLE projects (
  id           bigserial PRIMARY KEY,
  slug         citext UNIQUE NOT NULL,
  name         text NOT NULL,
  tagline      text,
  description  text,
  repo_url     text,
  domain_id    text REFERENCES domains(id),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected')),
  owner_id     bigint NOT NULL REFERENCES users(id),   -- 「绑到我身上」
  review_note  text,
  reviewed_by  bigint REFERENCES users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (status);
CREATE INDEX ON projects (owner_id);

CREATE TABLE project_members (
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- ← 不再是 persona id
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, read_at);

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
```

migration 只种两样：6 行 `domains`、一行 `settings`（`registration_open = true`）。**不写任何 dummy 数据**，库起来是空的，第一个账号由 `create-admin` 创建。

成员目录不单独建表，是 `users WHERE status='approved'` 的查询。

**slug 生成规则**：由服务端从 `name` 生成——转小写、非字母数字转 `-`、去重复与首尾 `-`；中文名等 slug 化后为空的情况回退为 `p-<id>`；冲突时追加 `-2`、`-3`。slug 一经审核通过不再变更（改名不改 slug，避免外链失效）。

## 三、身份与会话

- **密码**：`crypto.scrypt`，每用户 16 字节独立盐，`N=2^15, r=8, p=1`。存储格式 `scrypt$N$r$p$salt_b64$hash_b64`（便于日后调参不失效），校验用 `timingSafeEqual`。
- **会话**：32 随机字节 → `sessions.id`，写 HttpOnly + SameSite=Lax cookie（生产加 Secure），默认 30 天。存表 = 可吊销，比 JWT 适合本场景。
- **登出**删该行；**改密码**删该用户全部会话；**过期清理**在登录时顺手 `DELETE ... WHERE expires_at < now()`，不引定时任务。
- **待审用户不能登录**：登录时校验 `status='approved'`，否则返回「申请审核中」或「已被拒绝」。pending 用户拿不到会话。

**权限只有两级**：`admin`（站长）与 `member`。前台不再有用户组概念；后台侧栏那个「权限组」下拉删掉——它一直只是显示过滤。

## 四、接口

公开：
```
POST /api/auth/register        注册申请（受 registration_open 约束）
POST /api/auth/login           登录，签发会话 cookie
POST /api/auth/logout
GET  /api/auth/me              当前用户（未登录 → {user:null}）
GET  /api/domains              ← 新增，取代原先搭车 /api/galaxy
GET  /api/stats                {members, projects} 两个 COUNT，给首屏数字用
GET  /api/projects             已上线项目
GET  /api/projects/:slug       项目详情 + 成员
GET  /api/members              已通过成员目录
GET  /api/members/:username    成员主页 + 其项目
GET  /api/settings/public      {registration_open}
```

登录成员：
```
POST  /api/projects                  发起项目 → pending
PATCH /api/projects/:slug            改自己的项目
POST  /api/projects/:slug/members    邀成员加入（owner）
GET   /api/notifications
POST  /api/notifications/read
PATCH /api/me                        改资料/改密码
```

站长（`needsAdmin` 拦截）：
```
GET   /api/admin/users/pending
POST  /api/admin/users/:id/review     approve | reject
POST  /api/admin/users/:id/suspend
GET   /api/admin/projects/pending
POST  /api/admin/projects/:id/review  approve | reject
PATCH /api/admin/settings             改 registration_open
```

## 五、前端

路由 10 → 8：
```
#/  #/projects  #/project/:slug  #/members  #/u/:username  #/login  #/register  #/me
```

后台 17 页 → 4 页：**待审用户、待审项目、成员管理、站点设置**。

`store.js` 的 persona 体系整体移除，换成 `store.user`（来自 `GET /api/auth/me`）。`lib/api.js` 去掉 Bearer 逻辑，改 `credentials: 'same-origin'` 带 cookie。

精确清单见**附录 A**。

## 六、部署

```yaml
services:
  db:
    image: postgres:17-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: pg_isready
  app:
    build: .
    environment: [DATABASE_URL, SESSION_SECURE, PORT]
    depends_on: { db: { condition: service_healthy } }
    ports: ["4870:4870"]
volumes: { pgdata: }
```

启动先跑 migration 再监听。本地与服务器同一套。

**Dockerfile 必须在镜像内构建前端**：`.dockerignore` 排除了 `app/frontend`（源码），而产物 `app/public-dist/` 被 gitignore——现状是"宿主机先 build 才有前端"。改成多阶段构建：node 阶段 `npm ci && vite build`，再 COPY 产物。同时删掉 `.dockerignore:3` 的 `project_src`（该目录本身要删）。

## 七、测试

以前全是 dummy 数据没什么可测；现在有密码哈希、会话过期、审核状态机、权限判定——**这些错了是静默错，不会崩**。

用 Node 内置 `node:test`，不引测试框架。测试库跑独立 schema，每个测试文件事务包裹后回滚。

必测：
- `password.js`：不可逆、同密码两次哈希不同（盐）、错密码不通过
- `session.js`：签发/命中/过期失效/吊销失效
- 登录：`pending`/`rejected`/`suspended` 不得拿到会话
- `needsAdmin()`：逐条断言分级表；**未登记的新路径必须判为后台**（默认拒绝的回归测试）
- 审核状态机：重复审核 409；非法转移被拒
- 项目可见性：`pending` 不出现在公开列表，但 owner 自己能看到
- 越权：member 调所有 `/api/admin/*` 必须 401/403

## 八、分阶段交付

| 阶段 | 内容 | 验收 |
|---|---|---|
| **① 地基** | compose 起 Postgres；migration（含 domains 种子）；`pg` 接入；`password.js`/`session.js` + 测试；`create-admin` CLI | 能建站长账号，密码与会话单测全绿 |
| **② 账号闭环** | 注册/登录/登出/me；用户审核；`needsAdmin` 改接会话 | curl 走完「注册 → 待审不能登录 → 站长通过 → 能登录」 |
| **③ 项目 + 领域** | `GET /api/domains`；项目 CRUD + 审核 + 成员 + 通知 | curl 走完「发起 → 公开面不可见 → 站长通过 → 上线且归属正确」 |
| **④ 前端替换** | 执行附录 A；登录/注册/我的/成员页；后台 4 页 | 浏览器实测两个账号完整动线 |
| **⑤ 部署** | Dockerfile 多阶段构建；服务器 compose；域名切换 | 线上可注册可登录，重启数据不丢 |

① ② ③ 是纯后端，可用 curl 验收；此期间旧前端处于半坏状态，属预期。

## 九、明确不做

邮件发送（找回密码/通知邮件，注册说明里写清由站长线下联系）、第三方登录、头像上传（先用显示名首字生成色块）、全文搜索与分页、应用层速率限制（放 nginx）、二次验证、邮箱验证。

---

# 附录 A：删除 / 改写 / 保留清单

> 已逐个核实引用点。**同一个提交内完成**，否则 Vite 的 import 分析会直接失败。

## A1. 整目录删除

| 路径 | 说明 |
|---|---|
| `worker/` | Cloudflare 入口 |
| `wrangler.jsonc` | |
| `app/data/seed.js`、`app/data/network.js` | 全部 dummy 数据 |
| `project_src/` | 经核实是项目改名前的 **React 19 预编译原型**（`app.js` 是 450KB 打包产物，非源码），初始提交后从未改动，全库无任何引用 |

## A2. 前端删除（35 个文件：1 lib + 1 组件 + 2 页 + 17 section + 14 后台页）

**`lib/`**：`galaxy.js`（唯一引用点 `HeroSection.vue:7`）

**`components/`**：`MatchCard.vue`（4 个引用点全部随之删除）

**`portal/pages/`**：`AboutPage.vue`（6 个子组件全删）、`PeoplePage.vue`（两个子组件全删，成员目录页是新写的）

**`portal/sections/`（17 个）**：`AcademySection` `BriefsSection` `CoursesSection` `GateSection` `GatheringsSection` `HighlightsSection` `OverviewSection` `PeopleSection` `PermissionsSection` `PersonaBar` `PolarisSection` `PresenterPanel` `ResourcesSection` `TalentSection` `TopicForm` `VisionSection` `WorkbenchDrawer`

> `PresenterPanel` 是**删除**不是改写——它整个是 persona 演示脚本，且是 `qrcode-generator` 的唯一消费者，该依赖可从 `app/frontend/package.json` 移除。

**`admin/pages/`（14 个）**：`DashPage` `GatePage` `CuratorPage` `SynergyPage` `BoardPage` `BriefsAdminPage` `ScoutsAdminPage` `GatheringsAdminPage` `AcademyAdminPage` `ResourcesAdminPage` `RiskPage` `CoursesAdminPage` `OrgReviewPage` `DirectoryPage`

> `DirectoryPage` 通体是导师/机构/学院，成员管理页是新文件。
> ⚠️ `AdminApp.vue:178` 的 `:is="PAGES[page] || DashPage"` 兜底指向 `DashPage`，必须改指向。

## A3. 保留但改写

| 文件 | 保留 | 删除 |
|---|---|---|
| `portal/PortalApp.vue` | 外壳/导航/移动端抽屉/样式、`Icon`、`router`、`initCursorLight`、Esc、`JoinModal` | 8 个已删组件的 import 与 `PAGES` 项、`NAV` 中 4 行、页脚指向已删页的链接 |
| `portal/store.js` | `projects/ready/drawer/joinOpen`、`boot()`、`openMember`、`openProject`、项目动作、`closeDrawer`、`openJoin/closeJoin`、`actPublishProject` | persona 全套、`PERM`/`can`/`userGroup`/`GROUP_LABEL`、`galaxyCtl`/`netExpanded`、已删模块的 state 与 boot 请求 |
| `portal/pages/HomePage.vue` | 项目条 + 外壳样式 | 其余 5 条聚合条、`store.homeConfig` 依赖、`/resources` 请求 |
| `portal/sections/HeroSection.vue` | `.hero-copy` 文案块 | `GalaxyView` import、canvas 生命周期、tooltip Teleport、`/events` 跑马灯、新闻轮播、`ROLE_COPY` |
| `portal/sections/DrawerView.vue` | **仅 `member` 分支**（成员主页） | topic/mentor/enterprise/project/gathering/column 六个分支、`MatchCard`、RSVP |
| `portal/sections/IdentityRibbon.vue` | **通知铃铛与面板**（本文件是通知的唯一载体） | persona 身份条、`ROLE` 映射、快捷入口、退出按钮 |
| `portal/sections/ProjectsSection.vue` | 几乎全部 | `founderId: store.persona.ref` → 改真实登录用户 |
| `portal/pages/ProjectsPage.vue` | | 去掉 `BriefsSection` |
| `portal/pages/ProjectDetailPage.vue` | 主体 | 「当前需求」候选人 chips（撮合产物） |
| `portal/sections/JoinModal.vue` | 表单外壳与提交流程 | **字段要换**：加用户名/密码，去真名/联系方式/年龄/学校（决策 5） |
| `admin/AdminApp.vue` | 登录卡、`shared` provide、侧栏外壳、时钟、登出 | 14 个已删页 import、`MODULES`、`ROLES`/`canSee`/`setRole`、`reset()`、`refreshBadges` 里 8 个已删端点 |
| `admin/pages/HomeConfigPage.vue` | 首屏文案覆盖 → **改成「站点设置」页**（注册开关） | 5 个已删模块的推荐位与请求 |
| `lib/router.js` | 全部逻辑 | 只改 `ROUTES` 数组 |
| `lib/api.js` | `api`/`post`/`toast`/`initCursorLight`/`vReveal` | Bearer 逻辑改 cookie；`countUp`/`tzLabel`/`STAGE` 变成死代码 |
| `styles/global.css` | — | 约 270/932 行可删（银河 HUD、跑马灯、Polaris、Gate、Curator、Synergy、直播模式、演示模式、氛围模式、二维码浮层）。**注意 465–474 的 `.form-field` 在 Gate 区块里但被 JoinModal/ProjectsSection/设置页使用，不能连坐删除** |

## A4. 三个会静默出错的点（不报构建错，只在运行时坏）

1. **`store.js:94`** — 保留的 `openMember()` 内部调 `focusConstellation()`，后者调 `galaxyCtl.focus()`。不清理则点成员必抛。
2. **`store.js:133`** — 保留的 `closeDrawer()` 内部调 `store.galaxyCtl.focus(null)`。同上。
3. **`IdentityRibbon.vue:16`** — `api('/notifications/' + store.persona.id)`，后端按 **persona id** 过滤。通知表改按 `user_id` 后，前后端要同时改键，否则通知永远为空。

## A5. 顺带清理

- 根 `package.json`：删 `dev:worker`、`deploy` 两个 wrangler 脚本
- `app/frontend/package.json`：删 `qrcode-generator`
- `.dockerignore`：删 `project_src` 那行
- `Icon.vue`：`gate` `compass` `shield` `scale` `clock` `eye` 六个图标变成孤儿（`v-html` 兜底为空，不会崩，属清理）
- `index.html` 启动占位背景是 `#04060f`（深色），浅色主题下会闪一下深色——顺手改掉
- 文档中的 wrangler 引用：`README.md`、`docs/DEPLOY.md`、`docs/API.md`、`docs/ARCHITECTURE.md`

---

# 附录 B：验证

```bash
docker compose up -d db
npm run migrate
npm run create-admin      # 交互式建站长
npm test                  # node:test
npm start                 # http://localhost:4870
```

阶段 ②③ 用 curl 验收：

```bash
curl -X POST .../api/auth/register -d '{...}'    # → pending
curl -X POST .../api/auth/login    -d '{...}'    # → 403 审核中
# 站长登录后 approve，再登录 → 200 + Set-Cookie
curl -b cookie.txt -X POST .../api/projects      # → pending
curl .../api/projects | grep -c 新项目            # → 0（未审核不可见）
```

前端改动一律用 `browser-eyes` skill 在真实浏览器里看过再算完成（CLAUDE.md 要求）。

---

**状态**：已批准（2026-08-17）。下一步进入实现计划。

**分支**：本 spec 提交在 `pg-rewrite`，基于 `p0-admin-auth`（`465b79d`）。
P0 的鉴权分级表是本次重写要复用的，所以直接叠在它上面；`p0-admin-auth` 至今未推送到 origin，
若要先合进 master 再继续，现在是最后的干净时机。
