# 模块 · Modules

星屿的前端重写一度砍掉了课程、约稿专栏、活动、学生报道、资源、导师、企业、机构、课题、风控、撮合、银河图这 12 个模块,只剩**账号**与**项目**两条主线。旧文档写的"16 个模块、多视角工作台、控制台权限组"已经不存在。

---

## 主站(portal,`app/frontend/src/portal`)

`app/frontend/src/lib/router.js` 是一个极简哈希路由(支持三段:`page`/`param`/`sub`)。它声明了 11 个路由名,`PortalApp.vue` 的 `PAGES` 映射表接了其中 7 个:

| 路由 | 页面组件 | 内容 |
|---|---|---|
| `#/` | `HomePage.vue` | 首屏 Hero + 项目预览条(见下方"首页的空壳区块") |
| `#/projects` | `ProjectsPage.vue` | 项目列表(浏览 + 发起项目,`ProjectsSection.vue`) |
| `#/project/:slug` | `ProjectDetailPage.vue` | 项目详情:核心信息、成员,以及关注/加入申请/海报上传/加入申请队列四块交互(交互接的是真实端点,信息区仍有部分空壳,都见下方) |
| `#/project/:slug/edit` | `ProjectEditPage.vue` | 项目编辑,只有属主/站长进得去(不是就显示"打不开这个编辑页")。改基本信息 + 详情页 02/03/04 三块内容。这是 `router.js` 里唯一用到**第三段** `sub` 的路由 |
| `#/courses` | `CoursesPage.vue` | 课程列表:分类 tab(走服务端 `?track=`)+ 关键词搜索(本地过滤) |
| `#/course/:slug` | `CourseDetailPage.vue` | 课程详情 + 课纲 + 申请学习。课纲对匿名可见;**课纲为空时不摆申请按钮**(服务端也会 409) |
| `#/my-courses` | `MyCoursesPage.vue` | 自己申请过的课与状态 |
| `#/mentors` | `MentorsPage.vue` | 导师目录(按课程筛选)+ 指导申请弹窗 + 合作机构墙 |

`members`/`u`/`login`/`register`/`me` 这几个路由名在 `router.js` 里还在,但没有对应页面组件 —— 命中时 `PAGES[router.page] || HomePage` 会落回首页。登录、注册**不是独立页面**,而是弹层:`JoinModal.vue`(同一个弹窗,`store.authMode` 在 `'register'`/`'login'` 之间切换,两个 tab 的文案是"申请加入"/"登录")和 `IdentityRibbon.vue`(顶栏身份状态:显示名、退出登录,以及通知铃铛/面板)。显示名、Gitee 主页这些资料只在注册表单里录入一次,**注册之后没有任何改资料或改密码的界面**(端点是有的,见下方"仍缺前端入口的能力")。成员详情是 `DrawerView.vue` 抽屉,不是整页。

### 首页的空壳区块

`HomePage.vue` 里除了"项目"和"课程"这两条**已接真实接口**的预览条,还留着约稿专栏 / 活动 / 学生报道 / 资源共 4 条预览条的模板代码,对应的数据源(`store.js` 里的 `courses`/`gatherings`/`talent` 和 `highlights.posts`,以及资源那条在 `HomePage.vue` 里的本地 `allRes`)全部硬编码成空值、**不请求任何后端接口**(那些接口已经不存在)。这几条 strip 会渲染出"标题 + 查看全部"但下面没有卡片。这是重写时刻意的过渡状态,不是 bug,但如果要精简首页,这是要清理的地方。

### 项目列表页的空壳控件

`ProjectsSection.vue` 里也留着一批重写前的控件,和首页那 5 条 strip 是同一类过渡状态:

- **状态筛选标签**(存活 90 天+/活跃/孵化中/招募中)恒为 0 条。前三个比对的是 `thriving`/`active`/`incubating`,而 `projects.status` 的 CHECK 约束只允许 `pending`/`approved`/`rejected`(`app/db/migrations/001_init.sql`),`GET /api/projects` 又只返回 `approved` —— 这三个值在库里根本不可能出现;"招募中"比的是 `p.gaps.length`,而后端 `card()`(`app/routes/projects.js`)不返回 `gaps`,`store.js` 的 `cardifyProjects` 一律兜底成 `[]`。
- **项目卡上的元信息**:"活跃度"(`p.activity`)和"Demo 在线"(`p.demo`)后端不返回、前端也没兜底,前者的数字恒为空白(标签还在)、后者恒不出现,卡片底部"缺 X —— 等你补位"同理恒不渲染。但 `{{ p.members.length }} 名成员` 因为 `members` 被兜底成 `[]`,**恒显示"0 名成员"** —— 这是这一页唯一会显示出一个错数字(而不是空白)的地方。
- **发起项目表单里的"技术栈(逗号分隔)"和"正在找(缺口技能)"两个输入框**填了不会保存:`actPublishProject`(`store.js`)只把 `name`/`tagline`/`description`/`domain_id`/`repo_url` 转发给 `POST /api/projects`,`stack`/`gaps`/`founderId` 直接丢弃(发起人由服务端从登录会话推断),后端的 `INSERT` 与 `projects` 表也没有这两列。用户填了不报错、照样提示"已提交",但值不落库。

要精简前端时,这是继首页之后第二处要清理的地方 —— 该清理的是表单和模板,不是"后端该补列"。

### 项目详情页的交互:关注 / 加入申请 / 海报 / 申请队列

`ProjectDetailPage.vue` 的**这四块交互**接的都是真实端点,不是占位:

- **关注**(`toggleFollow`):`POST /api/projects/:slug/follow`,按钮态和关注数用服务端返回的权威值覆盖本地状态(不是前端自己翻转布尔),避免多标签页并发操作时前端状态和数据库对不上。未登录点击走 `store.requireLogin` 弹出登录框。
- **申请加入**(`submitJoin`):一个 `window.prompt` 收可选留言,`POST /api/projects/:slug/join`;提交后按钮变"申请审核中"并禁用。owner 看不到这个按钮(`v-if="!isOwner"`)。
- **路演海报**(`onPosterChange` / `removePoster`):只有 `isOwnerOrAdmin`(按 `username` 比对,不依赖后端未返回的 owner id)能看到上传/移除按钮。上传前先在客户端按 `POSTER_MAX_CHARS=700,000`(与 `app/routes/projects.js` 同一个数字)拦一次超限,再发 `POST`/`DELETE /api/projects/:slug/poster`。
- **加入申请队列**:仅 `isOwnerOrAdmin` 可见的区块,拉 `GET /api/projects/:slug/join-requests`,通过/拒绝调 `POST /api/join-requests/:id/decision`(不是 `/decide`,理由见 `docs/API.md` 的保留动词一节)。接受后静默刷新项目详情(成员列表、`following`/`pending_join_request` 状态)。
  **注意那个端点返回的是全部状态**(pending/accepted/rejected)而不是待办队列,前端只把 `status === 'pending'` 的渲染成可操作卡片 —— 早先整份渲染,于是处理过的申请刷新页面后会重新冒出来,还带着能点的通过/拒绝,点下去只会拿到 409。

**通知在哪看** —— 申请提交和处理结果都会写一条站内通知(`notify` 实现在 `app/routes/notifications.js`,`projects.js` 只是 `require` 它来调用)。主站唯一的展示位是 `IdentityRibbon.vue` 顶栏的铃铛和下拉面板:拉 `GET /api/notifications`,展开面板时**若有未读**才发一次 `POST /api/notifications/read` 把当前用户的未读一次性标掉(没有单条已读)。它只在组件挂载和登录用户变化时各拉一次(`watch(() => store.user, loadNotifs, { immediate: true })`),**不轮询**,而 `IdentityRibbon` 又是 `PortalApp.vue` 里的常驻组件、切路由不会重新挂载 —— 所以 owner 开着页面时新申请不会自己冒出来,得刷新页面才看得到。

### 详情页的空壳字段

`adapt()`(`ProjectDetailPage.vue`)把真实响应适配成旧模板期望的形状。旧模板要的字段里,`work`/`stack`/`milestones`/`gaps` 已经由 003 迁移落地成真数据(属主在 `#/project/:slug/edit` 里填),其余的 `platform`/`activity`/`honors`/`demo`/`giteeContent`/`events` 在表里仍然没有对应列,一律给空值或占位:

- 01 核心问题接 `description`;**02 主要工作**接 `work` + `stack`(渲染成小标签),**03 阶段性成果**接 `milestones`,**04 当前需求**接 `gaps`(`{skill, note}` 渲染成「缺一名『前端』· 会 Vue 优先」)。四块都没填时分别显示空 `<p>`、"成果正在路上 ✦"、"当前无公开缺口。" —— 这是**没填**,不再是"后端没有这个东西"。
- `platform` 写死成 `'Gitee'`、`activity` 写死成 `0`,而且头图区里这两处都没有 v-if 保护,任何项目都会无条件显示"Gitee"和"近90天活跃度 0" —— 即使 `repo_url` 指向 GitHub。这两处是详情页仅有的会显示成**具体假值**的地方(上面那三块空壳至少还是空白或"成果正在路上 ✦"这类一眼可辨的占位),清理时优先处理。
- 代码平台内容(`giteeContent`)和近期贡献(`events`)两块有 v-if,会自动收起,不显示。

剩下的 `platform`/`activity`/`honors`/`demo` 这几个和首页那几条 strip 一样,是重写时刻意留的过渡状态,不是 bug。

### 仍缺前端入口的能力

下面两个端点后端已实现、`docs/API.md` 也收录了,但前端没有任何入口,只能直接调 API:

- `POST /api/projects/:slug/members` —— owner 不经过申请、直接按 username 把已过审用户拉进项目。
- `PATCH /api/me` —— 改 `display_name`/`bio`/`repo_url`,或带 `current_password` + `new_password` 改密码(成功后吊销该用户全部会话)。注册弹窗里那句"显示名……随时可改"目前只能靠直接调 API 兑现。

### 注册开关在主站的体现

`SiteSettingsPage.vue` 关掉注册后,`store.registrationOpen` 会收起两处主要"加入"CTA:`PortalApp.vue` 顶栏(含移动端菜单)的"加入"换成一行"暂未开放注册",`HeroSection.vue` 首屏的"申请加入"按钮直接隐藏、并在下方补一行"报名暂未开放,请留意后续开放时间。"。

但这**不是全部入口**:`IdentityRibbon.vue` 常驻右上角的"登录 / 申请加入"不受这个开关控制(它只判有没有登录用户),点它走 `openLogin()` 以登录形态打开 `JoinModal.vue`,而弹窗里的"申请加入" tab 和整份注册表单同样没有任何 `registrationOpen` 判断 —— 访客切过去照样能填完提交,最后由 `app/routes/auth.js` 返回 403「暂未开放注册」,文案回显在弹窗的错误条里。所以注册确实被关死了,但**后端才是唯一真正的闸门**,前端只是收起了主要入口。

### 双语

`app/frontend/src/lib/i18n.js` 是一个 9 行的结构层 i18n:一个响应式的 `i18n.lang`,`t(中文, English)` 在英文缺省时回退中文,顶栏的 `EN`/`中` 按钮(移动端在菜单里)调 `toggleLang()` 切换。只有导航、版块标题副题、主要按钮这类结构文案有英文;项目、成员这些内容数据仍然只有中文。控制台没有接 i18n。

## 控制台(admin,`app/frontend/src/admin`)

登录复用主站同一套 `starisle_sid` cookie 会话(不再有独立的"运营口令")。`AdminApp.vue` 的鉴权走三段:未登录 → 登录卡;已登录但 `role !== 'admin'` → "你没有站长权限"的拦截页;`role === 'admin'` → 进六页控制台。**没有权限组、没有"内容运营/用户运营"这类分组** —— 站长要么能看全部六页,要么进不来。侧栏每项右侧有一个待办角标(进后台时拉一次,**不轮询** —— 与主站通知铃铛同一个取向)。

| 侧栏项 | 页面组件 | 内容 |
|---|---|---|
| 待审用户 | `UserReviewPage.vue` | 待审注册申请列表,通过/拒绝(`POST /api/admin/users/:id/review`) |
| 待审项目 | `ProjectsReviewPage.vue` | 待审项目列表,通过/驳回(`POST /api/admin/projects/:id/review`) |
| 课程管理 | `CoursesAdminPage.vue` | 三个 tab:课程库(建/改/提交审核/发布/下架)、课节编排(增删 + 上下移,提交完整顺序)、学习申请(开通/拒绝) |
| 导师申请 | `MentorReviewPage.vue` | 三段:待处理 / 已通过待对接(**只有这一段显示导师邮箱**)/ 处理留痕 |
| 成员管理 | `MembersPage.vue` | 已过审成员列表 + 停用账号(`POST /api/admin/users/:id/suspend`,不能停用自己) |
| 站点设置 | `SiteSettingsPage.vue` | 唯一开关:是否开放注册(`PATCH /api/admin/settings`) |

六页对应六个真实存在的后端能力,没有多余的桩页面。

---

## 审核链

平台仍然保留"提交 → 人工审核 → 上线"这条主线,但只剩两类内容会走它:

| 内容 | 提交 | 审核动作 | 通过后 |
|---|---|---|---|
| 账号 | `POST /api/auth/register` | `POST /api/admin/users/:id/review` | 可登录 + 站内通知 |
| 项目 | `POST /api/projects` | `POST /api/admin/projects/:id/review` | 进公开列表 + 通知发起人 |
| 课程 | 站长在后台建课 | `POST /api/admin/courses/:id/review` | 进公开课程列表 |
| 学习申请 | `POST /api/courses/:slug/enroll` | `POST /api/admin/course-enrollments/:id/review` | 状态转 approved + 通知申请人 |
| 指导申请 | `POST /api/mentors/:slug/requests` | `POST /api/admin/mentor-requests/:id/review` → `/complete` | 四态:pending→approved→completed,每步通知申请人 |

没有活动、资源申请这些审核队列了 —— 对应的表和路由都不存在。(课程的学习申请与导师的指导申请**有**审核队列,见后台的「课程管理」「导师申请」两页。)资源发放(如果还需要)现在完全是线下过程,不经过这个平台。
