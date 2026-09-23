-- 课程中心:课程 / 课节 / 学习申请。
-- 移植自上游 `agent/course-native-integration-20260817`,但那边是内存数组 + 零鉴权,
-- 这里按本仓库的既有形态重做:关系表、外键级联、部分唯一索引、审批人留痕。
--
-- 只新增,不改前三个迁移(迁移按文件名顺序应用并记入 schema_migrations)。

CREATE TABLE courses (
  id            bigserial PRIMARY KEY,
  slug          citext UNIQUE NOT NULL,   -- 由 app/lib/slug.js#uniqueSlug 生成,自动避开保留动词
  title         text NOT NULL,
  subject       text,                     -- 课程方向,如「微积分」;用于搜索与卡片副标题
  track         text NOT NULL
                CHECK (track IN ('math','literacy','extension','application')),
  summary       text,                     -- 卡片摘要(上游叫 blurb)
  description   text,                     -- 详情页正文
  -- 教师是被展示的署名,不是站内账号,上游本身就当展示字符串用(join('、'))。
  -- 先用单列 text;将来若要按教师筛选/统计,再升迁成 course_instructors 关联表。
  instructors   text,
  audience      text,                     -- 适合人群
  total_hours   numeric(4,1),             -- NULL = 持续更新
  featured      boolean NOT NULL DEFAULT false,
  -- 上游有 review(pending/approved/rejected)与 status(draft/pending/published/archived)
  -- 两列,且永远同步移动 —— 分成两列只会造出 (review='rejected', status='published')
  -- 这种不可能状态。合并成一个 status。
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending','published','archived')),
  review_note   text,
  reviewed_by   bigint REFERENCES users(id),
  reviewed_at   timestamptz,
  created_by    bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_status_idx ON courses (status);
CREATE INDEX courses_track_idx  ON courses (track);

CREATE TABLE course_lessons (
  id               bigserial PRIMARY KEY,
  course_id        bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position         int NOT NULL CHECK (position > 0),
  title            text NOT NULL,
  summary          text,
  duration_minutes int NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0), -- 0 = 专题课节,不标时长
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_lessons_course_idx ON course_lessons (course_id, position);
-- 刻意**不**加 UNIQUE (course_id, position):重排课节时整段 position 要一起挪,
-- 普通唯一约束会在事务中途撞车(得写成 DEFERRABLE INITIALLY DEFERRED 才行)。
-- 我们的重排端点是「一次提交完整顺序」,由服务端在一个事务里整体重写 position,
-- 幂等、无中间态,不需要这条约束来兜底。

CREATE TABLE course_enrollments (
  id          bigserial PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     text,                       -- 申请留言(可选);上游没有,与项目加入申请对齐
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  decided_by  bigint REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_enrollments_course_idx ON course_enrollments (course_id);
CREATE INDEX course_enrollments_user_idx   ON course_enrollments (user_id);

-- 同一人对同一门课,同时只能有一条**有效**申请(待处理或已通过)。
-- 被拒的行不在索引里,所以可以重新申请,旧行以 rejected 留档。
--
-- 这里刻意用**一条**覆盖两种状态的索引,而不是 pending / approved 各来一条:
-- 那样两条之间有缝 —— 申请通过后原行变成 approved,管 pending 的那条就不再挡它,
-- 而新插入的又是 pending、不违反管 approved 的那条,于是已经在学的人可以无限重复
-- 申请,站长队列里反复看到同一个人。(这个缝是压力测试打出来的,单元测试当时只覆盖了
-- "pending 状态下重复申请"。)
CREATE UNIQUE INDEX course_enrollments_active_uniq
  ON course_enrollments (course_id, user_id) WHERE status IN ('pending', 'approved');

-- 没有建的东西,以及为什么:
--   course_assets(课件)  —— 课件那条线上游自己没跑通(asset 的 url 指向不存在的文件,
--                           唯一带 asset 的课启动即被归档),且需要对象存储与鉴权下载,
--                           不在本次范围。将来要做时它是独立的一张表 + 一个下载端点。
--   favorites            —— 上游已无任何调用方,只剩排序权重,用 created_at 排即可。
--   difficulty           —— 只在后台表单存在,前台一行都不渲染。
--   kind(官方/导师/学生) —— 新建一律 'official',分类维度已被 track 取代。
--   gitee_repo           —— 上游建课时硬编码为 null。
--   domain               —— 与 track 同值。
--   visibility           —— 上游设成 'members' 却从不被任何代码执行,是个骗人的字段。
--   version              —— 详情页上一个装饰性的 "v1";updated_at 已覆盖"内容有没有变"。
--   slug 后台可编辑     —— 上游允许站长手写课程链接标识(重名 409)。我方 slug 由 uniqueSlug
--                           在建课时生成一次、之后不可改,与项目那边同一条规则(见
--                           app/routes/projects.js 的「slug 一经创建不再变更,避免外链失效」)。
--                           代价:中文课名拿到的是 c-3f9a21 这种随机串,可读性不如手写的
--                           /course/linear-algebra。之所以接受这个代价:改 slug 会让已经发出去的
--                           链接失效,而课程链接是要贴进群里、写进课表的。要好看的链接,
--                           建课时用英文标题即可(slugify 会保留 a-z0-9)。
--   course_audit_logs    —— 上游那张表没有 actor、没有读取端点,复刻等于新建一张没人看的表;
--                           reviewed_by / decided_by 已经把关键动作的责任人钉死了。
