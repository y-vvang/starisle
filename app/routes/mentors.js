'use strict';
const { query, tx } = require('../db/pool');
const { uniqueSlug } = require('../lib/slug');
const { notify } = require('./notifications');

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const HOURS = new Set(['<2h', '2-4h', '4-6h', '>6h']);
const LEVELS = new Set(['初级', '中级', '高级']);
const CATEGORIES = new Set(['中学', '大学', '企业']);

// ★ 公开序列化。contact_email 不在这里,也不该在任何面向非站长的响应里出现。
// 写成一个函数而不是每个端点各剥各的 —— 上游正是因为逐端点手剥,在
// /api/mentors 与 /api/mentors/:id 剥掉了,却在申请列表端点又漏了回来。
const publicMentor = (m, courses) => ({
  id: m.id, slug: m.slug, name: m.name, title: m.title, org: m.org, bio: m.bio,
  courses: courses || [],
});
const courseRow = c => ({ title: c.title, total_hours: c.total_hours, level: c.level });

async function coursesOf(ids) {
  if (!ids.length) return new Map();
  const r = await query(
    'SELECT * FROM mentor_courses WHERE mentor_id = ANY($1) ORDER BY mentor_id, sort, id', [ids]);
  const map = new Map();
  for (const c of r.rows) {
    if (!map.has(String(c.mentor_id))) map.set(String(c.mentor_id), []);
    map.get(String(c.mentor_id)).push(courseRow(c));
  }
  return map;
}

// 建/改导师时一并写课程条目。整表替换而不是增量 —— 后台是整份表单提交的。
function parseCourses(v) {
  if (v === undefined) return { value: undefined };
  if (!Array.isArray(v)) return { error: '课程清单需要是一个列表' };
  if (v.length > 40) return { error: '课程清单最多 40 条' };
  const out = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: '课程条目要写成对象' };
    const title = str(x.title, 120);
    if (!title) return { error: '课程条目要有标题' };
    let th = null;
    if (x.total_hours != null && x.total_hours !== '') {
      th = Number(x.total_hours);
      if (!Number.isInteger(th) || th < 0 || th > 10000) return { error: '课时不合法' };
    }
    const level = x.level == null || x.level === '' ? null : str(x.level, 10);
    if (level && !LEVELS.has(level)) return { error: '难度只能是初级/中级/高级' };
    out.push({ title, total_hours: th, level });
  }
  return { value: out };
}

module.exports = async function mentorRoutes(ctx, D) {
  const { method, seg, body, user, query: qs } = ctx;
  if (seg[0] !== 'api') return;

  // ============ 公开 / 成员 ============

  // GET /api/mentors?course=
  if (method === 'GET' && seg[1] === 'mentors' && !seg[2]) {
    const course = qs.get('course');
    const r = await query(
      `SELECT m.* FROM mentors m
        WHERE m.status='active'
          AND ($1::text IS NULL OR EXISTS (
                SELECT 1 FROM mentor_courses c WHERE c.mentor_id=m.id AND c.title=$1))
        ORDER BY m.sort, m.id`, [course || null]);
    const map = await coursesOf(r.rows.map(m => m.id));
    return D({ mentors: r.rows.map(m => publicMentor(m, map.get(String(m.id)))) });
  }

  // GET /api/mentors/:slug
  if (method === 'GET' && seg[1] === 'mentors' && seg[2] && !seg[3]) {
    const r = await query('SELECT * FROM mentors WHERE slug=$1', [seg[2]]);
    const m = r.rows[0];
    // 隐藏的导师只有站长看得到,其余人一律 404(与项目/课程同一条掩护规则)
    if (!m || (m.status !== 'active' && !(user && user.role === 'admin'))) {
      return D({ error: 'not found' }, 404);
    }
    const map = await coursesOf([m.id]);
    let myRequest = null;
    if (user) {
      const q = await query(
        `SELECT id,status,created_at FROM mentor_requests
          WHERE mentor_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`, [m.id, user.id]);
      myRequest = q.rows[0] || null;
    }
    return D({ mentor: publicMentor(m, map.get(String(m.id))), my_request: myRequest });
  }

  // POST /api/mentors/:slug/requests
  if (method === 'POST' && seg[1] === 'mentors' && seg[2] && seg[3] === 'requests' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const r = await query(`SELECT id FROM mentors WHERE slug=$1 AND status='active'`, [seg[2]]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);

    // 只取这四个字段。请求体里的 real_name / contact / school / grade / user_id 等
    // 一律不看 —— 申请人是谁由会话决定,其余的本项目不收。
    const interest = str(body.interest, 1000);
    if (!interest) return D({ error: '请写一句你想做的方向' }, 400);
    const weekly = body.weekly_hours == null || body.weekly_hours === ''
      ? null : str(body.weekly_hours, 10);
    if (weekly && !HOURS.has(weekly)) return D({ error: '每周可投入时间不合法' }, 400);

    try {
      const ins = await query(
        `INSERT INTO mentor_requests (mentor_id,user_id,interest,background,questions,weekly_hours)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,status,created_at`,
        [r.rows[0].id, user.id, interest,
         str(body.background, 1000) || null, str(body.questions, 1000) || null, weekly]);
      return D({ request: ins.rows[0] });
    } catch (e) {
      if (e && e.code === '23505') return D({ error: '你已经向这位导师提交过申请了' }, 409);
      throw e;
    }
  }

  // GET /api/my/mentor-requests
  if (method === 'GET' && seg[1] === 'my' && seg[2] === 'mentor-requests' && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    // 逐列点名:这里绝不能 SELECT m.* —— 那会把 contact_email 带给申请人。
    const r = await query(
      `SELECT q.id, q.status, q.interest, q.background, q.questions, q.weekly_hours,
              q.review_note, q.created_at,
              m.slug AS mentor_slug, m.name AS mentor_name, m.title AS mentor_title
         FROM mentor_requests q JOIN mentors m ON m.id=q.mentor_id
        WHERE q.user_id=$1 ORDER BY q.created_at DESC`, [user.id]);
    return D({ requests: r.rows.map(x => ({
      id: x.id, status: x.status, interest: x.interest, background: x.background,
      questions: x.questions, weekly_hours: x.weekly_hours, review_note: x.review_note,
      created_at: x.created_at,
      mentor: { slug: x.mentor_slug, name: x.mentor_name, title: x.mentor_title },
    })) });
  }

  // POST /api/mentor-requests/:id/withdraw
  // 用"通配符后跟一段字面量"的形状而不是 DELETE /api/mentor-requests/:id —— 后者的
  // 通配符落在末段,会再往公开白名单里加一条高危规则(见 test/guard.test.js 的钉桩用例)。
  // 与既有的 POST /api/join-requests/:id/decision 也是同一种写法。
  if (method === 'POST' && seg[1] === 'mentor-requests' && seg[2]
      && seg[3] === 'withdraw' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const r = await query('SELECT * FROM mentor_requests WHERE id=$1', [seg[2]]);
    const q = r.rows[0];
    // 不是自己的一律 404 而不是 403 —— 403 会告诉对方"这条申请存在"。
    if (!q || Number(q.user_id) !== Number(user.id)) return D({ error: 'not found' }, 404);
    if (q.status !== 'pending') return D({ error: '已经处理过的申请不能撤回' }, 409);
    await query('DELETE FROM mentor_requests WHERE id=$1', [seg[2]]);
    return D({ ok: true });
  }

  // GET /api/partners?category=
  if (method === 'GET' && seg[1] === 'partners' && !seg[2]) {
    const cat = qs.get('category');
    if (cat && !CATEGORIES.has(cat)) return D({ error: '未知的机构分类' }, 400);
    const r = await query(
      `SELECT * FROM partner_orgs WHERE ($1::text IS NULL OR category=$1)
        ORDER BY sort, id`, [cat || null]);
    return D({ partners: r.rows.map(p => ({
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
    if (cs.error) return D({ error: cs.error }, 400);
    const slug = await uniqueSlug(name, 'mentors');
    const m = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO mentors (slug,name,title,org,bio,contact_email,sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [slug, name, str(body.title, 60) || null, str(body.org, 120) || null,
         str(body.bio, 2000) || null, str(body.contact_email, 200) || null,
         Number.isInteger(body.sort) ? body.sort : 0]);
      for (const [i, x] of (cs.value || []).entries()) {
        await c.query(
          `INSERT INTO mentor_courses (mentor_id,title,total_hours,level,sort)
           VALUES ($1,$2,$3,$4,$5)`, [r.rows[0].id, x.title, x.total_hours, x.level, i]);
      }
      return r.rows[0];
    });
    const map = await coursesOf([m.id]);
    return D({ mentor: publicMentor(m, map.get(String(m.id))) });
  }

  // PATCH /api/admin/mentors/:id
  if (method === 'PATCH' && seg[2] === 'mentors' && seg[3] && !seg[4]) {
    const sets = [], vals = [];
    for (const [k, max] of [['name', 60], ['title', 60], ['org', 120],
                            ['bio', 2000], ['contact_email', 200]]) {
      if (typeof body[k] === 'string') { sets.push(`${k}=$${sets.length + 1}`); vals.push(str(body[k], max) || null); }
    }
    if (body.status !== undefined) {
      const s = str(body.status, 20);
      if (s !== 'active' && s !== 'hidden') return D({ error: '未知的导师状态' }, 400);
      sets.push(`status=$${sets.length + 1}`); vals.push(s);
    }
    if (Number.isInteger(body.sort)) { sets.push(`sort=$${sets.length + 1}`); vals.push(body.sort); }
    const cs = parseCourses(body.courses);
    if (cs.error) return D({ error: cs.error }, 400);
    if (!sets.length && cs.value === undefined) return D({ error: '没有要改的内容' }, 400);

    const done = await tx(async (c) => {
      if (sets.length) {
        vals.push(seg[3]);
        const r = await c.query(
          `UPDATE mentors SET ${sets.join(',')}, updated_at=now()
            WHERE id=$${vals.length} RETURNING id`, vals);
        if (!r.rowCount) return false;
      } else {
        const r = await c.query('SELECT 1 FROM mentors WHERE id=$1', [seg[3]]);
        if (!r.rowCount) return false;
      }
      if (cs.value !== undefined) {
        // 整表替换:后台是整份表单提交的,增量合并反而会留下没人删得掉的旧条目。
        await c.query('DELETE FROM mentor_courses WHERE mentor_id=$1', [seg[3]]);
        for (const [i, x] of cs.value.entries()) {
          await c.query(
            `INSERT INTO mentor_courses (mentor_id,title,total_hours,level,sort)
             VALUES ($1,$2,$3,$4,$5)`, [seg[3], x.title, x.total_hours, x.level, i]);
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
    const r = await query(
      `SELECT q.*, m.name AS mentor_name, m.contact_email AS mentor_email,
              u.username, u.display_name
         FROM mentor_requests q
         JOIN mentors m ON m.id=q.mentor_id
         JOIN users u ON u.id=q.user_id
        WHERE ($1::text IS NULL OR q.status=$1)
        ORDER BY q.created_at DESC`, [status || null]);
    return D({ requests: r.rows.map(x => ({
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
    const cur = await query(
      `SELECT q.id,q.status,q.user_id,m.name FROM mentor_requests q
         JOIN mentors m ON m.id=q.mentor_id WHERE q.id=$1`, [seg[3]]);
    if (!cur.rowCount) return D({ error: 'not found' }, 404);
    if (cur.rows[0].status !== 'pending') return D({ error: '这条申请已经处理过了' }, 409);
    const next = decision === 'approve' ? 'approved' : 'rejected';
    await query(
      `UPDATE mentor_requests SET status=$1, review_note=$2, decided_by=$3, decided_at=now()
        WHERE id=$4`, [next, str(body.note, 500) || null, user.id, seg[3]]);
    await notify(cur.rows[0].user_id, 'mentor',
      next === 'approved' ? '导师指导申请已通过' : '导师指导申请未通过',
      next === 'approved'
        ? `站长会尽快帮你和「${cur.rows[0].name}」对接。`
        : `这次没有通过,可以过段时间再申请。`);
    return D({ ok: true, status: next });
  }

  // POST /api/admin/mentor-requests/:id/complete
  if (method === 'POST' && seg[2] === 'mentor-requests' && seg[3]
      && seg[4] === 'complete' && !seg[5]) {
    const cur = await query(
      `SELECT q.id,q.status,q.user_id,m.name FROM mentor_requests q
         JOIN mentors m ON m.id=q.mentor_id WHERE q.id=$1`, [seg[3]]);
    if (!cur.rowCount) return D({ error: 'not found' }, 404);
    if (cur.rows[0].status !== 'approved') {
      return D({ error: '只有已通过的申请才能标记为已对接' }, 409);
    }
    await query(
      `UPDATE mentor_requests SET status='completed', decided_by=$1, decided_at=now()
        WHERE id=$2`, [user.id, seg[3]]);
    await notify(cur.rows[0].user_id, 'mentor', '导师已联系',
      `站长已经把你和「${cur.rows[0].name}」对接上了,接下来直接沟通就好。`);
    return D({ ok: true, status: 'completed' });
  }

  // POST /api/admin/partners
  if (method === 'POST' && seg[2] === 'partners' && !seg[3]) {
    const name = str(body.name, 120);
    if (!name) return D({ error: '请填写机构名称' }, 400);
    const category = str(body.category, 10);
    if (!CATEGORIES.has(category)) return D({ error: '机构分类只能是中学/大学/企业' }, 400);
    const slug = await uniqueSlug(name, 'partner_orgs');
    const r = await query(
      `INSERT INTO partner_orgs (slug,name,category,logo_path,website,cooperation,monogram,sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [slug, name, category, str(body.logo_path, 300) || null, str(body.website, 300) || null,
       str(body.cooperation, 2000) || null, str(body.monogram, 10) || null,
       Number.isInteger(body.sort) ? body.sort : 0]);
    return D({ partner: r.rows[0] });
  }

  // PATCH /api/admin/partners/:id
  if (method === 'PATCH' && seg[2] === 'partners' && seg[3] && !seg[4]) {
    const sets = [], vals = [];
    for (const [k, max] of [['name', 120], ['logo_path', 300], ['website', 300],
                            ['cooperation', 2000], ['monogram', 10]]) {
      if (typeof body[k] === 'string') { sets.push(`${k}=$${sets.length + 1}`); vals.push(str(body[k], max) || null); }
    }
    if (body.category !== undefined) {
      const c = str(body.category, 10);
      if (!CATEGORIES.has(c)) return D({ error: '机构分类只能是中学/大学/企业' }, 400);
      sets.push(`category=$${sets.length + 1}`); vals.push(c);
    }
    if (Number.isInteger(body.sort)) { sets.push(`sort=$${sets.length + 1}`); vals.push(body.sort); }
    if (!sets.length) return D({ error: '没有要改的内容' }, 400);
    vals.push(seg[3]);
    const r = await query(
      `UPDATE partner_orgs SET ${sets.join(',')}, updated_at=now()
        WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    return D({ partner: r.rows[0] });
  }
};
