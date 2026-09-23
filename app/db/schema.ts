// Drizzle schema:app/db/migrations/*.sql 的类型化镜像。
// 【真源纪律】手写 SQL 迁移(001–005)仍是数据库结构的唯一真源;本文件只是
// 让 TS 代码在查询时拿到行类型。改表必须先加新迁移、再同步改这里 ——
// 两者不一致时,以迁移为准(可用 drizzle-kit pull 做 diff 校验,但不用它管迁移)。
//
// 【属性名纪律:一律 snake_case,与列名同名】builder 查询(db.select().from(t))
// 返回的行键名取自这里的 JS 属性名,不是映射的列名。这个项目的 API 响应形状
// (publicUser / card / 详情端点直接透传的行)全是 snake_case,前端与测试都
// 依赖它 —— 属性名跟列名保持同名,是"行为等价"的一部分,不是风格偏好。
// 不要把这里改成驼峰再逐端点手工映射,那是在每个端点引入一次形状漂移的机会。
import { pgTable, text, bigint, bigserial, integer, boolean, numeric, jsonb,
         timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// —— bigint 约定:所有 id 主键列用 bigserial({ mode: 'number' }),外键 bigint 列
//    用 bigint({ mode: 'number' })。mode:'number' 让 Drizzle 在 JS 侧也做 Number
//    转换;底层 pg 的 OID 20 setTypeParser(pool.ts)早已统一转 Number,这里是
//    无害幂等的双保险。
// —— citext 在 Drizzle 里没有专门类型,按 text 映射(读写行为一致:
//    citext 列收普通字符串、比较大小写不敏感由 PG 处理)。
// —— numeric(total_hours)不设 mode:保持与裸 pg 一致返回字符串,
//    序列化层的 hours() 按 Number() 转换。

export const domains = pgTable('domains', {
  id:    text('id').primaryKey(),
  name:  text('name').notNull(),
  color: text('color').notNull(),
  sort:  integer('sort').notNull().default(0),
});

export const users = pgTable('users', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  username:      text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  display_name:  text('display_name').notNull(),
  email:         text('email').notNull().unique(),
  repo_url:      text('repo_url'),
  bio:           text('bio'),
  role:          text('role').notNull().default('member'),
  status:        text('status').notNull().default('pending'),
  apply_note:    text('apply_note'),
  review_note:   text('review_note'),
  reviewed_by:   bigint('reviewed_by', { mode: 'number' }),
  reviewed_at:   timestamp('reviewed_at', { withTimezone: true }),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id:         text('id').primaryKey(),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  user_agent: text('user_agent'),
  ip:         text('ip'),                       // inet 列,按 text 传 IP 字符串即可
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('sessions_user_id_idx').on(t.user_id),
  index('sessions_expires_at_idx').on(t.expires_at),
]);

export const projects = pgTable('projects', {
  id:           bigserial('id', { mode: 'number' }).primaryKey(),
  slug:         text('slug').notNull().unique(),
  name:         text('name').notNull(),
  tagline:      text('tagline'),
  description:  text('description'),
  repo_url:     text('repo_url'),
  domain_id:    text('domain_id').references(() => domains.id),
  status:       text('status').notNull().default('pending'),
  owner_id:     bigint('owner_id', { mode: 'number' }).notNull().references(() => users.id),
  review_note:  text('review_note'),
  reviewed_by:  bigint('reviewed_by', { mode: 'number' }),
  reviewed_at:  timestamp('reviewed_at', { withTimezone: true }),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // 002:base64 data URI 的 text 列(NULL = 无海报)
  poster:       text('poster'),
  // 003:详情页三块内容(02/03/04)。jsonb 读取端 pg 自动 JSON.parse,
  // 写入端 drizzle 对 jsonb 列直接收 JS 值(内部序列化)。
  work:         text('work'),
  stack:        jsonb('stack').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
  milestones:   jsonb('milestones').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
  gaps:         jsonb('gaps').notNull().default(sql`'[]'::jsonb`).$type<{ skill: string; note: string }[]>(),
}, (t) => [
  index('projects_status_idx').on(t.status),
  index('projects_owner_id_idx').on(t.owner_id),
]);

export const projectMembers = pgTable('project_members', {
  project_id: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:       text('role').notNull().default('member'),
  joined_at:  timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.project_id, t.user_id] }),
]);

export const projectFollows = pgTable('project_follows', {
  project_id: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.project_id, t.user_id] }),
  index('project_follows_user_id_idx').on(t.user_id),
]);

export const projectJoinRequests = pgTable('project_join_requests', {
  id:         bigserial('id', { mode: 'number' }).primaryKey(),
  project_id: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  message:    text('message'),
  status:     text('status').notNull().default('pending'),
  decided_by: bigint('decided_by', { mode: 'number' }),
  decided_at: timestamp('decided_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('project_join_requests_project_id_idx').on(t.project_id),
  index('project_join_requests_user_id_idx').on(t.user_id),
  // 部分唯一索引:同一用户对同一项目最多一条 pending;rejected 不在索引里,可重新提交
  uniqueIndex('project_join_requests_pending_uniq').on(t.project_id, t.user_id).where(sql`status = 'pending'`),
]);

export const notifications = pgTable('notifications', {
  id:         bigserial('id', { mode: 'number' }).primaryKey(),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind:       text('kind').notNull(),
  title:      text('title').notNull(),
  body:       text('body'),
  read_at:    timestamp('read_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notifications_user_id_read_at_idx').on(t.user_id, t.read_at),
]);

export const settings = pgTable('settings', {
  key:   text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export const courses = pgTable('courses', {
  id:           bigserial('id', { mode: 'number' }).primaryKey(),
  slug:         text('slug').notNull().unique(),
  title:        text('title').notNull(),
  subject:      text('subject'),
  track:        text('track').notNull(),
  summary:      text('summary'),
  description:  text('description'),
  instructors:  text('instructors'),
  audience:     text('audience'),
  total_hours:  numeric('total_hours', { precision: 4, scale: 1 }),
  featured:     boolean('featured').notNull().default(false),
  status:       text('status').notNull().default('draft'),
  review_note:  text('review_note'),
  reviewed_by:  bigint('reviewed_by', { mode: 'number' }),
  reviewed_at:  timestamp('reviewed_at', { withTimezone: true }),
  created_by:   bigint('created_by', { mode: 'number' }),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('courses_status_idx').on(t.status),
  index('courses_track_idx').on(t.track),
]);

export const courseLessons = pgTable('course_lessons', {
  id:              bigserial('id', { mode: 'number' }).primaryKey(),
  course_id:       bigint('course_id', { mode: 'number' }).notNull().references(() => courses.id, { onDelete: 'cascade' }),
  position:        integer('position').notNull(),
  title:           text('title').notNull(),
  summary:         text('summary'),
  duration_minutes: integer('duration_minutes').notNull().default(0),
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('course_lessons_course_idx').on(t.course_id, t.position),
  // 刻意不加 UNIQUE (course_id, position):重排在事务里整段挪,
  // 普通唯一约束会在事务中途撞车(见 004 迁移注释)
]);

export const courseEnrollments = pgTable('course_enrollments', {
  id:         bigserial('id', { mode: 'number' }).primaryKey(),
  course_id:  bigint('course_id', { mode: 'number' }).notNull().references(() => courses.id, { onDelete: 'cascade' }),
  user_id:    bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  message:    text('message'),
  status:     text('status').notNull().default('pending'),
  decided_by: bigint('decided_by', { mode: 'number' }),
  decided_at: timestamp('decided_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('course_enrollments_course_idx').on(t.course_id),
  index('course_enrollments_user_idx').on(t.user_id),
  // 一条索引覆盖 pending+approved(两条各管一段的有缝教训,见 004 迁移注释)
  uniqueIndex('course_enrollments_active_uniq').on(t.course_id, t.user_id)
    .where(sql`status IN ('pending', 'approved')`),
]);

export const mentors = pgTable('mentors', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  slug:          text('slug').notNull().unique(),
  name:          text('name').notNull(),
  title:         text('title'),
  org:           text('org'),
  bio:           text('bio'),
  contact_email: text('contact_email'),          // ★仅站长可见,见 005 迁移注释
  status:        text('status').notNull().default('active'),
  sort:          integer('sort').notNull().default(0),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('mentors_status_sort_idx').on(t.status, t.sort),
]);

export const mentorCourses = pgTable('mentor_courses', {
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  mentor_id:   bigint('mentor_id', { mode: 'number' }).notNull().references(() => mentors.id, { onDelete: 'cascade' }),
  title:       text('title').notNull(),
  total_hours: integer('total_hours'),
  level:       text('level'),
  sort:        integer('sort').notNull().default(0),
}, (t) => [
  index('mentor_courses_mentor_idx').on(t.mentor_id),
  uniqueIndex('mentor_courses_mentor_id_title_key').on(t.mentor_id, t.title),
]);

export const mentorRequests = pgTable('mentor_requests', {
  id:           bigserial('id', { mode: 'number' }).primaryKey(),
  mentor_id:    bigint('mentor_id', { mode: 'number' }).notNull().references(() => mentors.id, { onDelete: 'cascade' }),
  user_id:      bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  interest:     text('interest').notNull(),
  background:   text('background'),
  questions:    text('questions'),
  weekly_hours: text('weekly_hours'),
  status:       text('status').notNull().default('pending'),
  review_note:  text('review_note'),
  decided_by:   bigint('decided_by', { mode: 'number' }),
  decided_at:   timestamp('decided_at', { withTimezone: true }),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('mentor_requests_mentor_idx').on(t.mentor_id),
  index('mentor_requests_user_idx').on(t.user_id),
  // 一次覆盖三种"进行中"状态(见 005 迁移注释)
  uniqueIndex('mentor_requests_active_uniq').on(t.mentor_id, t.user_id)
    .where(sql`status IN ('pending', 'approved', 'completed')`),
]);

export const partnerOrgs = pgTable('partner_orgs', {
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  slug:        text('slug').notNull().unique(),
  name:        text('name').notNull(),
  category:    text('category').notNull(),
  logo_path:   text('logo_path'),
  website:     text('website'),
  cooperation: text('cooperation'),
  monogram:    text('monogram'),
  sort:        integer('sort').notNull().default(0),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('partner_orgs_category_sort_idx').on(t.category, t.sort),
]);
