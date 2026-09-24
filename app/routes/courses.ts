import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, tx, pgCode } from '../db/pool';
import { courses, courseEnrollments, courseLessons, users } from '../db/schema';
import { uniqueSlug } from '../lib/slug';
import { parsePagination, pageMeta } from '../lib/pagination';
import { escapeLike } from '../lib/like';
import { statusesParam } from '../lib/statuses';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const COURSE_ENROLLMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

const TRACKS = new Set(['math', 'literacy', 'extension', 'application']);
const STATUSES = new Set(['draft', 'pending', 'published', 'archived']);

// numeric 列(total_hours)在 drizzle 与裸 pg 一样默认返回**字符串**(为了不丢
// 精度),而 total_hours 是给前端做三宫格数字用的。bigint 已经在 pool.ts 里
// 统一成 Number 了,numeric 没有 —— 它可能有小数,全局转换会影响将来任何
// numeric 列,所以只在这里按字段转。
const hours = (v: unknown) => (v == null ? null : Number(v));

// 公开卡片:列表与详情共用的字段。故意不含 created_by / review_note / reviewed_by ——
// 审核留痕是后台的事,不进任何面向普通访客的响应。
const card = (c: { id: number; slug: string; title: string; subject: string | null;
                   track: string; summary: string | null; instructors: string | null;
                   total_hours: string | null; featured: boolean; status: string;
                   lesson_count?: number | null; created_at: Date }) => ({
  id: c.id, slug: c.slug, title: c.title, subject: c.subject, track: c.track,
  summary: c.summary, instructors: c.instructors, total_hours: hours(c.total_hours),
  featured: c.featured, status: c.status,
  lesson_count: c.lesson_count == null ? undefined : c.lesson_count,
  created_at: c.created_at,
});

const lessonRow = (l: { id: number; position: number; title: string;
                        summary: string | null; duration_minutes: number }) => ({
  id: l.id, position: l.position, title: l.title,
  summary: l.summary, duration_minutes: l.duration_minutes,
});

async function loadCourse(slug: string) {
  const r = await db.select().from(courses).where(eq(courses.slug, slug));
  return r[0] || null;
}

// 建课/改课共用的字段收集。只收请求里出现过的键,与 projects.ts 的 collectContent 同一套
// 语义:"没传"和"传空"是两件事。
function collectCourse(body: Record<string, unknown>, { creating }: { creating: boolean }):
    { error: string } | { fields: Record<string, string | number | boolean | null> } {
  const fields: Record<string, string | number | boolean | null> = {};
  if (creating || typeof body.title === 'string') {
    const t = str(body.title, 120);
    if (!t) return { error: '请填写课程名' };
    fields.title = t;
  }
  if (creating || body.track !== undefined) {
    const tr = str(body.track, 32);
    if (!TRACKS.has(tr)) return { error: '未知的课程分类' };
    fields.track = tr;
  }
  for (const [k, max] of [['subject', 60], ['summary', 500], ['description', 8000],
                          ['instructors', 200], ['audience', 200]] as const) {
    if (typeof body[k] === 'string') fields[k] = str(body[k], max) || null;
  }
  if (body.total_hours !== undefined) {
    if (body.total_hours === null || body.total_hours === '') fields.total_hours = null;
    else {
      const n = Number(body.total_hours);
      if (!Number.isFinite(n) || n < 0 || n > 9999) return { error: '总课时不合法' };
      fields.total_hours = n;
    }
  }
  if (body.featured !== undefined) {
    if (typeof body.featured !== 'boolean') return { error: 'featured 需要是布尔值' };
    fields.featured = body.featured;
  }
  if (body.status !== undefined) {
    const s = str(body.status, 20);
    if (!STATUSES.has(s)) return { error: '未知的课程状态' };
    fields.status = s;
  }
  return { fields };
}

// 列表页带 lesson_count 子查询的列集合(公开列表与后台列表共用形状)。
// getTableColumns 展开 = "全部列 + 附加计算列"的标准写法(直接 spread
// 表对象会把 enableRLS 之类非列属性带进去)。
const courseWithCount = {
  ...getTableColumns(courses),
  lesson_count: sql<number>`(SELECT count(*)::int FROM course_lessons l WHERE l.course_id = ${courses.id})`.as('lesson_count'),
};

const courseRoutes: RouteHandler = async (ctx, D) => {
  const { method, seg, body, user, query: qs } = ctx;
  if (seg[0] !== 'api') return;

  // ============ 公开 / 成员 ============

  // GET /api/courses?track=&q=&page=&per_page=
  // ?q= 是 CoursesPage 本地搜索的服务端化:覆盖与前端原先本地过滤相同的四字段
  // (title/subject/summary/instructors),%/_ 由 escapeLike 转义,防通配符注入。
  if (method === 'GET' && seg[1] === 'courses' && !seg[2]) {
    const track = qs.get('track');
    if (track && !TRACKS.has(track)) return D({ error: '未知的课程分类' }, 400);
    const rawQ = str(qs.get('q') ?? '', 100);
    const kw = rawQ ? `%${escapeLike(rawQ)}%` : null;
    const { page, perPage } = parsePagination(qs);
    const where = and(
      eq(courses.status, 'published'),
      track ? eq(courses.track, track) : undefined,
      kw ? or(ilike(courses.title, kw), ilike(courses.subject, kw),
              ilike(courses.summary, kw), ilike(courses.instructors, kw)) : undefined,
    );
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(courses).where(where);
    const r = await db.select(courseWithCount).from(courses)
      .where(where)
      .orderBy(desc(courses.featured), desc(courses.created_at), desc(courses.id))
      .limit(perPage).offset((page - 1) * perPage);
    return D({ courses: r.map(card), pagination: pageMeta(n, page, perPage) });
  }

  // GET /api/courses/:slug
  if (method === 'GET' && seg[1] === 'courses' && seg[2] && !seg[3]) {
    const c = await loadCourse(seg[2]);
    // 未发布的课只有站长看得到;其余人一律 404 而不是 403 —— 与项目详情同一条掩护规则,
    // 不向匿名/普通成员泄露"这门课存在"。
    const maySee = c && (c.status === 'published' || (user && user.role === 'admin'));
    if (!maySee) return D({ error: 'not found' }, 404);
    const ls = await db.select().from(courseLessons)
      .where(eq(courseLessons.course_id, c.id))
      .orderBy(courseLessons.position);
    let enrollment = null;
    if (user) {
      const e = await db.select({
        id: courseEnrollments.id, status: courseEnrollments.status, created_at: courseEnrollments.created_at,
      }).from(courseEnrollments)
        .where(and(eq(courseEnrollments.course_id, c.id), eq(courseEnrollments.user_id, user.id)))
        .orderBy(desc(courseEnrollments.created_at)).limit(1);
      enrollment = e[0] || null;
    }
    return D({
      course: { ...card({ ...c, lesson_count: undefined }), description: c.description, audience: c.audience,
                lesson_count: ls.length },
      lessons: ls.map(lessonRow),
      enrollment,
    });
  }

  // POST /api/courses/:slug/enroll
  if (method === 'POST' && seg[1] === 'courses' && seg[2] && seg[3] === 'enroll' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const c = await loadCourse(seg[2]);
    if (!c || c.status !== 'published') return D({ error: 'not found' }, 404);
    // 课纲还没排的课不接受申请。上游用 contentStatus='pending_upload' 挡这条路径,
    // 我方没有那个字段,等价条件就是"一节课都没有" —— 否则站长的申请队列里会出现
    // 一堆"申请一门什么都没有的课",而申请人也不知道自己申请了什么。
    const ls = await db.select({ n: sql<number>`count(*)::int` }).from(courseLessons)
      .where(eq(courseLessons.course_id, c.id));
    if (!ls[0].n) return D({ error: '这门课的课纲还在整理中,暂时不能申请' }, 409);
    const message = str(body.message, 500) || null;
    try {
      const r = await db.insert(courseEnrollments).values({
        course_id: c.id, user_id: user.id, message,
      }).returning({
        id: courseEnrollments.id, status: courseEnrollments.status, created_at: courseEnrollments.created_at,
      });
      return D({ enrollment: r[0] });
    } catch (e) {
      // 23505 = 唯一约束冲突。两条部分唯一索引各挡一种情况:已有待处理申请、已经通过。
      // 靠数据库而不是"先查后插"——后者在并发下会漏。pgCode 兼容 drizzle 包装与裸 pg。
      if (pgCode(e) === '23505') return D({ error: '你已经申请过这门课了' }, 409);
      throw e;
    }
  }

  // GET /api/my/courses?page=&per_page=
  if (method === 'GET' && seg[1] === 'my' && seg[2] === 'courses' && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const { page, perPage } = parsePagination(qs);
    const where = eq(courseEnrollments.user_id, user.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(courseEnrollments).where(where);
    const r = await db.select({
      id: courses.id, slug: courses.slug, title: courses.title, subject: courses.subject,
      track: courses.track, summary: courses.summary, instructors: courses.instructors,
      total_hours: courses.total_hours, featured: courses.featured, status: courses.status,
      created_at: courses.created_at,
      enrollment_status: courseEnrollments.status,
      enrollment_created_at: courseEnrollments.created_at,
      lesson_count: sql<number>`(SELECT count(*)::int FROM course_lessons l WHERE l.course_id = ${courses.id})`,
    }).from(courseEnrollments)
      .innerJoin(courses, eq(courses.id, courseEnrollments.course_id))
      .where(where)
      .orderBy(desc(courseEnrollments.created_at), desc(courseEnrollments.id))
      .limit(perPage).offset((page - 1) * perPage);
    return D({ courses: r.map(row => ({
      ...card(row), lesson_count: row.lesson_count,
      enrollment_status: row.enrollment_status,
      enrollment_created_at: row.enrollment_created_at,
    })), pagination: pageMeta(n, page, perPage) });
  }

  // ============ 站长(路径已被 guard 的 /api/admin/ 前缀拦成后台,这里不再重复查 role) ============

  if (seg[1] !== 'admin') return;

  // GET /api/admin/courses?status=
  if (method === 'GET' && seg[2] === 'courses' && !seg[3]) {
    const status = qs.get('status');
    if (status && !STATUSES.has(status)) return D({ error: '未知的课程状态' }, 400);
    const r = await db.select(courseWithCount).from(courses)
      .where(status ? eq(courses.status, status) : undefined)
      .orderBy(desc(courses.created_at));
    // 后台列表**必须给全字段**:后台的编辑表单直接拿这里的对象回填(startEdit(c) 读
    // c.description / c.audience),少给一个,表单里就是空串;保存时整份表单 PATCH 上去,
    // collectCourse 见到 typeof ''==='string' 就把那一列写成 null —— 站长只想改个标题,
    // 详细介绍却被静默清空。card() 是给公开列表用的瘦身版,不能复用到这里。
    return D({ courses: r.map(c => ({
      ...card(c),
      description: c.description, audience: c.audience, review_note: c.review_note,
    })) });
  }

  // POST /api/admin/courses
  if (method === 'POST' && seg[2] === 'courses' && !seg[3]) {
    const got = collectCourse(body, { creating: true });
    if ('error' in got) return D({ error: got.error }, 400);
    const slug = await uniqueSlug(String(got.fields.title), 'courses');
    // creating:true 时 collectCourse 已保证 title/track 必在 fields 里,
    // cast 只是把 Record 收窄回 insert 的行类型。
    const r = await db.insert(courses).values({
      ...(got.fields as { title: string; track: string } & Record<string, string | number | boolean | null>),
      slug, created_by: user!.id,
    }).returning();
    return D({ course: card(r[0]) });
  }

  // PATCH /api/admin/courses/:id
  if (method === 'PATCH' && seg[2] === 'courses' && seg[3] && !seg[4]) {
    const got = collectCourse(body, { creating: false });
    if ('error' in got) return D({ error: got.error }, 400);
    const keys = Object.keys(got.fields);
    if (!keys.length) return D({ error: '没有要改的内容' }, 400);
    const sets = { ...(got.fields as Record<string, any>), updated_at: sql`now()` };
    const r = await db.update(courses).set(sets)
      .where(eq(courses.id, Number(seg[3]))).returning();
    if (!r.length) return D({ error: 'not found' }, 404);
    return D({ course: card(r[0]) });
  }

  // POST /api/admin/courses/:id/review
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'review' && !seg[5]) {
    const decision = str(body.decision, 20);
    if (decision !== 'approve' && decision !== 'reject') {
      return D({ error: 'decision 只能是 approve 或 reject' }, 400);
    }
    const cur = await db.select({ status: courses.status }).from(courses)
      .where(eq(courses.id, Number(seg[3])));
    if (!cur.length) return D({ error: 'not found' }, 404);
    const next = decision === 'approve' ? 'published' : 'draft';
    const r = await db.update(courses).set({
      status: next, review_note: str(body.note, 500) || null,
      reviewed_by: user!.id, reviewed_at: sql`now()`, updated_at: sql`now()`,
    }).where(eq(courses.id, Number(seg[3]))).returning();
    return D({ course: card(r[0]) });
  }

  // POST /api/admin/courses/:id/lessons
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'lessons' && !seg[5]) {
    const title = str(body.title, 120);
    if (!title) return D({ error: '请填写课节标题' }, 400);
    const dm = body.duration_minutes === undefined ? 0 : Number(body.duration_minutes);
    if (!Number.isInteger(dm) || dm < 0 || dm > 100000) return D({ error: '课节时长不合法' }, 400);
    const c = await db.select({ one: sql`1` }).from(courses).where(eq(courses.id, Number(seg[3])));
    if (!c.length) return D({ error: 'not found' }, 404);
    const r = await db.insert(courseLessons).values({
      course_id: Number(seg[3]),
      // position = 当前最大值 + 1(子查询取 max,空表时 COALESCE 到 0)
      position: sql`(SELECT COALESCE(MAX(position),0)+1 FROM course_lessons WHERE course_id = ${Number(seg[3])})`,
      title, summary: str(body.summary, 1000) || null, duration_minutes: dm,
    }).returning();
    return D({ lesson: lessonRow(r[0]) });
  }

  // POST /api/admin/courses/:id/lessons/reorder
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'lessons'
      && seg[5] === 'reorder' && !seg[6]) {
    const ids = body.lesson_ids;
    if (!Array.isArray(ids) || !ids.length) return D({ error: 'lesson_ids 需要是非空数组' }, 400);
    const courseId = Number(seg[3]);
    const cur = await db.select({ id: courseLessons.id }).from(courseLessons)
      .where(eq(courseLessons.course_id, courseId));
    const have = cur.map(x => Number(x.id)).sort((a, b) => a - b);
    const want = (ids as unknown[]).map(Number).sort((a, b) => a - b);
    // 必须是该课全部课节的一个排列 —— 漏掉一条会留下空洞,混入别的课的课节会把它抢过来。
    // 一次提交完整顺序比"上移/下移一格"更好测也更幂等,这是相对上游的有意改动。
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
      return D({ error: 'lesson_ids 必须恰好是这门课的全部课节' }, 400);
    }
    await tx(async (c) => {
      // 一次设到位。表上**没有** UNIQUE(course_id,position),所以事务中途出现两行
      // 同 position 是允许的,不需要"先挪到负数区再落位"那种两段式 —— 而且也不能这么做,
      // position 上有 CHECK (position > 0),负数中间态会直接被约束打回。
      // 将来若真要加那条唯一约束,得写成 DEFERRABLE INITIALLY DEFERRED,并把
      // CHECK 一起放宽,那时再回来改这里。
      for (let i = 0; i < ids.length; i++) {
        await c.update(courseLessons).set({ position: i + 1 })
          .where(and(eq(courseLessons.id, Number(ids[i])), eq(courseLessons.course_id, courseId)));
      }
    });
    return D({ ok: true });
  }

  // PATCH /api/admin/lessons/:id
  if (method === 'PATCH' && seg[2] === 'lessons' && seg[3] && !seg[4]) {
    const sets: Record<string, unknown> = {};
    if (typeof body.title === 'string') {
      const t = str(body.title, 120);
      if (!t) return D({ error: '请填写课节标题' }, 400);
      sets.title = t;
    }
    if (typeof body.summary === 'string') sets.summary = str(body.summary, 1000) || null;
    if (body.duration_minutes !== undefined) {
      const dm = Number(body.duration_minutes);
      if (!Number.isInteger(dm) || dm < 0 || dm > 100000) return D({ error: '课节时长不合法' }, 400);
      sets.duration_minutes = dm;
    }
    if (!Object.keys(sets).length) return D({ error: '没有要改的内容' }, 400);
    const r = await db.update(courseLessons).set(sets)
      .where(eq(courseLessons.id, Number(seg[3]))).returning();
    if (!r.length) return D({ error: 'not found' }, 404);
    return D({ lesson: lessonRow(r[0]) });
  }

  // DELETE /api/admin/lessons/:id
  if (method === 'DELETE' && seg[2] === 'lessons' && seg[3] && !seg[4]) {
    const done = await tx(async (c) => {
      const r = await c.delete(courseLessons)
        .where(eq(courseLessons.id, Number(seg[3])))
        .returning({ course_id: courseLessons.course_id });
      if (!r.length) return false;
      // 删掉中间一节会在 position 序列里留个洞。重排成连续的,免得前端拿 position
      // 当序号显示时出现 "01 03 04"。
      const rest = await c.select({ id: courseLessons.id }).from(courseLessons)
        .where(eq(courseLessons.course_id, r[0].course_id))
        .orderBy(courseLessons.position);
      for (let i = 0; i < rest.length; i++) {
        await c.update(courseLessons).set({ position: i + 1 })
          .where(eq(courseLessons.id, rest[i].id));
      }
      return true;
    });
    return done ? D({ ok: true }) : D({ error: 'not found' }, 404);
  }

  // GET /api/admin/course-enrollments?status=&page=&per_page=
  // ?status= 升级为逗号分隔多值(单值仍然兼容,前端各处传单个状态不变)。
  if (method === 'GET' && seg[2] === 'course-enrollments' && !seg[3]) {
    const st = statusesParam(qs, COURSE_ENROLLMENT_STATUSES);
    if (st === 'invalid') return D({ error: '未知的申请状态' }, 400);
    const { page, perPage } = parsePagination(qs);
    // ANY(数组) 的绑定要交给 inArray(drizzle 会展开成 IN (listed));
    // 直接把 JS 数组绑成 $1 会被 pg 当标量字符串,array_in 解析失败。
    const where = st.length ? inArray(courseEnrollments.status, st) : undefined;
    // 逐列点名,不 join 邮箱 —— 站长审报名不需要申请人邮箱,别让这个端点变成第二个
    // 会吐他人邮箱的接口(目前唯一一个是 GET /api/admin/users/pending)。
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(courseEnrollments).where(where);
    const r = await db.select({
      id: courseEnrollments.id, status: courseEnrollments.status,
      message: courseEnrollments.message, created_at: courseEnrollments.created_at,
      course_slug: courses.slug, course_title: courses.title,
      username: users.username, display_name: users.display_name,
    }).from(courseEnrollments)
      .innerJoin(courses, eq(courses.id, courseEnrollments.course_id))
      .innerJoin(users, eq(users.id, courseEnrollments.user_id))
      .where(where)
      .orderBy(desc(courseEnrollments.created_at), desc(courseEnrollments.id))
      .limit(perPage).offset((page - 1) * perPage);
    return D({ requests: r.map(x => ({
      id: x.id, status: x.status, message: x.message, created_at: x.created_at,
      course: { slug: x.course_slug, title: x.course_title },
      user: { username: x.username, display_name: x.display_name },
    })), pagination: pageMeta(n, page, perPage) });
  }

  // POST /api/admin/course-enrollments/:id/review
  if (method === 'POST' && seg[2] === 'course-enrollments' && seg[3]
      && seg[4] === 'review' && !seg[5]) {
    const decision = str(body.decision, 20);
    if (decision !== 'approve' && decision !== 'reject') {
      return D({ error: 'decision 只能是 approve 或 reject' }, 400);
    }
    const cur = await db.select({
      id: courseEnrollments.id, status: courseEnrollments.status,
      user_id: courseEnrollments.user_id, title: courses.title,
    }).from(courseEnrollments)
      .innerJoin(courses, eq(courses.id, courseEnrollments.course_id))
      .where(eq(courseEnrollments.id, Number(seg[3])));
    if (!cur.length) return D({ error: 'not found' }, 404);
    if (cur[0].status !== 'pending') return D({ error: '这条申请已经处理过了' }, 409);
    const next = decision === 'approve' ? 'approved' : 'rejected';
    await db.update(courseEnrollments).set({
      status: next, decided_by: user!.id, decided_at: sql`now()`,
    }).where(eq(courseEnrollments.id, Number(seg[3])));
    await notify(cur[0].user_id, 'course',
      next === 'approved' ? '课程学习申请已通过' : '课程学习申请未通过',
      next === 'approved'
        ? `你可以开始学习「${cur[0].title}」了。`
        : `「${cur[0].title}」这次没有通过,可以过段时间再申请。`);
    return D({ ok: true, status: next });
  }
};

export default courseRoutes;
