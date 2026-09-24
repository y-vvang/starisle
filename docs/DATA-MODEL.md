# 数据模型 · Data Model

星屿的状态是 **PostgreSQL**,没有内存态,没有种子数据生成器。全部结构由五份迁移文件定义,`npm run migrate`(即 `node app/db/migrate.ts`)按文件名顺序应用,并把已应用的文件名记进 `schema_migrations` 表(幂等,重复跑会跳过已应用的文件)。

- `001_init.sql` —— 建站所需的全部表:领域、用户、会话、项目、项目成员、通知、设置。
- `002_project_interactions.sql` —— 项目互动:海报字段、关注、加入申请。
- `003_project_content.sql` —— 项目详情页 02/03/04 三块内容字段。
- `004_courses.sql` —— 课程中心:课程、课节、学习申请。
- `005_mentors.sql` —— 导师目录、指导申请、合作机构。

本文档逐字段抄自这些迁移的当前内容(2026-08),**不做任何推测性补全** —— 上一版文档在没有源码可核对的情况下手写了字段名,结果错了十几处;这一版每个字段都能在下面链接的 SQL 里找到对应行。

---

## `domains` —— 项目领域

```sql
id     text PRIMARY KEY   -- 'agent' / 'edu' / 'climate' / 'health' / 'creative' / 'infra'
name   text NOT NULL
color  text NOT NULL
sort   int  NOT NULL DEFAULT 0
```

迁移里预置了 6 条(agent / edu / climate / health / creative / infra),`GET /api/domains` 按 `sort` 排序返回。项目通过 `projects.domain_id` 外键引用,允许为空(未分类)。

## `users` —— 账号

```sql
id             bigserial PRIMARY KEY
username       citext UNIQUE NOT NULL      -- 大小写不敏感;登录名
password_hash  text NOT NULL               -- scrypt$N$r$p$salt$hash,见下方“密码哈希”
display_name   text NOT NULL
email          citext UNIQUE NOT NULL      -- 大小写不敏感
repo_url       text
bio            text
role           text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'))
status         text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected','suspended'))
apply_note     text        -- 注册时的申请说明
review_note    text        -- 审核备注
reviewed_by    bigint REFERENCES users(id)
reviewed_at    timestamptz
created_at     timestamptz NOT NULL DEFAULT now()
updated_at     timestamptz NOT NULL DEFAULT now()
```

- `role` 只有两档:`admin`(站长,当前实现里就是"全站唯一后台身份")与 `member`。没有中间权限组、没有"内容运营/资源运营"这类分组 —— 旧文档写的按模块分权限组的控制台已经不存在。
- `status` 是账号生命周期:`pending`(注册后待审)→ `approved`(可登录)或 `rejected`;`approved` 之后还能被站长打成 `suspended`(停用,见 `POST /api/admin/users/:id/suspend`)。
- 站长账号本身也是 `users` 表里的一行(`role='admin', status='approved'`),由 `app/bin/create-admin.ts` 直接写入,不走注册审核流程。
- 没有 `age`/`school`/`contact`/`real_name` 等字段 —— 旧的"未成年人 PII"模型不存在了;当前算敏感信息的字段是 `email` 与用户自填的 `apply_note`(后者是自由文本,用户可能把个人信息写进去,且会随 `GET /api/admin/users/pending` 一并返回给站长;见 `docs/API.md` 的鉴权一节与本文档末尾的隐私说明)。

## `sessions` —— 服务端会话

```sql
id          text PRIMARY KEY       -- 32 随机字节,base64url 编码
user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
expires_at  timestamptz NOT NULL
user_agent  text
ip          inet
created_at  timestamptz NOT NULL DEFAULT now()
```

登录成功后签发一行,30 天有效期(登录时由 `app/routes/auth.ts` 的 `DAYS` 显式传入,cookie 的 `Max-Age` 也由它算;`app/auth/session.ts` 的 `DEFAULT_DAYS` 只是不传 `days` 时的默认值,当前同为 30 —— 要改会话时长得两处一起改)。session id 经 `HttpOnly` cookie(`starisle_sid`)下发,`SESSION_SECURE=1` 时该 cookie 再加 `Secure` 标记。`user_id` 上有索引,`expires_at` 上也有索引(供过期清理用)。用户被删除时会话级联删除;改密码或登出会显式吊销。

## `projects` —— 项目

```sql
id           bigserial PRIMARY KEY
slug         citext UNIQUE NOT NULL   -- URL 友好标识,创建后不再变更
name         text NOT NULL
tagline      text
description  text
repo_url     text
domain_id    text REFERENCES domains(id)
status       text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','approved','rejected'))
owner_id     bigint NOT NULL REFERENCES users(id)
review_note  text
reviewed_by  bigint REFERENCES users(id)
reviewed_at  timestamptz
created_at   timestamptz NOT NULL DEFAULT now()
updated_at   timestamptz NOT NULL DEFAULT now()
-- 002 迁移追加:
poster       text     -- base64 data URI(PNG/JPEG/WebP/GIF),最长 700,000 字符;NULL = 无海报
-- 003 迁移追加:详情页 02/03/04 三张卡的内容
work         text                        -- 02 主要工作,一段自由文本;NULL = 没写过
stack        jsonb NOT NULL DEFAULT '[]' -- 技术栈,字符串数组,渲染成详情页的小标签
milestones   jsonb NOT NULL DEFAULT '[]' -- 03 阶段性成果,字符串数组
gaps         jsonb NOT NULL DEFAULT '[]' -- 04 当前需求,元素是 {skill, note}
```

**为什么后三列是 `jsonb` 而不是 `text[]`:** `gaps` 的元素是对象(详情页要渲染「缺一名『前端』· 会 Vue 优先」),`text[]` 装不下;三列统一成 `jsonb` 后读写只有一套取值方式,不必在应用层分流。`NOT NULL DEFAULT '[]'` 让"没填"在读取端就是空数组,前端不需要再兜底 `null`。

条目数与长度的上限卡在应用层(`app/routes/projects.ts` 的 `parseStringList` / `parseGaps`),不在 CHECK 约束里 —— jsonb 的长度约束写成 SQL 既难读,报错也没法告诉用户"最多 20 条"。当前上限:列表各 20 条、单条 200 字、`work` 4000 字、`skill` 50 字、`note` 200 字。类型不对(传字符串、元素混进数字、`gaps` 元素不是对象或缺 `skill`)一律 400,不静默吞掉。

**一个会误导人的细节:jsonb 不保留对象的键顺序。** 存进去的 `{"skill":…,"note":…}` 读回来是 `{"note":…,"skill":…}` —— Postgres 会按自己的规则规范化。内容一字不差,但如果你写测试用 `JSON.stringify` 比两个对象,会拿键顺序的差异当成数据被改坏(压力测试里就踩过一次)。按属性名访问不受影响。

`(status)` 与 `(owner_id)` 各有索引。`slug` 由 `app/lib/slug.ts#uniqueSlug()` 在创建时生成:先转写(非字母数字一律转连字符、截断到 48 字符);转写结果为空时(例如纯中文项目名)直接拿随机的 `p-<hex>` 当基名;基名若命中路由守卫的保留动词(`review`/`decide`/`grant`/`clear`/`pending`/`suspend`)或已被占用,则从 `-2` 起追加序号逐个试,一路试到上限仍冲突才退成 `<base>-<hex>`。项目创建后 slug 不再变更(改名不改 slug,避免外链失效)。

新建项目一律 `status='pending'`,不在公开列表 `GET /api/projects` 里出现,直到 `POST /api/admin/projects/:id/review` 通过。owner 与站长可以在未过审状态下看到该项目详情(其余人一律 404,详见 `docs/API.md`)。

## `project_members` —— 项目成员

```sql
project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE
user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member'))
joined_at   timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (project_id, user_id)
```

复合主键即成员关系表,同一用户不可能在同一项目里出现两行。项目创建时,发起人被同一事务写入一行 `role='owner'`。owner 可以用 `POST /api/projects/:slug/members` 直接把已审核通过的用户拉进项目(不经过加入申请流程);加入申请被接受时也会插入一行 `role='member'`(`ON CONFLICT DO NOTHING`,防止竞态下重复插入报错)。

## `project_follows` —— 关注(002 迁移新增)

```sql
project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE
user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
created_at  timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (project_id, user_id)
```

复合主键保证同一用户重复关注同一项目在数据库层面只留一行(不是应用层"先查后插"去重)。`(user_id)` 上另有索引。取消关注是直接 `DELETE` 那一行,不是软删除。

## `project_join_requests` —— 加入申请(002 迁移新增)

```sql
id          bigserial PRIMARY KEY
project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE
user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
message     text
status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected'))
decided_by  bigint REFERENCES users(id)
decided_at  timestamptz
created_at  timestamptz NOT NULL DEFAULT now()
```

`(project_id)`、`(user_id)` 各有索引。此外有一条**部分唯一索引**:

```sql
CREATE UNIQUE INDEX project_join_requests_pending_uniq
  ON project_join_requests (project_id, user_id) WHERE status = 'pending';
```

它只约束"待处理"状态:同一用户对同一项目最多同时存在一条 `pending` 申请,但被拒绝后可以重新提交(旧申请留档为 `rejected`,不占用这条唯一约束)。普通的 `(project_id, user_id)` 唯一约束做不到"允许历史记录、只挡当前重复",所以特意用了部分索引。应用层在 `INSERT` 前会先查一遍是否已有 `pending` 申请,数据库这条索引是并发下的兜底(见 `app/routes/projects.ts` 里对 Postgres 错误码 `23505` 的捕获)。

## `notifications` —— 站内通知

```sql
id          bigserial PRIMARY KEY
user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE
kind        text NOT NULL         -- 'account' | 'project'
title       text NOT NULL
body        text
read_at     timestamptz
created_at  timestamptz NOT NULL DEFAULT now()
```

`(user_id, read_at)` 上有复合索引。由 `app/routes/notifications.ts#notify()` 写入,触发点:账号审核结果、项目审核结果、被加入项目、项目收到加入申请、加入申请被处理。没有推送/邮件通道,纯站内、由客户端主动拉取(`GET /api/notifications`,最多取 50 条;主站前端只在顶栏铃铛组件创建时和登录用户变化时各拉一次,不做轮询)。

## `settings` —— 站点开关

```sql
key    text PRIMARY KEY
value  jsonb NOT NULL
```

只有一个 key 被使用:`registration_open`(布尔,默认 `true`)。`GET /api/settings/public` 公开只读;`PATCH /api/admin/settings` 站长可写。这是一张通用 key-value 表,未来加开关不需要新迁移。

---

## 密码哈希

`password_hash` 存成自定义格式字符串:

```
scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
```

参数取 OWASP scrypt 指引:`N=2^16=65536, r=8, p=2`,`KEYLEN=32`,`maxmem=128MB`(见 `app/auth/password.ts`)。验证时用 `timingSafeEqual` 比对派生结果;登录接口对"用户名不存在"的情况也会跑一次等代价的哈希(`DUMMY_HASH`),避免响应时间侧信道泄露账号是否存在。

## 关于隐私

**这个数据库存的是真实用户数据,不是种子/演示数据。** `users` 表里的 `email` 是用户注册时提交的真实邮箱地址,`apply_note` 可能包含用户自愿写的个人信息。没有任何脱敏机制 —— 旧文档里"电话/邮箱/微信/地址/机构/校名/真实姓名→星名"那一整套脱敏引擎(`sanitize()`)随旧后端一起被删除了,当前系统不做脱敏,只做访问控制:

- `email` 会出现在三个响应里:`POST /api/auth/login` 成功响应与 `GET /api/auth/me`(两者都用 `app/routes/auth.ts` 的 `publicUser()` 序列化,给出的只是请求者自己的邮箱 —— 登录端点本身匿名可达,但只有密码校验通过才会吐出该账号的邮箱),以及站长的待审列表 `GET /api/admin/users/pending`(它除 `email` 外还会一并返回 `apply_note`)。待审列表由路由守卫兜底:`/api/admin/*` 一律判后台,默认拒绝匿名访问。
- 面向他人的成员数据走 `app/routes/users.ts` 的 `card()` 白名单序列化,不含 `email`,所以 `GET /api/members` 与 `GET /api/members/:username` 不会泄露邮箱。
- 备份、日志、任何导出操作都要把这当成含 PII 的真实用户数据对待。见 `docs/DEPLOY.md` 的备份一节。

## 与实际实现的已知偏差

表结构本身与迁移文件逐字段核对过,没有发现不一致。类型上有一条值得单独写出来:

**bigint 在源头就被转成了 JS number。** pg 驱动默认把 `bigint`/`int8`(OID 20)读成**字符串**——怕数值超出 `Number.MAX_SAFE_INTEGER` 丢精度。但这个库里所有 bigint 都是自增主键,数值远小于该上限,所以 `app/db/pool.ts` 显式注册了 `require('pg').types.setTypeParser(20, Number)`:每一条从 pg 出来的 bigint 天生就是 number,API 响应 JSON 里的 `id` 也都是数字。

这是一次**收口**,值得知道它的来历:早先只在入口修了一半——`app/auth/session.ts#getSession()` 把 `user_id` 转成 Number,让 `ctx.user.id` 是数字;而出口(`app/routes/auth.ts` 的 `publicUser()`、`app/routes/users.ts` 的 `card()`)直接透传数据库行,仍在吐字符串。于是同一个 id 在服务端内部是数字、发给客户端是字符串,两套约定并存,每加一个新端点就得记得在比较处手工转一次。改到 `pool.ts`(原 pool.js)之后入口出口只需修这一处。

计数字段另有保障:基本都在 SQL 侧 `::int` 强转(`app/routes/projects.ts` 的 `COUNT(*)::int`、`app/routes/domains.ts` 的 `count(*)::int`),所以 `followers` 和 `GET /api/stats` 的 `members`/`projects` 是真数字。一个例外是 `GET /api/notifications` 的 `unread`,它在 JS 里 `r.rows.filter(n => !n.read_at).length` 算(`app/routes/notifications.ts`),同样是数字,只是不由这条规则保证。

两处容易误读的地方:`app/routes/projects.ts` 里各处 owner 判断仍保留着两边 `Number(...)` 再比的写法,在类型统一之后它是冗余的,但无害;`domains.id` **不是** bigint 而是 text(`'agent'`/`'robotics'` 这类字面量),它本来就是字符串,不受上面这条影响。

如果之后加了新迁移,先更新这里的表结构,再更新 `docs/API.md` 的端点说明。

---

## 课程中心(004 迁移)

`courses` / `course_lessons` / `course_enrollments` 三张表。

- `courses.status` 合并了上游的 `review` + `status` 两列 —— 那两列永远同步移动,分开只会造出 `(review='rejected', status='published')` 这种不可能状态。取值 `draft`/`pending`/`published`/`archived`,只有 `published` 进公开列表。
- `course_lessons` 刻意**不加** `UNIQUE (course_id, position)`:重排要整段挪,普通唯一约束会在事务中途撞车。配套地重排端点做成"一次提交完整顺序",服务端在一个事务里整体重写 `position`。另有 `CHECK (position > 0)` —— 所以也不能用"先挪到负数区"那种两段式。
- `course_enrollments` 上是**一条**覆盖两种状态的部分唯一索引:`WHERE status IN ('pending','approved')`。最初写成 pending / approved 各一条,两条之间有缝:申请通过后原行变 `approved`,管 pending 的那条不再挡它,新插入的又是 pending、不违反管 approved 的那条 —— 已经在学的人可以无限重复申请。这是压力测试打出来的,单元测试当时只覆盖了"pending 状态下重复申请"。
- **没有建 `course_assets`**:课件那条线上游自己没跑通(asset 的 url 指向不存在的文件,唯一带 asset 的课启动即被归档),且需要对象存储与鉴权下载。将来要做时它是独立一张表 + 一个鉴权下载端点,**不能**把文件丢进 `public-dist`。

## 导师与合作机构(005 迁移)

`mentors` / `mentor_courses` / `mentor_requests` / `partner_orgs` 四张表。

**`mentor_requests` 刻意没有的列:`real_name`、`contact`、`school`、`grade`、`age`。** 申请人是谁完全由 `user_id` 外键解析;站长要联系申请人就用 `users.email`(已有的、已受访问控制的那个)。上游那版把这些 PII 收进表、在后台明文展示、还支持一键导出 TXT 到站长本机 —— 与本项目「不收未成年人敏感信息」的约束直接冲突,没有移植。结果是这个模块**不引入任何新的 PII 类别**。

- `mentors.contact_email` 是成年人的工作邮箱,**只对站长可见**。序列化白名单写在 `app/routes/mentors.ts` 的 `publicMentor()` **一处**,不是每个端点各剥各的 —— 上游正是逐端点手剥,在列表和详情剥掉了,却在申请列表端点漏了回来。
- `mentor_courses.total_hours` 这个列名值得说明:上游对应字段叫 `lessons`,但里面装的是**总课时**(6 个有值的全部精确等于对应课程的 total_hours,没有一个等于课节数)。照原名叫下去会让前端把「24 课时」显示成「24 节课」。
- `mentor_requests` 是四态:`pending → approved/rejected`,`approved → completed`。`completed` 的含义是"站长已在站外把双方对接上",平台不做少年与导师之间的直接通道。
- 部分唯一索引 `WHERE status IN ('pending','approved','completed')` —— 一次覆盖三种"进行中"状态。004 那边最初分成两条留下了缝,同一个坑不踩第二次。
- `partner_orgs.cooperation` 上游 33 条全是空串,留给站长后填;`logo_path` 为 NULL 时前端用 `monogram`(2–3 字简称)兜底。

> 测试库的 `resetDb` 必须显式列出这些表。只写 `users` 的话,靠级联能顺带清掉 `projects`/`courses`(它们有指向 users 的外键),却清不掉 `mentors` 与 `partner_orgs` —— 那两张表会跨用例累积,后面的断言看到的是之前所有用例留下的数据总和。
