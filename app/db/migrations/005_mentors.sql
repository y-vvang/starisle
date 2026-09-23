-- 导师目录 / 指导申请 / 合作机构。
-- 移植自上游 feat/mentor-resources-admin,但那边有两个必须在移植时改掉的问题:
--
--   (1) 它的申请表单收集未成年人的**真实姓名 / 学校年级 / 联系方式**,后台明文展示
--       并提供一键导出 TXT 到站长本机。同一个文件里一边写着"星屿不看年龄、学校、成绩",
--       一边把这些全渲染出来。本项目的硬约束是不收未成年人敏感信息(注册只接六字段),
--       所以下面的 mentor_requests **刻意没有** real_name / contact / school / grade / age 列。
--       申请人是谁由 user_id 外键决定;站长要联系人就用注册时那个已经受访问控制的邮箱。
--       结果:这个模块不引入任何新的 PII 类别,隐私面完全不扩大。
--
--   (2) 它的后端零鉴权(整个 core.js 里 grep session|cookie|password|authorization 命中 0 次),
--       申请列表连同导师邮箱匿名可读、可枚举 memberId 读他人申请、可越权批准任意申请。
--       这里所有站长动作一律挂 /api/admin/ 前缀由守卫层①拦截,身份只从会话取。

CREATE TABLE mentors (
  id            bigserial PRIMARY KEY,
  slug          citext UNIQUE NOT NULL,
  name          text NOT NULL,            -- 导师本人姓名(成年人,公开展示的署名)
  title         text,                     -- 如「课程导师」
  org           text,
  bio           text,
  -- ★仅站长可见。绝不进任何面向普通访客的序列化 —— 上游在 /api/mentors 列表里剥了它,
  --   却在申请列表端点里又漏了回来。这里的做法是只有 /api/admin/* 的查询才 SELECT 这一列。
  contact_email citext,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  sort          int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mentors_status_sort_idx ON mentors (status, sort);

CREATE TABLE mentor_courses (
  id          bigserial PRIMARY KEY,
  mentor_id   bigint NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
  title       text NOT NULL,
  -- 上游这个字段叫 lessons,但里面装的其实是**总课时**:6 个有值的全部精确等于对应课程的
  -- total_hours(12/24/18/12/18/12),没有一个等于课节数(那些是 4/4/3/2/3/2),
  -- 4 个空串也恰好对应 total_hours 为 null 的课。照原名叫 lessons 会让前端把
  -- 「24 课时」显示成「24 节课」,所以这里按它的真实含义命名。
  total_hours int,
  level       text CHECK (level IS NULL OR level IN ('初级', '中级', '高级')),
  sort        int NOT NULL DEFAULT 0,
  UNIQUE (mentor_id, title)
);
CREATE INDEX mentor_courses_mentor_idx ON mentor_courses (mentor_id);
-- 课程标题在多位导师间会重复(比如「微积分」有两位),按 title 做筛选即可,
-- 暂不单独建 courses 维表 —— 除非将来要给这些课程本身挂详情页。
-- 注意它和 004 的 courses 表不是一回事:那是站内开设的课程,这是导师的履历条目。

CREATE TABLE mentor_requests (
  id           bigserial PRIMARY KEY,
  mentor_id    bigint NOT NULL REFERENCES mentors(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 只有这四个字段。全是"想做什么"而不是"你是谁"。
  interest     text NOT NULL,             -- 感兴趣的方向(必填)
  background   text,                      -- 已具备的基础
  questions    text,                      -- 想请教的问题
  weekly_hours text CHECK (weekly_hours IS NULL OR weekly_hours IN ('<2h', '2-4h', '4-6h', '>6h')),
  -- 四态工作流:pending → approved/rejected → (approved 后)completed。
  -- completed 的含义是"站长已经在站外把双方对接上了" —— 平台不做少年与导师之间的
  -- 直接通道,导师邮箱只给站长看。这个取向与本项目一致,是上游值得保留的设计。
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  review_note  text,
  decided_by   bigint REFERENCES users(id),
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mentor_requests_mentor_idx ON mentor_requests (mentor_id);
CREATE INDEX mentor_requests_user_idx   ON mentor_requests (user_id);

-- 同一人对同一位导师同时只能有一条"在处理中"的申请(待审 / 已通过待对接 / 已对接)。
-- 被拒的不在索引里,可以重新申请。
-- 这里一次覆盖三种状态,而不是每种来一条 —— 004 那边最初写成两条各管一段,
-- 结果两条之间有缝(通过之后原行不再被 pending 那条挡住,新插入的 pending 也不违反
-- approved 那条),已经在指导中的人可以无限重复申请。同一个坑不踩第二次。
CREATE UNIQUE INDEX mentor_requests_active_uniq
  ON mentor_requests (mentor_id, user_id)
  WHERE status IN ('pending', 'approved', 'completed');

CREATE TABLE partner_orgs (
  id          bigserial PRIMARY KEY,
  slug        citext UNIQUE NOT NULL,
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('中学', '大学', '企业')),
  -- 站内静态路径。**目前恒为 NULL**:上游那 33 张校徽共 10.9 MB、9 张超过 500KB,
  -- 直接进 git 与 Docker 镜像不合适,需要先压缩(WebP/短边 200px)并重命名成 ASCII
  -- (中文文件名会撞上 app/server.js 静态分支不做 URL 解码的问题)。列先留着,
  -- 前端在 NULL 时用 monogram(2-3 字简称)渲染成文字徽章,视觉上完整,不是缺角。
  logo_path   text,
  website     text,
  cooperation text,                        -- 合作内容,站长后填(上游 33 条全是空的)
  monogram    text,                        -- 2-3 字简称,logo 缺失时的兜底
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_orgs_category_sort_idx ON partner_orgs (category, sort);

-- 没有建的东西:
--   real_name / contact / school / grade / age —— 见文件开头 (1)。
--   导出功能相关的一切 —— 上游的两处 TXT 导出会把未成年人 PII 明文落到站长本机,
--                          离开系统的一切访问控制。不做。
--   mentors.domains[]      —— 上游 14 位导师里 13 位都是 ['agent'],前端改版后也不再渲染领域标签
--                             (课程标签取代了它)。
--   mentors.mentees[] / menteeCount —— 上游 14/14 全是空数组,卡片上恒显示「带 0 人」。
--   mentors.office_hours   —— 上游 14/14 全是空串。
--   mentor_projects        —— 上游 MENTOR_PROJECTS = [],纯占位。
--   partner_orgs 的 mentor_count / course_count —— 上游在 wire() 里硬编码成 0,不是算出来的。
--     以上五项的共同点:上游有字段、有渲染位,但数据全是空的或恒定值。移植它们等于把一堆
--     恒显示 0 的标签搬过来,不如不做;将来真要这些维度,补一张关联表比留空列诚实。
--   coop_mentors           —— 上游是恒返回 [] 的死代码。
--   schools / coopSchools 双份 —— 上游 wire() 里逐字段相同的两次 map,只留一份。
