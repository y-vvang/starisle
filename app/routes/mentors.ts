import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, tx, pgCode } from '../db/pool';
import { mentorCourses, mentorRequests, mentors, partnerOrgs, users } from '../db/schema';
import { uniqueSlug } from '../lib/slug';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const HOURS = new Set(['<2h', '2-4h', '4-6h', '>6h']);
const LEVELS = new Set(['初级', '中级', '高级']);
const CATEGORIES = new Set(['中学', '大学', '企业']);

// ★ 公开序列化。contact_email 不在这里,也不该在任何面向非站长的响应里出现。
// 写成一个函数而不是每个端点各剥各的 —— 上游正是因为逐端点手剥,在
// /api/mentors 与 /api/mentors/:id 剥掉了,却在申请列表端点又漏了回来。
const publicMentor = (m: { id: number; slug: string; name: string;
                           title: string | null; org: string | null; bio: string | null },
                      courses?: { title: string; total_hours: number | null; level: string | null }[]) => ({
  id: m.id, slug: m.slug, name: m.name, title: m.title, org: m.org, bio: m.bio,
  courses: courses || [],
});
const courseRow = (c: { title: string; total_hours: number | null; level: string | null }) =>
  ({ title: c.title, total_hours: c.total_hours, level: c.level });

async function coursesOf(ids: number[]) {
  if (!ids.length) return new Map<string, { title: string; total_hours: number | null; level: string | null }[]>();
  const r = await db.select({
    mentor_id: mentorCourses.mentor_id, title: mentorCourses.title,
    total_hours: mentorCourses.total_hours, level: mentorCourses.level,
  }).from(mentorCourses)
    .where(sql`${mentorCourses.mentor_id} = ANY(${sql.raw(`ARRAY[${ids.map(Number).join(',')}]::bigint[]`)})`)
    .orderBy(mentorCourses.mentor_id, mentorCourses.sort, mentorCourses.id);
  const map = new Map<string, { title: string; total_hours: number | null; level: string | null }[]>();
  for (const c of r) {
    if (!map.has(String(c.mentor_id))) map.set(String(c.mentor_id), []);
    map.get(String(c.mentor_id))!.push(courseRow(c));
  }
  return map;
}

// 建/改导师时一并写课程条目。整表替换而不是增量 —— 后台是整份表单提交的。
function parseCourses(v: unknown):
    { error: string } | { value: { title: string; total_hours: number | null; level: string | null }[] | undefined } {
  if (v === undefined) return { value: undefined };
  if (!Array.isArray(v)) return { error: '课程清单需要是一个列表' };
  if (v.length > 40) return { error: '课程清单最多 40 条' };
  const out: { title: string; total_hours: number | null; level: string | null }[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: '课程条目要写成对象' };
    const title = str((x as any).title, 120);
    if (!title) return { error: '课程条目要有标题' };
    let th: number | null = null;
    if ((x as any).total_hours != null && (x as any).total_hours !== '') {
      th = Number((x as any).total_hours);
      if (!Number.isInteger(th) || th < 0 || th > 10000) return { error: '课时不合法' };
    }
    const level = (x as any).level == null || (x as any).level === '' ? null : str((x as any).level, 10);
    if (level && !LEVELS.has(level)) return { error: '难度只能是初级/中级/高级' };
    out.push({ title, total_hours: th, level });
  }
  return { value: out };
}

const mentorRoutes: RouteHandler = async (ctx, D) => {
  const { method, seg, body, user, query: qs } = ctx;
  if (seg[0] !== 'api') return;

  // ============ 公开 / 成员 ============

  // GET /api/mentors?course=
  if (method === 'GET' && seg[1] === 'mentors' && !seg[2]) {
    const course = qs.get('course');
    const r = await db.select().from(mentors)
      .where(and(
        eq(mentors.status, 'active'),
        // EXISTS 子查询保持原样(比 builder 的半连接嵌套更直白)
        course ? sql`EXISTS (SELECT 1 FROM mentor_courses c WHERE c.mentor_id = ${mentors.id} AND c.title = ${course})` : undefined,
      ))
      .orderBy(mentors.sort, mentors.id);
    const map = await coursesOf(r.map(m => m.id));
    return D({ mentors: r.map(m => publicMentor(m, map.get(String(m.id)))) });
  }

  // GET /api/mentors/:slug
  if (method === 'GET' && seg[1] === 'mentors' && seg[2] && !seg[3]) {
    const r = await db.select().from(mentors).where(eq(mentors.slug, seg[2]));
    const m = r[0];
    // 隐藏的导师只有站长看得到,其余人一律 404(与项目/课程同一条掩护规则)
    if (!m || (m.status !== 'active' && !(user && user.role === 'admin'))) {
      return D({ error: 'not found' }, 404);
    }
    const map = await coursesOf([m.id]);
    let myRequest = null;
    if (user) {
      const q = await db.select({
        id: mentorRequests.id, status: mentorRequests.status, created_at: mentorRequests.created_at,
      }).from(mentorRequests)
        .where(and(eq(mentorRequests.mentor_id, m.id), eq(mentorRequests.user_id, user.id)))
        .orderBy(desc(mentorRequests.created_at)).limit(1);
      myRequest = q[0] || null;
    }
    return D({ mentor: publicMentor(m, map.get(String(m.id))), my_request: myRequest });
  }

  // POST /api/mentors/:slug/requests
  if (method === 'POST' && seg[1] === 'mentors' && seg[2] && seg[3] === 'requests' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const r = await db.select({ id: mentors.id }).from(mentors)
      .where(and(eq(mentors.slug, seg[2]), eq(mentors.status, 'active')));
    if (!r.length) return D({ error: 'not found' }, 404);

    // 只取这四个字段。请求体里的 real_name / contact / school / grade / user_id 等
    // 一律不看 —— 申请人是谁由会话决定,其余的本项目不收。
    const interest = str(body.interest, 1000);
    if (!interest) return D({ error: '请写一句你想做的方向' }, 400);
    const weekly = body.weekly_hours == null || body.weekly_hours === ''
      ? null : str(body.weekly_hours, 10);
    if (weekly && !HOURS.has(weekly)) return D({ error: '每周可投入时间不合法' }, 400);

    try {
      const ins = await db.insert(mentorRequests).values({
        mentor_id: r[0].id, user_id: user.id, interest,
        background: str(body.background, 1000) || null,
        questions: str(body.questions, 1000) || null,
        weekly_hours: weekly,
      }).returning({
        id: mentorRequests.id, status: mentorRequests.status, created_at: mentorRequests.created_at,
      });
      return D({ request: ins[0] });
    } catch (e) {
      // pgCode 兼容 drizzle 包装(.cause.code)与裸 pg(.code)
      if (pgCode(e) === '23505') return D({ error: '你已经向这位导师提交过申请了' }, 409);
      throw e;
    }
  }

  // GET /api/my/mentor-requests
  if (method === 'GET' && seg[1] === 'my' && seg[2] === 'mentor-requests' && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    // 逐列点名:这里绝不能把 mentors 整表列进 select —— 那会把 contact_email
    // 带给申请人。
    const r = await db.select({
      id: mentorRequests.id, status: mentorRequests.status,
      interest: mentorRequests.interest, background: mentorRequests.background,
      questions: mentorRequests.questions, weekly_hours: mentorRequests.weekly_hours,
      review_note: mentorRequests.review_note, created_at: mentorRequests.created_at,
      mentor_slug: mentors.slug, mentor_name: mentors.name, mentor_title: mentors.title,
    }).from(mentorRequests)
      .innerJoin(mentors, eq(mentors.id, mentorRequests.mentor_id))
      .where(eq(mentorRequests.user_id, user.id))
      .orderBy(desc(mentorRequests.created_at));
    return D({ requests: r.map(x => ({
      id: x.id, status: x.status, interest: x.interest, background: x.background,
      questions: x.questions, weekly_hours: x.weekly_hours, review_note: x.review_note,
      created_at: x.created_at,
      mentor: { slug: x.mentor_slug, name: x.mentor_name, title: x.mentor_title },
    })) });
  }

  // POST /api/mentor-requests/:id/withdraw
  // 用"通配符后跟一段字面量"的形状而不是 DELETE /api/mentor-requests/:id —— 后者的
  // 通配符落在末段,会再往公开白名单里加一条高危规则(见 test/guard.test.ts 的钉桩用例)。
  // 与既有的 POST /api/join-requests/:id/decision 也是同一种写法。
  if (method === 'POST' && seg[1] === 'mentor-requests' && seg[2]
      && seg[3] === 'withdraw' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const r = await db.select().from(mentorRequests).where(eq(mentorRequests.id, Number(seg[2])));
    const q = r[0];
    // 不是自己的一律 404 而不是 403 —— 403 会告诉对方"这条申请存在"。
    if (!q || Number(q.user_id) !== Number(user.id)) return D({ error: 'not found' }, 404);
    if (q.status !== 'pending') return D({ error: '已经处理过的申请不能撤回' }, 409);
    await db.delete(mentorRequests).where(eq(mentorRequests.id, Number(seg[2])));
    return D({ ok: true });
  }

  // GET /api/partners?category=
  if (method === 'GET' && seg[1] === 'partners' && !seg[2]) {
    const cat = qs.get('category');
    if (cat && !CATEGORIES.has(cat)) return D({ error: '未知的机构分类' }, 400);
    const r = await db.select().from(partnerOrgs)
      .where(cat ? eq(partnerOrgs.category, cat) : undefined)
      .orderBy(partnerOrgs.sort, partnerOrgs.id);
    return D({ partners: r.map(p => ({
      id: p.id, slug: p.slug, name: p.name, category: p.category,
      logo_path: p.logo_path, website: p.website, cooperation: p.cooperation,
      monogram: p.monogram,
    })) });
  }

  // ============ 站长 ============

  if (seg[1] !== 'admin') return;

  // POST /api/admin/mentors
  if (method === 'POST' && seg[2] === 'mentors' && !seg[3]) {
    const name = str(body.name, 60);
    if (!name) return D({ error: '请填写导师姓名' }, 400);
    const cs = parseCourses(body.courses);
    if ('error' in cs) return D({ error: cs.error }, 400);
    const slug = await uniqueSlug(name, 'mentors');
    const m = await tx(async (c) => {
      const r = await c.insert(mentors).values({
        slug, name,
        title: str(body.title, 60) || null, org: str(body.org, 120) || null,
        bio: str(body.bio, 2000) || null, contact_email: str(body.contact_email, 200) || null,
        sort: Number.isInteger(body.sort) ? body.sort as number : 0,
      }).returning();
      for (const [i, x] of (cs.value || []).entries()) {
        await c.insert(mentorCourses).values({
          mentor_id: r[0].id, title: x.title, total_hours: x.total_hours, level: x.level, sort: i,
        });
      }
      return r[0];
    });
    const map = await coursesOf([m.id]);
    return D({ mentor: publicMentor(m, map.get(String(m.id))) });
  }

  // PATCH /api/admin/mentors/:id
  if (method === 'PATCH' && seg[2] === 'mentors' && seg[3] && !seg[4]) {
    const sets: Record<string, unknown> = {};
    for (const [k, max] of [['name', 60], ['title', 60], ['org', 120],
                            ['bio', 2000], ['contact_email', 200]] as const) {
      if (typeof body[k] === 'string') sets[k] = str(body[k], max) || null;
    }
    if (body.status !== undefined) {
      const s = str(body.status, 20);
      if (s !== 'active' && s !== 'hidden') return D({ error: '未知的导师状态' }, 400);
      sets.status = s;
    }
    if (Number.isInteger(body.sort)) sets.sort = body.sort;
    const cs = parseCourses(body.courses);
    if ('error' in cs) return D({ error: cs.error }, 400);
    if (!Object.keys(sets).length && cs.value === undefined) return D({ error: '没有要改的内容' }, 400);

    const done = await tx(async (c) => {
      if (Object.keys(sets).length) {
        sets.updated_at = sql`now()`;
        const r = await c.update(mentors).set(sets)
          .where(eq(mentors.id, Number(seg[3]))).returning({ id: mentors.id });
        if (!r.length) return false;
      } else {
        const r = await c.select({ one: sql`1` }).from(mentors).where(eq(mentors.id, Number(seg[3])));
        if (!r.length) return false;
      }
      if (cs.value !== undefined) {
        // 整表替换:后台是整份表单提交的,增量合并反而会留下没人删得掉的旧条目。
        await c.delete(mentorCourses).where(eq(mentorCourses.mentor_id, Number(seg[3])));
        for (const [i, x] of cs.value.entries()) {
          await c.insert(mentorCourses).values({
            mentor_id: Number(seg[3]), title: x.title, total_hours: x.total_hours, level: x.level, sort: i,
          });
        }
      }
      return true;
    });
    return done ? D({ ok: true }) : D({ error: 'not found' }, 404);
  }

  // GET /api/admin/mentor-requests?status=
  if (method === 'GET' && seg[2] === 'mentor-requests' && !seg[3]) {
    const status = qs.get('status');
    if (status && !['pending', 'approved', 'rejected', 'completed'].includes(status)) {
      return D({ error: '未知的申请状态' }, 400);
    }
    // 只有这一处会 SELECT 导师的 contact_email —— 站长要靠它在站外联系导师。
    // 申请人侧只给 username/display_name,不 join 邮箱:站长审这个不需要申请人邮箱。
    const r = await db.select({
      id: mentorRequests.id, status: mentorRequests.status,
      interest: mentorRequests.interest, background: mentorRequests.background,
      questions: mentorRequests.questions, weekly_hours: mentorRequests.weekly_hours,
      review_note: mentorRequests.review_note, created_at: mentorRequests.created_at,
      mentor_name: mentors.name, mentor_email: mentors.contact_email,
      username: users.username, display_name: users.display_name,
    }).from(mentorRequests)
      .innerJoin(mentors, eq(mentors.id, mentorRequests.mentor_id))
      .innerJoin(users, eq(users.id, mentorRequests.user_id))
      .where(status ? eq(mentorRequests.status, status) : undefined)
      .orderBy(desc(mentorRequests.created_at));
    return D({ requests: r.map(x => ({
      id: x.id, status: x.status, interest: x.interest, background: x.background,
      questions: x.questions, weekly_hours: x.weekly_hours, review_note: x.review_note,
      created_at: x.created_at,
      mentor: { name: x.mentor_name, contact_email: x.mentor_email },
      user: { username: x.username, display_name: x.display_name },
    })) });
  }

  // POST /api/admin/mentor-requests/:id/review
  if (method === 'POST' && seg[2] === 'mentor-requests' && seg[3]
      && seg[4] === 'review' && !seg[5]) {
    const decision = str(body.decision, 20);
    if (decision !== 'approve' && decision !== 'reject') {
      return D({ error: 'decision 只能是 approve 或 reject' }, 400);
    }
    const cur = await db.select({
      id: mentorRequests.id, status: mentorRequests.status,
      user_id: mentorRequests.user_id, name: mentors.name,
    }).from(mentorRequests)
      .innerJoin(mentors, eq(mentors.id, mentorRequests.mentor_id))
      .where(eq(mentorRequests.id, Number(seg[3])));
    if (!cur.length) return D({ error: 'not found' }, 404);
    if (cur[0].status !== 'pending') return D({ error: '这条申请已经处理过了' }, 409);
    const next = decision === 'approve' ? 'approved' : 'rejected';
    await db.update(mentorRequests).set({
      status: next, review_note: str(body.note, 500) || null,
      decided_by: user!.id, decided_at: sql`now()`,
    }).where(eq(mentorRequests.id, Number(seg[3])));
    await notify(cur[0].user_id, 'mentor',
      next === 'approved' ? '导师指导申请已通过' : '导师指导申请未通过',
      next === 'approved'
        ? `站长会尽快帮你和「${cur[0].name}」对接。`
        : `这次没有通过,可以过段时间再申请。`);
    return D({ ok: true, status: next });
  }

  // POST /api/admin/mentor-requests/:id/complete
  if (method === 'POST' && seg[2] === 'mentor-requests' && seg[3]
      && seg[4] === 'complete' && !seg[5]) {
    const cur = await db.select({
      id: mentorRequests.id, status: mentorRequests.status,
      user_id: mentorRequests.user_id, name: mentors.name,
    }).from(mentorRequests)
      .innerJoin(mentors, eq(mentors.id, mentorRequests.mentor_id))
      .where(eq(mentorRequests.id, Number(seg[3])));
    if (!cur.length) return D({ error: 'not found' }, 404);
    if (cur[0].status !== 'approved') {
      return D({ error: '只有已通过的申请才能标记为已对接' }, 409);
    }
    await db.update(mentorRequests).set({
      status: 'completed', decided_by: user!.id, decided_at: sql`now()`,
    }).where(eq(mentorRequests.id, Number(seg[3])));
    await notify(cur[0].user_id, 'mentor', '导师已联系',
      `站长已经把你和「${cur[0].name}」对接上了,接下来直接沟通就好。`);
    return D({ ok: true, status: 'completed' });
  }

  // POST /api/admin/partners
  if (method === 'POST' && seg[2] === 'partners' && !seg[3]) {
    const name = str(body.name, 120);
    if (!name) return D({ error: '请填写机构名称' }, 400);
    const category = str(body.category, 10);
    if (!CATEGORIES.has(category)) return D({ error: '机构分类只能是中学/大学/企业' }, 400);
    const slug = await uniqueSlug(name, 'partner_orgs');
    const r = await db.insert(partnerOrgs).values({
      slug, name, category,
      logo_path: str(body.logo_path, 300) || null, website: str(body.website, 300) || null,
      cooperation: str(body.cooperation, 2000) || null, monogram: str(body.monogram, 10) || null,
      sort: Number.isInteger(body.sort) ? body.sort as number : 0,
    }).returning();
    return D({ partner: r[0] });
  }

  // PATCH /api/admin/partners/:id
  if (method === 'PATCH' && seg[2] === 'partners' && seg[3] && !seg[4]) {
    const sets: Record<string, unknown> = {};
    for (const [k, max] of [['name', 120], ['logo_path', 300], ['website', 300],
                            ['cooperation', 2000], ['monogram', 10]] as const) {
      if (typeof body[k] === 'string') sets[k] = str(body[k], max) || null;
    }
    if (body.category !== undefined) {
      const c = str(body.category, 10);
      if (!CATEGORIES.has(c)) return D({ error: '机构分类只能是中学/大学/企业' }, 400);
      sets.category = c;
    }
    if (Number.isInteger(body.sort)) sets.sort = body.sort;
    if (!Object.keys(sets).length) return D({ error: '没有要改的内容' }, 400);
    sets.updated_at = sql`now()`;
    const r = await db.update(partnerOrgs).set(sets)
      .where(eq(partnerOrgs.id, Number(seg[3]))).returning();
    if (!r.length) return D({ error: 'not found' }, 404);
    return D({ partner: r[0] });
  }
};

export default mentorRoutes;
