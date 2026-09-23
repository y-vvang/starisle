import { query, tx } from '../db/pool';
import { uniqueSlug } from '../lib/slug';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const TRACKS = new Set(['math', 'literacy', 'extension', 'application']);
const STATUSES = new Set(['draft', 'pending', 'published', 'archived']);

// numeric 列经 pg 驱动返回的是**字符串**(为了不丢精度),而 total_hours 是给前端做
// 三宫格数字用的。bigint 已经在 pool.ts 里统一成 Number 了,numeric 没有——
// 它可能有小数,全局转换会影响将来任何 numeric 列,所以只在这里按字段转。
const hours = (v: unknown) => (v == null ? null : Number(v));

// 公开卡片:列表与详情共用的字段。故意不含 created_by / review_note / reviewed_by ——
// 审核留痕是后台的事,不进任何面向普通访客的响应。
const card = (c: any) => ({
  id: c.id, slug: c.slug, title: c.title, subject: c.subject, track: c.track,
  summary: c.summary, instructors: c.instructors, total_hours: hours(c.total_hours),
  featured: c.featured, status: c.status,
  lesson_count: c.lesson_count == null ? undefined : c.lesson_count,
  created_at: c.created_at,
});

const lessonRow = (l: any) => ({
  id: l.id, position: l.position, title: l.title,
  summary: l.summary, duration_minutes: l.duration_minutes,
});

async function loadCourse(slug: string) {
  const r = await query('SELECT * FROM courses WHERE slug=$1', [slug]);
  return (r.rows[0] as any) || null;
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

const courseRoutes: RouteHandler = async (ctx, D) => {
  const { method, seg, body, user, query: qs } = ctx;
  if (seg[0] !== 'api') return;

  // ============ 公开 / 成员 ============

  // GET /api/courses?track=
  if (method === 'GET' && seg[1] === 'courses' && !seg[2]) {
    const track = qs.get('track');
    if (track && !TRACKS.has(track)) return D({ error: '未知的课程分类' }, 400);
    const r = await query(
      `SELECT c.*, (SELECT count(*)::int FROM course_lessons l WHERE l.course_id=c.id) AS lesson_count
         FROM courses c
        WHERE c.status='published' AND ($1::text IS NULL OR c.track=$1)
        ORDER BY c.featured DESC, c.created_at DESC`, [track || null]);
    return D({ courses: r.rows.map(card) });
  }

  // GET /api/courses/:slug
  if (method === 'GET' && seg[1] === 'courses' && seg[2] && !seg[3]) {
    const c = await loadCourse(seg[2]);
    // 未发布的课只有站长看得到;其余人一律 404 而不是 403 —— 与项目详情同一条掩护规则,
    // 不向匿名/普通成员泄露"这门课存在"。
    const maySee = c && (c.status === 'published' || (user && user.role === 'admin'));
    if (!maySee) return D({ error: 'not found' }, 404);
    const ls = await query(
      'SELECT * FROM course_lessons WHERE course_id=$1 ORDER BY position', [c.id]);
    let enrollment = null;
    if (user) {
      const e = await query(
        `SELECT id,status,created_at FROM course_enrollments
          WHERE course_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`, [c.id, user.id]);
      enrollment = e.rows[0] || null;
    }
    return D({
      course: { ...card(c), description: c.description, audience: c.audience,
                lesson_count: ls.rowCount },
      lessons: (ls.rows as any[]).map(lessonRow),
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
    const ls = await query(
      'SELECT count(*)::int AS n FROM course_lessons WHERE course_id=$1', [c.id]);
    if (!(ls.rows[0] as any).n) return D({ error: '这门课的课纲还在整理中,暂时不能申请' }, 409);
    const message = str(body.message, 500) || null;
    try {
      const r = await query(
        `INSERT INTO course_enrollments (course_id,user_id,message)
         VALUES ($1,$2,$3) RETURNING id,status,created_at`, [c.id, user.id, message]);
      return D({ enrollment: r.rows[0] });
    } catch (e) {
      // 23505 = 唯一约束冲突。两条部分唯一索引各挡一种情况:已有待处理申请、已经通过。
      // 靠数据库而不是"先查后插"——后者在并发下会漏。
      if ((e as any) && (e as any).code === '23505') return D({ error: '你已经申请过这门课了' }, 409);
      throw e;
    }
  }

  // GET /api/my/courses
  if (method === 'GET' && seg[1] === 'my' && seg[2] === 'courses' && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const r = await query(
      `SELECT c.*, e.status AS enrollment_status, e.created_at AS enrollment_created_at,
              (SELECT count(*)::int FROM course_lessons l WHERE l.course_id=c.id) AS lesson_count
         FROM course_enrollments e JOIN courses c ON c.id=e.course_id
        WHERE e.user_id=$1 ORDER BY e.created_at DESC`, [user.id]);
    return D({ courses: (r.rows as any[]).map(row => ({
      ...card(row),
      enrollment_status: row.enrollment_status,
      enrollment_created_at: row.enrollment_created_at,
    })) });
  }

  // ============ 站长(路径已被 guard 的 /api/admin/ 前缀拦成后台,这里不再重复查 role) ============

  if (seg[1] !== 'admin') return;

  // GET /api/admin/courses?status=
  if (method === 'GET' && seg[2] === 'courses' && !seg[3]) {
    const status = qs.get('status');
    if (status && !STATUSES.has(status)) return D({ error: '未知的课程状态' }, 400);
    const r = await query(
      `SELECT c.*, (SELECT count(*)::int FROM course_lessons l WHERE l.course_id=c.id) AS lesson_count
         FROM courses c WHERE ($1::text IS NULL OR c.status=$1)
        ORDER BY c.created_at DESC`, [status || null]);
    // 后台列表**必须给全字段**:后台的编辑表单直接拿这里的对象回填(startEdit(c) 读
    // c.description / c.audience),少给一个,表单里就是空串;保存时整份表单 PATCH 上去,
    // collectCourse 见到 typeof ''==='string' 就把那一列写成 null —— 站长只想改个标题,
    // 详细介绍却被静默清空。card() 是给公开列表用的瘦身版,不能复用到这里。
    return D({ courses: (r.rows as any[]).map(c => ({
      ...card(c),
      description: c.description, audience: c.audience, review_note: c.review_note,
    })) });
  }

  // POST /api/admin/courses
  if (method === 'POST' && seg[2] === 'courses' && !seg[3]) {
    const got = collectCourse(body, { creating: true });
    if ('error' in got) return D({ error: got.error }, 400);
    const slug = await uniqueSlug(String(got.fields.title), 'courses');
    const keys = Object.keys(got.fields);
    const cols = ['slug', ...keys, 'created_by'];
    const vals: unknown[] = [slug, ...keys.map(k => got.fields[k]), user!.id];
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await query(
      `INSERT INTO courses (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    return D({ course: card(r.rows[0]) });
  }

  // PATCH /api/admin/courses/:id
  if (method === 'PATCH' && seg[2] === 'courses' && seg[3] && !seg[4]) {
    const got = collectCourse(body, { creating: false });
    if ('error' in got) return D({ error: got.error }, 400);
    const keys = Object.keys(got.fields);
    if (!keys.length) return D({ error: '没有要改的内容' }, 400);
    const sets = keys.map((k, i) => `${k}=$${i + 1}`);
    const vals: unknown[] = keys.map(k => got.fields[k]);
    vals.push(seg[3]);
    const r = await query(
      `UPDATE courses SET ${sets.join(',')}, updated_at=now()
        WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    return D({ course: card(r.rows[0]) });
  }

  // POST /api/admin/courses/:id/review
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'review' && !seg[5]) {
    const decision = str(body.decision, 20);
    if (decision !== 'approve' && decision !== 'reject') {
      return D({ error: 'decision 只能是 approve 或 reject' }, 400);
    }
    const cur = await query('SELECT status FROM courses WHERE id=$1', [seg[3]]);
    if (!cur.rowCount) return D({ error: 'not found' }, 404);
    const next = decision === 'approve' ? 'published' : 'draft';
    const r = await query(
      `UPDATE courses SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(),
              updated_at=now() WHERE id=$4 RETURNING *`,
      [next, str(body.note, 500) || null, user!.id, seg[3]]);
    return D({ course: card(r.rows[0]) });
  }

  // POST /api/admin/courses/:id/lessons
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'lessons' && !seg[5]) {
    const title = str(body.title, 120);
    if (!title) return D({ error: '请填写课节标题' }, 400);
    const dm = body.duration_minutes === undefined ? 0 : Number(body.duration_minutes);
    if (!Number.isInteger(dm) || dm < 0 || dm > 100000) return D({ error: '课节时长不合法' }, 400);
    const c = await query('SELECT 1 FROM courses WHERE id=$1', [seg[3]]);
    if (!c.rowCount) return D({ error: 'not found' }, 404);
    const r = await query(
      `INSERT INTO course_lessons (course_id,position,title,summary,duration_minutes)
       VALUES ($1,(SELECT COALESCE(MAX(position),0)+1 FROM course_lessons WHERE course_id=$1),
               $2,$3,$4) RETURNING *`,
      [seg[3], title, str(body.summary, 1000) || null, dm]);
    return D({ lesson: lessonRow(r.rows[0]) });
  }

  // POST /api/admin/courses/:id/lessons/reorder
  if (method === 'POST' && seg[2] === 'courses' && seg[3] && seg[4] === 'lessons'
      && seg[5] === 'reorder' && !seg[6]) {
    const ids = body.lesson_ids;
    if (!Array.isArray(ids) || !ids.length) return D({ error: 'lesson_ids 需要是非空数组' }, 400);
    const cur = await query('SELECT id FROM course_lessons WHERE course_id=$1', [seg[3]]);
    const have = (cur.rows as any[]).map(x => Number(x.id)).sort((a, b) => a - b);
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
        await c.query('UPDATE course_lessons SET position=$1 WHERE id=$2 AND course_id=$3',
                      [i + 1, ids[i], seg[3]]);
      }
    });
    return D({ ok: true });
  }

  // PATCH /api/admin/lessons/:id
  if (method === 'PATCH' && seg[2] === 'lessons' && seg[3] && !seg[4]) {
    const sets: string[] = [], vals: unknown[] = [];
    if (typeof body.title === 'string') {
      const t = str(body.title, 120);
      if (!t) return D({ error: '请填写课节标题' }, 400);
      sets.push(`title=$${sets.length + 1}`); vals.push(t);
    }
    if (typeof body.summary === 'string') {
      sets.push(`summary=$${sets.length + 1}`); vals.push(str(body.summary, 1000) || null);
    }
    if (body.duration_minutes !== undefined) {
      const dm = Number(body.duration_minutes);
      if (!Number.isInteger(dm) || dm < 0 || dm > 100000) return D({ error: '课节时长不合法' }, 400);
      sets.push(`duration_minutes=$${sets.length + 1}`); vals.push(dm);
    }
    if (!sets.length) return D({ error: '没有要改的内容' }, 400);
    vals.push(seg[3]);
    const r = await query(
      `UPDATE course_lessons SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    return D({ lesson: lessonRow(r.rows[0]) });
  }

  // DELETE /api/admin/lessons/:id
  if (method === 'DELETE' && seg[2] === 'lessons' && seg[3] && !seg[4]) {
    const done = await tx(async (c) => {
      const r = await c.query(
        'DELETE FROM course_lessons WHERE id=$1 RETURNING course_id', [seg[3]]);
      if (!r.rowCount) return false;
      // 删掉中间一节会在 position 序列里留个洞。重排成连续的,免得前端拿 position
      // 当序号显示时出现 "01 03 04"。
      const rest = await c.query(
        'SELECT id FROM course_lessons WHERE course_id=$1 ORDER BY position',
        [(r.rows[0] as any).course_id]);
      for (let i = 0; i < rest.rows.length; i++) {
        await c.query('UPDATE course_lessons SET position=$1 WHERE id=$2',
                      [i + 1, (rest.rows[i] as any).id]);
      }
      return true;
    });
    return done ? D({ ok: true }) : D({ error: 'not found' }, 404);
  }

  // GET /api/admin/course-enrollments?status=
  if (method === 'GET' && seg[2] === 'course-enrollments' && !seg[3]) {
    const status = qs.get('status');
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      return D({ error: '未知的申请状态' }, 400);
    }
    // 逐列点名,不用 u.* —— 站长审报名不需要申请人邮箱,别让这个端点变成第二个
    // 会吐他人邮箱的接口(目前唯一一个是 GET /api/admin/users/pending)。
    const r = await query(
      `SELECT e.id, e.status, e.message, e.created_at,
              c.slug AS course_slug, c.title AS course_title,
              u.username, u.display_name
         FROM course_enrollments e
         JOIN courses c ON c.id=e.course_id
         JOIN users u ON u.id=e.user_id
        WHERE ($1::text IS NULL OR e.status=$1)
        ORDER BY e.created_at DESC`, [status || null]);
    return D({ requests: (r.rows as any[]).map(x => ({
      id: x.id, status: x.status, message: x.message, created_at: x.created_at,
      course: { slug: x.course_slug, title: x.course_title },
      user: { username: x.username, display_name: x.display_name },
    })) });
  }

  // POST /api/admin/course-enrollments/:id/review
  if (method === 'POST' && seg[2] === 'course-enrollments' && seg[3]
      && seg[4] === 'review' && !seg[5]) {
    const decision = str(body.decision, 20);
    if (decision !== 'approve' && decision !== 'reject') {
      return D({ error: 'decision 只能是 approve 或 reject' }, 400);
    }
    const cur = await query(
      `SELECT e.id, e.status, e.user_id, c.title
         FROM course_enrollments e JOIN courses c ON c.id=e.course_id
        WHERE e.id=$1`, [seg[3]]);
    if (!cur.rowCount) return D({ error: 'not found' }, 404);
    if ((cur.rows[0] as any).status !== 'pending') return D({ error: '这条申请已经处理过了' }, 409);
    const next = decision === 'approve' ? 'approved' : 'rejected';
    await query(
      `UPDATE course_enrollments SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3`,
      [next, user!.id, seg[3]]);
    await notify((cur.rows[0] as any).user_id, 'course',
      next === 'approved' ? '课程学习申请已通过' : '课程学习申请未通过',
      next === 'approved'
        ? `你可以开始学习「${(cur.rows[0] as any).title}」了。`
        : `「${(cur.rows[0] as any).title}」这次没有通过,可以过段时间再申请。`);
    return D({ ok: true, status: next });
  }
};

export default courseRoutes;
