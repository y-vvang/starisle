<div align="center">

# ✦ 星屿 Starisle

### AI · Youth · Community

**面向 AI 青少年的项目协作社区:注册审核、发起项目、审核上线**

[![Backend](https://img.shields.io/badge/backend-Node%20%2B%20PostgreSQL-339933?style=flat-square)](#-技术栈)
[![Frontend](https://img.shields.io/badge/frontend-Vue%203%20%2B%20Vite-42b883?style=flat-square)](https://vuejs.org/)
[![Tests](https://img.shields.io/badge/tests-116%20passing-4ade80?style=flat-square)](#-技术栈)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square)](docs/DEPLOY.md)

</div>

---

## ✦ 这是什么

**星屿 Starisle** 是一个青少年 AI 开发者社区平台:真实账号注册,站长人工审核通过后才能登录;登录用户可以发起项目,项目同样经站长审核后才对外公开。

**这不是一份带着一大堆演示身份的可交互 demo。** 早期版本(还在 git 历史里,不在这份 README 描述范围)确实是那样的:内存数据库、多角色一键切换、部署在 Cloudflare Worker 上。那一版已经被整体重写替换掉了——数据库换成了 PostgreSQL,账号系统换成了真实的注册/审核/登录,后端从 Cloudflare Worker 迁回自己 Docker 部署的 Node 服务器。当前实现只覆盖两条主线:

- **账号**:注册 → 站长审核 → 登录(scrypt 密码哈希,服务端会话存在数据库里,HttpOnly cookie)。编辑资料/改密码(`PATCH /api/me`,改密码要过旧密码校验、改完吊销该账号全部会话)这一条后端有、前端还没做入口。
- **课程**:站长建课、编排课纲、发布;成员申请学习,站长逐条开通。课纲对匿名可见,**课件不在当前范围**(需要对象存储与鉴权下载)。
- **导师**:导师是被展示的数据,不是能登录的主体。少年提交指导申请 → 站长审核 → 站长按导师邮箱在**站外**联系 → 回来标记「已对接」。**平台不把导师联系方式给少年**,申请表也只有四个字段(想做的方向、已有基础、想问的问题、每周投入时间)—— 不收姓名、学校、联系方式。
- **项目**:登录用户发起 → 站长审核 → 公开列表可见;项目详情页接了关注、加入申请、路演海报上传/移除,以及 owner/站长可见的加入申请队列(通过/拒绝)。发起人(或站长)可以在 `#/project/:slug/edit` 编辑项目 —— 除基本信息外,还包括详情页 02/03/04 三张卡的内容:主要工作、技术栈、阶段性成果、当前需求。发起人直接拉人入伙(`POST /api/projects/:slug/members`)这一条后端有、前端还没做入口,详见 [`docs/MODULES.md`](docs/MODULES.md)。

没有邮件发送、没有密码找回、没有速率限制、没有头像上传 —— 这些都还没做,不要在别处的文案里暗示已经有了。

> **当前没有可访问的线上地址。** 旧版部署在 `https://starisle.demo.muran.tech`(Cloudflare Worker)的那份 demo **还在跑**,但它是重写之前的旧代码,跟这份仓库描述的实现无关——见 [`docs/DEPLOY.md`](docs/DEPLOY.md) 最后一节"旧的 Cloudflare 部署该怎么办"。新版本部署到位之前,不要把那个 URL 当作"当前系统"的入口贴出去。

<br/>

## ✦ 架构

平台是**有状态**的应用:注册、审核、发起项目、加入项目、关注都会真实改变数据库里的数据。**只有一种运行方式** —— Node 进程 + PostgreSQL,本地这样跑,生产也这样跑(Docker Compose)。没有 Cloudflare、没有 Durable Object、没有"传输无关核心 + 双运行时"这种设计,那一整套连同 `worker/`、`wrangler.jsonc` 已经在重写中删掉了。

```mermaid
flowchart TD
    subgraph Browser["浏览器"]
      Portal["主站 Portal · Vue3<br/>HomePage · ProjectsPage · ProjectDetailPage"]
      Admin["控制台 Admin · Vue3<br/>4 页:待审用户 · 待审项目 · 成员管理 · 站点设置"]
    end

    Server["app/server.js<br/>Node http · 读 cookie/body → 分发 → 写 JSON"]
    Guard["app/auth/guard.js<br/>needsAdmin() · 默认拒绝"]
    Routes["app/routes/*.js<br/>auth · projects · users · notifications · domains · settings"]
    DB[("PostgreSQL<br/>app/db/migrations/*.sql")]

    Portal -->|"/api/*"| Server
    Admin -->|"/api/*"| Server
    Server --> Guard --> Routes --> DB
```

**要点**

- **真账号鉴权** —— 注册需站长审核;登录签发服务端会话,`HttpOnly` cookie 承载会话 id,不是自述的角色参数。
- **路由守卫默认拒绝** —— 未登记进公开白名单的 `/api/*` 路径,匿名访问直接 401,不是悄悄放行;白名单里的 `:param` 是通配符,少数形状撞上白名单规则的路径是已知例外,见 [`docs/API.md`](docs/API.md)。
- **持久化** —— 数据在 PostgreSQL 里,容器重启、进程重启都不丢。

详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

<br/>

## ✦ 功能

| 领域 | 主站 | 控制台(站长专属) |
|---|---|---|
| **账号** | 注册申请、登录/退出、站内通知(顶栏铃铛) | 待审用户列表、通过/拒绝、停用账号 |
| **项目** | 浏览已上线项目、项目详情、发起项目、编辑项目(owner/站长)、关注、申请加入、路演海报上传(owner/站长) | 待审项目列表、通过/驳回 |
| **课程** | 浏览课程与完整课纲(匿名可看)、申请学习、我的课程 | 建课、编排课节、发布/下架、审学习申请 |
| **导师** | 浏览导师与合作机构、申请指导(只填四个非 PII 字段)、撤回申请 | 审申请、按导师邮箱在站外对接、标记已对接 |
| **成员** | 成员主页(抽屉,从项目详情页的项目成员列表点开) | 成员管理(停用) |
| **站点** | 注册入口随后台开关显隐 | 开关注册入口 |

控制台**没有权限组** —— 登录用户要么是站长(`role='admin'`,能进全部四页),要么不是(直接被拦在登录页之后,看不到任何审核页面)。完整端点表见 [`docs/API.md`](docs/API.md),前端页面细节见 [`docs/MODULES.md`](docs/MODULES.md)。

成员目录(`GET /api/members`)和个人主页路由 `#/u/:username` 是后端/路由表里有、前端还没做页面的:`app/frontend/src/lib/router.js` 登记了 `members`/`u` 两个 route,但 `PortalApp.vue` 的页面表没映射它们,访问会静默回落首页;`store.members` 现在拉了,却没有任何组件渲染。

<br/>

## ✦ 快速开始(本地,不用 Docker)

```bash
# 0) 起一个本地 PostgreSQL(装好 Docker 的话最简单是这样;也可以用任何已有的 Postgres)
docker run -d --name starisle-db-local -e POSTGRES_DB=starisle -e POSTGRES_USER=starisle \
  -e POSTGRES_PASSWORD=devpass -p 5432:5432 postgres:17-alpine

# 1) 装依赖 + 建库结构
npm install
cp .env.example .env
# 后端自己不读 .env(生产依赖只有 pg,没有 dotenv;.env 只有 docker compose 会自动读),
# 本地跑要先把里面的变量导进当前 shell:
set -a && . ./.env && set +a
#   Windows PowerShell:$env:DATABASE_URL="postgres://starisle:devpass@localhost:5432/starisle"
npm run migrate

# 2) 建一个站长账号(交互式问答;也可以用环境变量非交互式,见 docs/DEPLOY.md)
npm run create-admin

# 3) 构建前端(Vue3 + Vite → app/public-dist)
cd app/frontend && npm install && npm run build && cd ../..

# 4) 起后端(默认端口 4870)
npm start
#  → 主站 http://localhost:4870/  ·  控制台 http://localhost:4870/admin.html
```

第 2、4 步要和第 1 步在同一个 shell 里跑 —— `app/db/pool.js` 直接读进程环境变量里的 `DATABASE_URL`,换个终端就得重新导出。

开发前端时可 `cd app/frontend && npm run dev`(Vite 热更)。跑测试前要先单独建一个测试库并对它跑一次迁移(上面第 0 步只建了 `starisle`):

```bash
docker exec starisle-db-local createdb -U starisle starisle_test
DATABASE_URL=postgres://starisle:devpass@localhost:5432/starisle_test npm run migrate
#   Windows PowerShell(没有内联环境变量前缀,要分两句):
#   $env:DATABASE_URL="postgres://starisle:devpass@localhost:5432/starisle_test"; npm run migrate
```

之后 `npm test` 即可(116 个测试全在后端)。测试连哪个库由 `TEST_DATABASE_URL` 决定,不设时兜底成上面这个串(见 `test/helpers/db.js`);它同样必须是真正的进程环境变量,写进 `.env` 不会被读到。

<br/>

## ✦ 部署(Docker Compose)

`docker compose up -d` 之前必须先把 compose 要用的变量准备好。最省事的是在仓库根目录建一个 `.env`(已被 `.gitignore` 忽略,不会提交),compose 会自动读它做变量插值 —— 直接 `export` 进当前 shell 也一样生效,二选一即可。至少要有 `DATABASE_URL` —— 它是 compose 里唯一没有默认值的变量,不设的话 app 容器会因为 `app/db/pool.js` 拿不到连接串直接退出,再被 `restart: unless-stopped` 反复拉起:

```dotenv
POSTGRES_PASSWORD=<强密码>        # 不写就是默认的 devpass
DATABASE_URL=postgres://starisle:<和上面同一个密码>@db:5432/starisle
SESSION_SECURE=1                  # 生产必须设,cookie 才带 Secure
```

host 是 compose 服务名 `db` 而不是 `localhost`(`.env.example` 那份是给本地非 Docker 跑的,照抄连不上),密码两处必须一致。**注意这和「快速开始」第 1 步 `cp` 出来的是同一个 `.env` 文件**:那份里的 host 是 `localhost`,直接拿去 `docker compose up` 会让 app 容器连不上库,部署前要把它改成 `db`。

```bash
docker compose up -d
```

**先建 `.env`,否则起不来。** `docker-compose.yml` 里 `POSTGRES_PASSWORD` 和 `DATABASE_URL` 都没有默认值 —— 光敲上面这一条命令、不先在仓库根目录建一个带这两个变量的 `.env`,`docker compose config` 会直接报错拒绝启动(`POSTGRES_PASSWORD` 缺失),就算绕过去了 `app` 容器也会因为拿不到 `DATABASE_URL` 陷入崩溃重启循环。镜像内多阶段构建(装前端依赖 → `npm run build` → 拷进最终镜像),容器启动时自动跑迁移,然后起服务。生产环境还需要额外设 `SESSION_SECURE=1`,以及在前面接一层反向代理做 TLS 和限流(登录/注册接口没有内置速率限制,必须在反代层做,见下方)—— 完整的、逐条命令验证过的运行手册(密钥怎么生成、建站长账号、验证部署、备份、旧 Cloudflare 部署怎么处理)在 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

<br/>

## ✦ 技术栈

- **前端** — Vue 3(`<script setup>`)+ Vite。主站 3 个页面 + 控制台 4 个页面,极简哈希路由,自绘 SVG 图标,无 emoji。浅色主题(非早期版本的深空暗色)。
- **后端** — Node 内建 `http`(零 HTTP 框架依赖),生产依赖只有 `pg`。scrypt 密码哈希 + 服务端会话。
- **数据库** — PostgreSQL 17,两份迁移(`app/db/migrations/`),`npm run migrate` 应用。
- **测试** — `node --test`,116 个测试(密码哈希、会话、路由守卫、slug、账号、项目、项目互动、HTTP 层、建站长 CLI)。
- **部署** — Docker 多阶段构建 + Docker Compose(`app` + `db` 两个服务)。

<br/>

## ✦ 仓库结构

```
starisle/
├─ app/
│  ├─ server.js          # Node HTTP 入口:cookie/body 解析 → handle(ctx) → 写响应
│  ├─ routes/             # auth · domains · settings · projects · users · notifications
│  ├─ auth/                # guard(路由分级)· session · password(scrypt)
│  ├─ db/
│  │  ├─ migrations/     # 001_init.sql · 002_project_interactions.sql
│  │  ├─ migrate.js      # 迁移执行器(幂等)
│  │  └─ pool.js         # pg 连接池 + 事务助手
│  ├─ bin/create-admin.js # 建站长账号(交互式 / 环境变量非交互式)
│  ├─ lib/slug.js         # 项目 slug 生成(避开保留动词)
│  ├─ frontend/           # Vue3 + Vite 源码(portal + admin)
│  └─ public-dist/        # 前端构建产物(gitignored,由 npm run build 生成)
├─ test/                  # node --test,116 个测试
├─ Dockerfile             # 多阶段:装前端依赖构建 → 拷进最终镜像
├─ docker-compose.yml     # app + db 两个服务
└─ docs/                  # 架构 / 模块 / API / 数据模型 / 部署
```

`web/`、`demo/` 是重写过程中留下的辅助材料(手写的单页 API 走查工具、一段可重复运行的后端演示脚本),不是应用本身的一部分,不在上面这份结构图里展开。

<br/>

## ✦ 文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 分层、请求流、鉴权与会话、数据访问、前端、Docker、测试 |
| [`docs/MODULES.md`](docs/MODULES.md) | 主站页面、控制台页面、项目详情页的关注/加入/海报交互、仍缺前端入口的能力 |
| [`docs/API.md`](docs/API.md) | 全部 `/api/*` 端点、鉴权分级、保留动词、未实现功能清单 |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | 逐字段抄自迁移文件的表结构,以及隐私说明 |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Docker Compose 运行手册:密钥、首次启动、验证、备份、旧部署处理 |

<br/>

---

<div align="center">
<sub>建设主体:少年学院 · 内部原型,私有仓库</sub>
</div>
