# API

所有端点都挂在 `/api/*` 下,由 `app/routes/index.ts#handle(ctx)` 分发到 `app/routes/*.ts` 里的处理函数,返回 `{ status, data }`,`data` 序列化为 JSON。前端同源直连,无 CORS。请求体上限 1MB(`app/server.ts` 的 `BODY_LIMIT`,同时作为 `Bun.serve` 的 `maxRequestBodySize`);带 Content-Length 的超限请求在 HTTP 层被 Bun 直接 413 拒掉(不进 handler),chunked 超限则带着被掐断的 body 进来、按空 body 处理。

约定:
- `body` 为已解析的 JSON 对象;GET 请求不读 body。非纯对象(数组/null)、解析失败、NUL 剥除后仍非法的 body 一律按空对象 `{}` 处理(`stripNul` 先剥 U+0000)。
- 登录态经 `starisle_sid` cookie(`HttpOnly`,`SameSite=Lax`;生产环境 `SESSION_SECURE=1` 时加 `Secure`)。
- 写操作直接改 PostgreSQL,没有全局 `reset` 端点 —— 这不是可复原的演示数据。
- `HEAD`/`OPTIONS` 对 `/api/*` 一律 `405`(不进路由分发,不经过鉴权守卫)。

## 分页(`app/lib/pagination.ts`)

列表类端点统一支持偏移分页:

- 请求参数:`?page=`(默认 1)与 `?per_page=`(默认 20,夹在 [1,100];`notifications` 默认 50)。非法值回退默认,`per_page` 超上限夹到 100 —— 不报错,给一页合理数据。
- 响应:保留原有列表键(`projects`/`courses`/…),新增兄弟键 **`pagination`**:`{ page, per_page, total, total_pages }`。
- **越界页不钳制**:照常查询,返回空列表 + 正确的 total/total_pages(前端据此把页码钳回最后一页)。
- count 与列表同 WHERE(两次独立查询,不包事务;行间漂移对偏移分页可接受)。
- 所有分页查询的 ORDER BY 带**唯一 tiebreaker**(`created_at DESC, id DESC` 这类),同一毫秒创建的相邻行不会跨页重复。

支持分页的端点(响应均带 `pagination`):

```
GET /api/projects                      (+ domain_counts 兄弟键,见下)
GET /api/courses
GET /api/mentors
GET /api/members
GET /api/notifications                 默认 per_page=50(与历史 LIMIT 50 一致)
GET /api/my/courses
GET /api/projects/:slug/join-requests
GET /api/admin/users/pending
GET /api/admin/projects/pending
GET /api/admin/course-enrollments
GET /api/admin/mentor-requests
```

**刻意不分页**(决策记录,不要"顺手补齐"):

| 端点 | 理由 |
|---|---|
| `GET /api/domains` | 六条枚举 |
| `GET /api/stats` | 两个标量 |
| `GET /api/partners` | 机构墙,当前量级有界(33 条种子) |
| `GET /api/my/mentor-requests` | 单用户自己的申请天然有界;且 MentorsPage 的 loadMine 按 mentor slug **全量**建映射给每张卡打状态标,分页必丢 |
| `GET /api/admin/courses` | 站长建课量级有界;且后台编辑表单/课节编排的课程下拉需要全量回填 |
| 详情端点的内嵌列表(项目成员、课纲、`members/:username` 的项目) | 均有界 |

### 列表端点的筛选参数

| 端点 | 参数 | 行为 |
|---|---|---|
| `GET /api/projects` | `?domain=` | 按领域过滤;**未知值 400**(对齐 `?track=` 的严格风格)。响应额外带 `domain_counts`:全库 approved 项目的领域计数,**不受 `?domain=`/分页影响**(前端领域 chip 的渲染凭证 —— 只在当前页里数,数据散到后页时 chip 会消失) |
| `GET /api/courses` | `?track=`、`?q=` | `q` 覆盖 title/subject/summary/instructors 四字段 ILIKE;`%`/`_`/`\` 被 `escapeLike` 转义成字面量,不当代通配符;非法 `track` → 400 |
| `GET /api/mentors` | `?course=` | 按导师课程标题筛选(EXISTS) |
| `GET /api/partners` | `?category=` | 严格三档,非法 400 |
| `GET /api/projects/:slug/join-requests` | `?status=` | **可选过滤,默认仍返回全部状态**(向后兼容;详情页"待处理队列"读法走 `?status=pending`)。白名单是 `pending/accepted/rejected`(**accepted**,课程/导师侧才是 approved);支持逗号分隔多值(`?status=accepted,rejected`);非法值 400 |
| `GET /api/admin/course-enrollments` | `?status=` | 多值(`pending,approved,rejected`),非法 400 |
| `GET /api/admin/mentor-requests` | `?status=` | 多值(`pending/approved/rejected/completed`;后台留痕视图请求 `rejected,completed`),非法 400 |
| `GET /api/admin/courses` | `?status=` | 单值(draft/pending/published/archived) |
| `GET /api/mentor-courses` | 无 | 全部导师课程标题的 distinct 清单(排序:标题字典序)。给导师页筛选下拉;**匿名可达** |

---

## 鉴权:路由分级,默认拒绝

**没有运营口令(`ADMIN_TOKEN`)这回事了。** 鉴权是真实账号 + 服务端会话:注册 → 站长审核 → 登录拿 cookie。路由守卫 `app/auth/guard.ts#needsAdmin(method, seg)` 按顺序判定,任何一步命中就短路:

```
① seg[1] === 'admin'                     → 后台端点(路径任意位置写 /api/admin/... 就一律后台)
② seg 中任意一段命中保留动词表           → 后台端点
③ 命中 PUBLIC_ROUTES 白名单              → 公开(是否需要登录由 handler 自己判断)
④ 以上都没命中                            → 默认拒绝(视为后台端点)
```

第 ④ 步是刻意设计:**新加端点如果忘了登记进白名单、而且它的形状没撞上任何一条白名单规则,匿名访问会立刻拿到响亮的 401,而不是被悄悄放行**(形状碰撞这个已知例外见下面"公开白名单"一节)。判定命中"后台"的请求,如果当前会话不存在或不是 `role='admin'` 的用户,统一返回:

**这条保证有一个例外,写在这里而不是只写在测试文件的注释里:** 第③步的白名单匹配是"方法 + 段数 + 前缀"这种粗粒度匹配,`PUBLIC_ROUTES` 里**通配符段正好是路径最后一段**的规则(目前四条:`GET /api/projects/:slug`、`PATCH /api/projects/:slug`、`GET /api/members/:username`、`GET /api/courses/:slug`)会把任何**形状凑巧撞上**的未来路由也判成公开,不会走到第④步的默认拒绝。比如将来有人写一个 `GET /api/members/export`,它会被 `GET /api/members/:username` 撞上,悄悄变成公开端点,而不是拿到 401。**因此新加端点如果是站长专属的,必须挂在 `/api/admin/` 前缀下**(第①步在通配符匹配之前就会把它判成后台),不要指望"没登记进白名单就默认拒绝"这条保证能替你挡住这几个通配符形状。

`test/guard.test.ts` 最后一条用例把**这类规则的清单本身**钉死了 —— 想加第五条的人会被 CI 拦下,必须在那条测试的注释里写下自己的评估(碰撞面是什么、为什么不用"通配符后再跟一段字面量"的形状、为什么不能不登记),而不是把数组改长了事。课程那条第四规则就是这么加进去的。

- 未登录 → `401 {"error":"需要站长身份","code":"admin_required"}`
- 已登录但不是站长 → `403` 同上 body

### 保留动词(`ADMIN_VERBS`)

```
review · decide · grant · clear · pending · suspend
```

路径的**任意一段**只要等于这 6 个词之一,整条请求一律判成后台端点 —— 不看白名单,不管这个词出现在路径的哪一段。这也是为什么:

- 注册时用户名不能是这 6 个词之一(否则 `GET /api/members/:username` 会被误判成后台路由,永久打不开自己的主页,见 `app/routes/auth.ts`)。
- 项目 slug 生成时会避开这 6 个词(`app/lib/slug.ts` 的 `RESERVED_WORDS`)。
- **`POST /api/join-requests/:id/decision` 不叫 `.../decide`。** 处理加入申请的真实权限规则是"该项目 owner 或站长",不是"仅站长";但 `decide` 是保留动词,一旦端点路径里出现这个词,守卫会不看白名单直接判成"仅站长",把项目 owner 也挡在外面,与这条端点本该有的权限矛盾。为了保住"owner 或站长"这个语义,故意把端点名换成不在保留动词表里的 `decision`,而不是去给 `needsAdmin` 为 `decide` 开特例 —— `test/guard.test.ts` 里 `isAdmin('POST', '/api/anything/decide')` 那条用例钉死了"保留动词即后台,不依赖有人记得改判定逻辑"这个不变量,不应该为单个端点破例。

### 公开白名单(`PUBLIC_ROUTES`)

不需要站长身份的端点(部分仍需要普通登录,由 handler 内部判断,见下表"登录"列):

```
POST /api/auth/register            POST /api/auth/login          POST /api/auth/logout
GET  /api/auth/me
GET  /api/domains                  GET  /api/stats               GET  /api/settings/public
GET  /api/projects                 POST /api/projects
GET  /api/projects/:slug           PATCH /api/projects/:slug
POST /api/projects/:slug/members
POST /api/projects/:slug/poster    DELETE /api/projects/:slug/poster
GET  /api/projects/:slug/follow    POST /api/projects/:slug/follow
POST /api/projects/:slug/join      GET  /api/projects/:slug/join-requests
POST /api/join-requests/:id/decision
GET  /api/members                  GET  /api/members/:username
GET  /api/notifications            POST /api/notifications/read
PATCH /api/me
```

任何不在这张表里、也不匹配 `/api/admin/*` 或保留动词的路径,一律走④默认拒绝 —— 匿名或非站长请求会拿到 401/403,而不是先看到 `unknown api`。

**但白名单不是逐条精确匹配,而是形状匹配。** `matchRoute`(`app/auth/guard.ts`)只比对三样东西:方法、路径段数、以及规则里所有**不以 `:` 开头**的字面段(按位置逐一对应);`:slug`/`:username`/`:id` 这类是不受约束的通配符,能吃下任意一段。所以一条从未登记过的新路径,只要形状撞上某条白名单规则,就会被判成公开而**不会**走④ —— `GET /api/projects/audit` 撞 `GET /api/projects/:slug`,`GET /api/members/impersonate` 撞 `GET /api/members/:username`,`PATCH /api/projects/feature-flags` 撞 `PATCH /api/projects/:slug`。`test/guard.test.ts` 最后一条用例把这三种形状钉死成**已知且刻意接受**的代价(理由见该用例上方"契约④(安全评审确认)"那段注释),不是待修的洞;缓解手段是纪律而不是改 guard:**所有后台专属端点必须挂在 `/api/admin/` 前缀下** —— ①(`seg[1] === 'admin'`)和②(保留动词)都在③的通配符匹配之前 return,通配符碰撞根本没机会发生。

---

## `auth` · 账号(`app/routes/auth.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | 提交注册申请。字段:`username`(3–32 位字母数字下划线连字符,小写化,不能是保留动词)、`password`(≥8 位)、`display_name`(可选,留空就用 `username`)、`email`(格式校验)、`repo_url`(可选)、`apply_note`(≥10 字)。`registration_open=false` 时返回 `403`。成功写入 `status='pending'`,**不签发会话**,需站长审核通过后才能登录 |
| POST | `/api/auth/login` | 否 | `{username, password}`。账号不存在或密码不对 → `401`(两种情况响应时间一致,靠 dummy-hash 抹平侧信道);`pending` → `403`(审核中);`rejected` → `403`;`suspended` → `403`。全部通过则签发 30 天会话,`Set-Cookie: starisle_sid` |
| POST | `/api/auth/logout` | 否 | 有会话则吊销,清 cookie。匿名调用也返回 `200 {ok:true}` |
| GET | `/api/auth/me` | 否 | 未登录返回 `{user:null}`;已登录返回当前用户(含 `email`) |
| PATCH | `/api/me` | 是 | 改 `display_name`/`bio`/`repo_url`(任意子集);或传 `current_password`+`new_password` 改密码(校验旧密码,新密码 ≥8 位,成功后吊销该用户全部会话并要求重新登录) |

## `domains` / `stats` · 只读元数据(`app/routes/domains.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/domains` | 否 | 全部领域(`id,name,color`),按 `sort` 排序 |
| GET | `/api/stats` | 否 | `{members, projects}`:已审核通过的用户数与项目数 |

## `settings` · 站点开关(`app/routes/settings.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/settings/public` | 否 | `{registration_open}` |
| PATCH | `/api/admin/settings` | 站长 | `{registration_open: boolean}`,写入/更新 `settings` 表 |

## `projects` · 项目(`app/routes/projects.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/projects` | 否 | 已过审(`status='approved'`)项目列表 |
| POST | `/api/projects` | 是 | 发起项目:`name`(必填)、`description`(≥20 字)、`tagline`、`repo_url`、`domain_id`(需存在),外加下面「三块内容字段」里的 `work`/`stack`/`milestones`/`gaps`(都可选)。创建为 `status='pending'`,同一事务把发起人写入 `project_members(role='owner')`,不上公开列表 |
| GET | `/api/projects/:slug` | 部分 | 项目详情 + 成员列表。`project` 里含 `description`、`poster`(base64 data URI 或 `null`)、`followers`(关注数)、三块内容字段 `work`/`stack`/`milestones`/`gaps`(见下),已登录时再附带 `following`/`pending_join_request` 两个布尔(都在 `project` 内部,不是顶层键);`members` 是成员列表(`username`/`display_name`/`role`)。**这也是读取海报的唯一接口,没有 `GET .../poster`**。**未过审项目只有 owner 或站长可见,其余人一律 `404`**(不用 `403`,避免向匿名/无关用户泄露"这个项目存在") |
| PATCH | `/api/projects/:slug` | 是(owner/站长) | 改 `name`/`tagline`/`description`/`repo_url`/`domain_id`,以及三块内容字段 `work`/`stack`/`milestones`/`gaps`。非 owner/站长:项目未过审 → `404`(掩护);已过审 → `403`。`slug` 创建后不可改 |
| POST | `/api/projects/:slug/members` | 是(owner) | 按 `username` 把一个**已审核通过**的用户直接拉入项目(`role='member'`),不经过加入申请。同一掩护规则(未过审对非 owner/站长 404) |
| POST | `/api/projects/:slug/poster` | 是(owner/站长) | 上传海报:`poster` 为 `data:image/(png\|jpe?g\|webp\|gif);base64,...`,编码后 ≤ 700,000 字符(约 512KB 原图)。存成 `projects.poster` 的 text 列,**没有对象存储/独立文件服务** |
| DELETE | `/api/projects/:slug/poster` | 是(owner/站长) | 清空海报(`poster=NULL`) |

### 三块内容字段(`work` / `stack` / `milestones` / `gaps`)

对应详情页 02 主要工作、03 阶段性成果、04 当前需求三张卡。`POST /api/projects` 与 `PATCH /api/projects/:slug` 都接受,`GET /api/projects/:slug` 返回;**公开列表 `GET /api/projects` 不返回**,免得列表响应被正文撑大。

```jsonc
{
  "work":       "把 7B 模型量化到能在 4G 内存的红米上跑。",   // 字符串,≤4000 字
  "stack":      ["Vue 3", "Node"],                            // 字符串数组
  "milestones": ["跑通离线推理", "在两所中学试用"],           // 字符串数组
  "gaps":       [{ "skill": "前端", "note": "会 Vue 优先" }]   // 对象数组,note 可为空串
}
```

上限:`stack`/`milestones`/`gaps` 各最多 20 条,单条文本 ≤200 字,`gaps[].skill` ≤50 字、`gaps[].note` ≤200 字。空行会被丢弃(前端是多行文本框按行拆的),但**类型错误一律 400**,不静默吞:`stack` 传字符串、数组元素混进数字、`gaps` 元素不是对象或缺 `skill`,都会拿到一句能照着改的中文错误。

**"没传"和"传空"是两件事**:PATCH 只传 `work` 时另外三块原值不动;显式传 `[]` 才是清空。

---

## 课程中心

课程由站长在控制台创建、编排课节、发布;成员申请学习,站长逐条审批。**没有课件上传** —— 课件涉及对象存储与鉴权下载,不在当前范围,`course_lessons` 只到"课纲"为止。

### 公开 / 成员

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/courses` | 否 | 已发布课程列表,可选 `?track=math\|literacy\|extension\|application`。按 `featured DESC, created_at DESC` 排。带 `lesson_count` |
| GET | `/api/courses/:slug` | 部分 | 课程详情 + 课纲(`lessons`,按 `position` 升序)。**未发布的课只有站长可见,其余人一律 `404`**(同项目详情的掩护规则)。已登录时附 `enrollment`(自己最近一条申请,没申请过为 `null`)—— **只会是自己的,拿不到别人的** |
| POST | `/api/courses/:slug/enroll` | 是 | 申请学习,可选 `message`(≤500 字)。未登录 `401`;课程未发布 `404`;已有待处理申请或已通过 `409`(靠两条部分唯一索引兜底并发,不是"先查后插") |
| GET | `/api/my/courses` | 是 | 自己申请过的课程 + `enrollment_status`。未登录 `401` |

### 站长(全部在 `/api/admin/` 下)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/courses` | 全部课程(含 draft/archived),可选 `?status=`;带 `review_note` |
| POST | `/api/admin/courses` | 建课:`title`(必填)、`track`(必填,四选一)、`subject`/`summary`/`description`/`instructors`/`audience`/`total_hours`/`featured`。slug 由 `uniqueSlug(title,'courses')` 生成,自动避开保留动词 |
| PATCH | `/api/admin/courses/:id` | 改上述字段,以及 `status`(`draft`/`pending`/`published`/`archived`) |
| POST | `/api/admin/courses/:id/review` | `{decision:'approve'\|'reject', note?}`。approve → `published`,reject → `draft` + `review_note` |
| POST | `/api/admin/courses/:id/lessons` | 加课节:`title`(必填)、`summary`、`duration_minutes`(0 = 专题课节,不标时长)。`position` 由服务端取当前最大值 +1 |
| PATCH | `/api/admin/lessons/:id` | 改课节标题/摘要/时长 |
| DELETE | `/api/admin/lessons/:id` | 删课节,**同事务把该课剩余课节的 `position` 重排连续**(否则前端按 position 显示序号会出现 "01 03 04") |
| POST | `/api/admin/courses/:id/lessons/reorder` | `{lesson_ids:[...]}` —— **一次提交完整顺序**,必须恰好是这门课的全部课节,漏一条或混入别的课的课节都 `400`。比上游的"上移/下移一格"幂等、无中间态 |
| GET | `/api/admin/course-enrollments` | 学习申请列表,可选 `?status=`。**不返回申请人邮箱** —— 站长审报名不需要它,目前唯一会吐他人邮箱的接口只有 `GET /api/admin/users/pending`,别让这里变成第二个 |
| POST | `/api/admin/course-enrollments/:id/review` | `{decision}`。非 `pending` 的申请 `409`;处理后给申请人写一条 `kind='course'` 的站内通知 |

被拒之后可以重新申请(旧行以 `rejected` 留档);同一人对同一门课同时只能有一条 `pending`、一条 `approved`。

---

## 导师与合作机构

导师是**被展示的数据,不是能登录的主体** —— 没有导师账号。少年向导师提交指导申请,站长审核后在**站外**联系导师完成对接,平台只记录状态并发通知。**平台不把导师的联系方式给少年**。

**这个模块不收集任何新的个人信息。** 申请表只有四个字段,全是"想做什么"而不是"你是谁";申请人是谁由会话决定,站长要联系人就用注册邮箱。上游那版收真实姓名/学校年级/联系方式并支持一键导出 TXT,与本项目「不收未成年人敏感信息」的约束冲突,没有移植。

### 公开 / 成员

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/mentors` | 否 | 导师列表(仅 `status='active'`),可选 `?course=` 按课程标题筛选。每人带 `courses`(标题/总课时/难度)。**不含 `contact_email`** |
| GET | `/api/mentors/:slug` | 部分 | 导师详情。隐藏的导师只有站长可见,其余人 `404`。已登录时附 `my_request`(自己最近一条申请)。**不含 `contact_email`** |
| POST | `/api/mentors/:slug/requests` | 是 | 申请指导。**只接受四个字段**:`interest`(必填,≤1000)、`background`、`questions`、`weekly_hours`(`<2h`/`2-4h`/`4-6h`/`>6h`)。请求体里的 `real_name`/`contact`/`school`/`user_id` 一律不读。已有进行中的申请 `409` |
| GET | `/api/my/mentor-requests` | 是 | 自己的申请与状态。**不含导师邮箱** |
| POST | `/api/mentor-requests/:id/withdraw` | 是 | 撤回自己的待审申请。不是自己的 `404`(掩护);非 `pending` 的 `409` |
| GET | `/api/partners` | 否 | 合作机构,可选 `?category=中学\|大学\|企业` |

> 撤回写成 `POST .../:id/withdraw` 而不是 `DELETE /api/mentor-requests/:id`,是为了不让通配符落在路径末段 —— 见守卫一节与 `test/guard.test.ts` 的钉桩用例。

### 站长(全部在 `/api/admin/` 下)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/mentors` | 建导师:`name`(必填)、`title`/`org`/`bio`/`contact_email`/`sort`,以及 `courses` 数组(整表写入) |
| PATCH | `/api/admin/mentors/:id` | 改上述字段与 `status`(`active`/`hidden`)。传 `courses` 时**整表替换**(后台是整份表单提交的,增量合并会留下删不掉的旧条目) |
| GET | `/api/admin/mentor-requests` | 申请列表,可选 `?status=`。**这是唯一会返回导师 `contact_email` 的接口** —— 站长靠它在站外联系导师。申请人侧只给 `username`/`display_name`,不 join 邮箱 |
| POST | `/api/admin/mentor-requests/:id/review` | `{decision:'approve'\|'reject', note?}`;非 `pending` 的 `409`;写一条 `kind='mentor'` 通知 |
| POST | `/api/admin/mentor-requests/:id/complete` | 标记为「已对接」。只有 `approved` 的能转,否则 `409`;再发一条通知 |
| POST/PATCH | `/api/admin/partners`(`/:id`) | 机构增改(主要是补 `cooperation`,上游那 33 条全是空的) |

**`contact_email` 的白名单序列化只写在一处**(`publicMentor()`),不是每个端点各剥各的 —— 上游正是因为逐端点手剥,在列表和详情剥掉了,却在申请列表端点又漏了回来。


| GET | `/api/projects/:slug/follow` | 是 | `{following, followers}` |
| POST | `/api/projects/:slug/follow` | 是 | `{follow: boolean}`(缺省视为 `true`)。关注/取消关注,幂等(复合主键保证不会重复计数) |
| POST | `/api/projects/:slug/join` | 是 | 提交加入申请,`message` 可选(≤500字)。owner 不能申请加入自己的项目(`400`);已是成员(`409`);已有 `pending` 申请(`409`,数据库部分唯一索引兜底并发) |
| GET | `/api/projects/:slug/join-requests` | 是(owner/站长) | 该项目的**全部**加入申请,含已处理的 `accepted`/`rejected`(被拒后可以重新提交,旧记录留档),按提交时间倒序。响应 `{requests:[{id, message, status, created_at, decided_at, username, display_name}]}`,`decided_at` 对 `pending` 那几行是 `null`。**服务端不做 status 过滤** —— 要待办队列的调用方得自己按 `status === 'pending'` 筛,否则对已处理的申请再调 `/decision` 只会拿到 `409` |
| POST | `/api/join-requests/:id/decision` | 是(owner/站长) | `{decision:'accept'\|'reject'}`。同一事务:标记申请状态 + `accept` 时插入 `project_members`。申请已经不是 `pending` 时返回 `409`(`该申请已处理`)。**路径故意不叫 `/decide`**,见上文"保留动词"一节 |
| GET | `/api/admin/projects/pending` | 站长 | 待审项目列表 |
| POST | `/api/admin/projects/:id/review` | 站长 | `{decision:'approve'\|'reject', note?}`。通过后项目进入公开列表,并通知发起人 |

## `users` · 成员目录 + 账号审核(`app/routes/users.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/members` | 否 | 已通过审核的用户列表(不含 `email`) |
| GET | `/api/members/:username` | 否 | 成员详情 + 其已过审项目列表 |
| GET | `/api/admin/users/pending` | 站长 | 待审用户列表,**含 `email`/`apply_note`** —— 这是当前系统里唯一会返回**他人**邮箱的接口,默认拒绝匿名访问就是为了挡住它(`GET /api/auth/me` 与 `POST /api/auth/login` 的响应里也有 `email`,但只是调用者自己的,见 `app/routes/auth.ts` 的 `publicUser()`;`/api/members` 系列走 `app/routes/users.ts` 的 `card()`,不含 `email`) |
| POST | `/api/admin/users/:id/review` | 站长 | `{decision:'approve'\|'reject', note?}`,并通知申请人 |
| POST | `/api/admin/users/:id/suspend` | 站长 | 停用账号并吊销其全部会话。不能停用自己(`400`) |

## `notifications` · 站内通知(`app/routes/notifications.ts`)

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| GET | `/api/notifications` | 是 | 最近 50 条(按时间倒序)+ `unread` 计数 |
| POST | `/api/notifications/read` | 是 | 把当前用户全部未读标为已读 |

没有单条已读、没有推送/邮件通道 —— 通知只能靠客户端主动拉 `GET /api/notifications`。主站前端也**没有做周期性轮询**:顶栏铃铛(`app/frontend/src/portal/sections/IdentityRibbon.vue`)只在组件挂载和登录用户变化时各拉一次,所以页面开着的时候新通知不会自己冒出来,要刷新才看得到。

---

## 未实现的功能

以下能力**当前代码里不存在**,不要在文案或对外说明里暗示它们已经做了:

- 邮件发送(注册/审核结果都只写站内通知,不发邮件)
- 密码重置(忘记密码没有自助找回路径,只能站长手动处理)
- 速率限制 / 防爆破(登录、注册接口没有请求频率限制)
- 头像上传(只有项目海报上传,没有用户头像)
- 会话之外的多因素认证
