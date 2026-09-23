import { query, tx } from '../db/pool';
import { uniqueSlug } from '../lib/slug';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const card = (p: any) => ({ slug: p.slug, name: p.name, tagline: p.tagline, repo_url: p.repo_url,
                            domain_id: p.domain_id, status: p.status, created_at: p.created_at,
                            owner: p.owner_username ? { username: p.owner_username,
                                                        display_name: p.owner_display_name } : undefined });

// 海报存成 base64 data URI 的 text 列(不引入静态文件服务/对象存储)。
// 上限按字符数卡:700,000 字符的 data URI ≈ 512KB 解码后的原图,对一张
// 压缩过的路演海报够用;更重要的是它要留出安全余量给 server.ts 里
// BODY_LIMIT = 1e6(整个 JSON 请求体上限,约 1MB)—— 700,000 字符的图 +
// JSON 外壳还差 300,000 字节才顶到那条硬线,不会让"海报刚好卡在限制边缘"
// 变成一个诡异的 413 而不是这里给出的、说清楚原因的 400。
const POSTER_MAX_CHARS = 700_000;
const POSTER_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

// —— 详情页三块内容(02 主要工作 / 03 阶段性成果 / 04 当前需求)的校验 ——
// 上限卡在这里而不是数据库 CHECK:jsonb 的长度约束写成 SQL 既难读、报错也没法
// 告诉用户"最多 20 条"。这里的错误信息是照着能改的。
const WORK_MAX = 4000;   // 主要工作是一段话
const LIST_MAX = 20;     // 单个列表最多几条
const ITEM_MAX = 200;    // 单条文本最多几字
const SKILL_MAX = 50;    // 缺口的技能名
const NOTE_MAX = 200;    // 缺口的补充说明

const trimmed = (v: unknown): string => String(v == null ? '' : v).trim();

// 前端是多行文本框按行拆的,空行难免,直接丢弃而不是报错;
// 但类型不对(不是数组/不是字符串)一律拒绝,不静默吞掉写错的输入。
function parseStringList(v: unknown, label: string): { error: string } | { value: string[] } {
  if (!Array.isArray(v)) return { error: `${label}需要是一个列表` };
  if (v.length > LIST_MAX) return { error: `${label}最多 ${LIST_MAX} 条` };
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return { error: `${label}的每一条都必须是文本` };
    const s = x.trim();
    if (!s) continue;
    if (s.length > ITEM_MAX) return { error: `${label}单条不能超过 ${ITEM_MAX} 字` };
    out.push(s);
  }
  return { value: out };
}

function parseGaps(v: unknown): { error: string } | { value: { skill: string; note: string }[] } {
  if (!Array.isArray(v)) return { error: '当前需求需要是一个列表' };
  if (v.length > LIST_MAX) return { error: `当前需求最多 ${LIST_MAX} 条` };
  const out: { skill: string; note: string }[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      return { error: '当前需求的每一条都要写成「缺什么 + 说明」' };
    }
    const skill = trimmed((x as any).skill);
    if (!skill) return { error: '当前需求的每一条都要写清缺什么' };
    if (skill.length > SKILL_MAX) return { error: `缺口名称不能超过 ${SKILL_MAX} 字` };
    const note = trimmed((x as any).note);
    if (note.length > NOTE_MAX) return { error: `缺口说明不能超过 ${NOTE_MAX} 字` };
    out.push({ skill, note });
  }
  return { value: out };
}

// 只收请求里真的出现过的键。这样 PATCH 只传 work 不会把另外三块连带清空,
// 而显式传 [] 仍然能清空 —— "没传"和"传空"是两件事。
// jsonb 列一律传 JSON 字符串:node-postgres 会把 JS 数组当成 Postgres array 处理,
// 直接传数组会类型不匹配。
function collectContent(body: Record<string, unknown>):
    { error: string } | { fields: Record<string, string | null> } {
  const fields: Record<string, string | null> = {};
  if (typeof body.work === 'string') {
    const w = body.work.trim();
    if (w.length > WORK_MAX) return { error: `主要工作不能超过 ${WORK_MAX} 字` };
    fields.work = w || null;
  }
  for (const [key, label] of [['stack', '技术栈'], ['milestones', '阶段性成果']] as const) {
    if (body[key] === undefined) continue;
    const r = parseStringList(body[key], label);
    if ('error' in r) return { error: r.error };
    fields[key] = JSON.stringify(r.value);
  }
  if (body.gaps !== undefined) {
    const r = parseGaps(body.gaps);
    if ('error' in r) return { error: r.error };
    fields.gaps = JSON.stringify(r.value);
  }
  return { fields };
}

async function loadProject(slug: string) {
  const r = await query(
    `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
       FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.slug=$1`, [slug]);
  return (r.rows[0] as any) || null;
}

const projectRoutes: RouteHandler = async (ctx, D) => {
  const { method, path, seg, body, user } = ctx;

  if (method === 'GET' && path === '/api/projects') {
    const r = await query(
      `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
         FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.status='approved' ORDER BY p.created_at DESC`);
    return D({ projects: r.rows.map(card) });
  }

  if (method === 'POST' && path === '/api/projects') {
    if (!user) return D({ error: '请先登录' }, 401);
    const name = str(body.name, 60);
    const description = str(body.description, 4000);
    if (!name) return D({ error: '请填写项目名' }, 400);
    if (description.length < 20) return D({ error: '简介至少 20 字' }, 400);

    const domain_id = str(body.domain_id, 32) || null;
    if (domain_id) {
      const d = await query('SELECT 1 FROM domains WHERE id=$1', [domain_id]);
      if (!d.rowCount) return D({ error: '未知领域' }, 400);
    }

    const content = collectContent(body);
    if ('error' in content) return D({ error: content.error }, 400);

    const slug = await uniqueSlug(name);
    const project = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO projects (slug,name,tagline,description,repo_url,domain_id,owner_id,status,
                               work,stack,milestones,gaps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11) RETURNING *`,
        [slug, name, str(body.tagline, 120), description, str(body.repo_url, 200) || null,
         domain_id, user!.id,
         content.fields.work ?? null,
         content.fields.stack ?? '[]',
         content.fields.milestones ?? '[]',
         content.fields.gaps ?? '[]']);
      await c.query(
        `INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'owner')`,
        [(r.rows[0] as any).id, user!.id]);
      return r.rows[0] as any;
    });
    return D({ ok: true, project: card(project),
               note: '已提交,站长审核通过后上线。' });
  }

  if (method === 'GET' && seg[1] === 'projects' && seg[2] && !seg[3]) {
    const p = await loadProject(seg[2]);
    // 未过审的项目只有 owner 与站长看得到
    const maySee = p && (p.status === 'approved' ||
      (user && (Number(user.id) === Number(p.owner_id) || user.role === 'admin')));
    if (!maySee) return D({ error: 'not found' }, 404);
    const mem = await query(
      `SELECT u.username,u.display_name,pm.role FROM project_members pm
         JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1 ORDER BY pm.joined_at`, [p.id]);
    const followers = await query(
      'SELECT COUNT(*)::int AS n FROM project_follows WHERE project_id=$1', [p.id]);
    let viewerState: Record<string, boolean> = {};
    if (user) {
      const f = await query(
        'SELECT 1 FROM project_follows WHERE project_id=$1 AND user_id=$2', [p.id, user.id]);
      const j = await query(
        `SELECT 1 FROM project_join_requests WHERE project_id=$1 AND user_id=$2 AND status='pending'`,
        [p.id, user.id]);
      viewerState = { following: !!f.rowCount, pending_join_request: !!j.rowCount };
    }
    // work/stack/milestones/gaps 只在详情给,不进 card() —— 列表页用不到,
    // 让 GET /api/projects 的响应体保持小。
    return D({ project: { ...card(p), description: p.description, poster: p.poster || null,
                          work: p.work, stack: p.stack, milestones: p.milestones, gaps: p.gaps,
                          followers: (followers.rows[0] as any).n, ...viewerState },
               members: mem.rows });
  }

  if (method === 'PATCH' && seg[1] === 'projects' && seg[2] && !seg[3]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwnerOrAdmin = Number(p.owner_id) === Number(user.id) || user.role === 'admin';
    if (!isOwnerOrAdmin) {
      // 与 GET 详情同一条规则:未过审的项目不能用 403 向非 owner/非站长泄露"它存在",
      // 一律 404;只有已过审(公开)的项目,403 才不算泄密。
      if (p.status !== 'approved') return D({ error: 'not found' }, 404);
      return D({ error: '只有发起人能修改' }, 403);
    }
    const sets: string[] = [], vals: unknown[] = [];
    for (const f of ['name', 'tagline', 'description', 'repo_url']) {
      if (typeof body[f] === 'string') { sets.push(`${f}=$${sets.length + 1}`); vals.push(str(body[f], 4000)); }
    }
    if (typeof body.domain_id === 'string') {
      const d = await query('SELECT 1 FROM domains WHERE id=$1', [body.domain_id]);
      if (!d.rowCount) return D({ error: '未知领域' }, 400);
      sets.push(`domain_id=$${sets.length + 1}`); vals.push(body.domain_id);
    }
    const content = collectContent(body);
    if ('error' in content) return D({ error: content.error }, 400);
    for (const [k, v] of Object.entries(content.fields)) {
      sets.push(`${k}=$${sets.length + 1}`); vals.push(v);
    }
    if (!sets.length) return D({ error: '没有要改的内容' }, 400);
    vals.push(p.id);
    // slug 一经创建不再变更,避免外链失效
    await query(`UPDATE projects SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    return D({ ok: true });
  }

  if (method === 'POST' && seg[1] === 'projects' && seg[2] && seg[3] === 'members') {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwner = Number(p.owner_id) === Number(user.id);
    // 同一条掩护规则:未过审的项目对非 owner(哪怕是站长)一律 404,不能用 403 泄露存在。
    if (!isOwner && user.role !== 'admin' && p.status !== 'approved') {
      return D({ error: 'not found' }, 404);
    }
    if (!isOwner) return D({ error: '只有发起人能加成员' }, 403);

    const u = await query(
      `SELECT id,display_name FROM users WHERE username=$1 AND status='approved'`,
      [str(body.username, 32).toLowerCase()]);
    if (!u.rowCount) return D({ error: '没找到该成员' }, 404);

    const dup = await query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2',
                            [p.id, (u.rows[0] as any).id]);
    if (dup.rowCount) return D({ error: 'TA 已经在项目里了' }, 409);

    await query(`INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'member')`,
                [p.id, (u.rows[0] as any).id]);
    await notify((u.rows[0] as any).id, 'project', '你被加入了一个项目', `${user.display_name || user.username} 把你加进了「${p.name}」。`);
    return D({ ok: true });
  }

  // ---------- 海报:上传 / 删除,只有 owner 或站长 ----------
  if ((method === 'POST' || method === 'DELETE') &&
      seg[1] === 'projects' && seg[2] && seg[3] === 'poster' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwnerOrAdmin = Number(p.owner_id) === Number(user.id) || user.role === 'admin';
    if (!isOwnerOrAdmin) {
      // 同一条掩护规则:未过审的项目对非 owner/非站长一律 404,不能用 403 泄露存在。
      if (p.status !== 'approved') return D({ error: 'not found' }, 404);
      return D({ error: '只有发起人能改海报' }, 403);
    }

    if (method === 'DELETE') {
      await query('UPDATE projects SET poster=NULL, updated_at=now() WHERE id=$1', [p.id]);
      return D({ ok: true });
    }

    const poster = typeof body.poster === 'string' ? body.poster : '';
    if (!poster) return D({ error: '请提供海报图片' }, 400);
    if (poster.length > POSTER_MAX_CHARS) {
      return D({ error: `海报太大,编码后最多 ${POSTER_MAX_CHARS.toLocaleString('en-US')} 字符(约 512KB 原图)` }, 400);
    }
    if (!POSTER_RE.test(poster)) {
      return D({ error: '海报格式不对,需要 PNG/JPEG/WebP/GIF 的 base64 data URI' }, 400);
    }
    await query('UPDATE projects SET poster=$1, updated_at=now() WHERE id=$2', [poster, p.id]);
    return D({ ok: true });
  }

  // ---------- 关注:任何登录用户,幂等(重复关注/重复取消都不报错、不重复计数) ----------
  if ((method === 'POST' || method === 'GET') &&
      seg[1] === 'projects' && seg[2] && seg[3] === 'follow' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwnerOrAdmin = Number(p.owner_id) === Number(user.id) || user.role === 'admin';
    // 同一条掩护规则:未过审的项目对非 owner/非站长一律 404。
    if (p.status !== 'approved' && !isOwnerOrAdmin) return D({ error: 'not found' }, 404);

    if (method === 'GET') {
      const f = await query(
        'SELECT 1 FROM project_follows WHERE project_id=$1 AND user_id=$2', [p.id, user.id]);
      const cnt = await query(
        'SELECT COUNT(*)::int AS n FROM project_follows WHERE project_id=$1', [p.id]);
      return D({ following: !!f.rowCount, followers: (cnt.rows[0] as any).n });
    }

    const wantFollow = body.follow !== false;
    if (wantFollow) {
      // 复合主键(project_id,user_id)保证重复关注在数据库层面就只留一行,
      // 不是旧实现那种"裸计数器,重复 POST 就无限往上加"。
      await query(
        `INSERT INTO project_follows (project_id,user_id) VALUES ($1,$2)
         ON CONFLICT (project_id,user_id) DO NOTHING`, [p.id, user.id]);
    } else {
      await query('DELETE FROM project_follows WHERE project_id=$1 AND user_id=$2', [p.id, user.id]);
    }
    const cnt = await query('SELECT COUNT(*)::int AS n FROM project_follows WHERE project_id=$1', [p.id]);
    return D({ ok: true, following: wantFollow, followers: (cnt.rows[0] as any).n });
  }

  // ---------- 加入申请:提交 ----------
  if (method === 'POST' && seg[1] === 'projects' && seg[2] && seg[3] === 'join' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwnerOrAdmin = Number(p.owner_id) === Number(user.id) || user.role === 'admin';
    if (p.status !== 'approved' && !isOwnerOrAdmin) return D({ error: 'not found' }, 404);
    if (Number(p.owner_id) === Number(user.id)) {
      return D({ error: '发起人不能申请加入自己的项目' }, 400);
    }

    const already = await query(
      'SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2', [p.id, user.id]);
    if (already.rowCount) return D({ error: '你已经是项目成员了' }, 409);

    const dup = await query(
      `SELECT 1 FROM project_join_requests WHERE project_id=$1 AND user_id=$2 AND status='pending'`,
      [p.id, user.id]);
    if (dup.rowCount) return D({ error: '你已经提交过申请,请等待处理' }, 409);

    const message = str(body.message, 500);
    let ins;
    try {
      ins = await query(
        `INSERT INTO project_join_requests (project_id,user_id,message) VALUES ($1,$2,$3) RETURNING id`,
        [p.id, user.id, message || null]);
    } catch (e) {
      // 与上面的预检查同一条规则的数据库兜底:并发下两个请求可能都读到"没有
      // 待处理申请",这时部分唯一索引(见 002 迁移)会拒绝第二条 INSERT。
      if ((e as any)?.code === '23505') return D({ error: '你已经提交过申请,请等待处理' }, 409);
      throw e;
    }
    await notify(p.owner_id, 'project', '有人申请加入项目',
      `${user.display_name || user.username} 申请加入「${p.name}」。`);
    return D({ ok: true, id: (ins.rows[0] as any).id });
  }

  // ---------- 加入申请:列表,只有 owner 或站长能看 ----------
  if (method === 'GET' && seg[1] === 'projects' && seg[2] && seg[3] === 'join-requests' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const p = await loadProject(seg[2]);
    if (!p) return D({ error: 'not found' }, 404);
    const isOwnerOrAdmin = Number(p.owner_id) === Number(user.id) || user.role === 'admin';
    if (!isOwnerOrAdmin) {
      if (p.status !== 'approved') return D({ error: 'not found' }, 404);
      return D({ error: '只有发起人能看申请列表' }, 403);
    }
    const r = await query(
      `SELECT jr.id, jr.message, jr.status, jr.created_at, jr.decided_at,
              u.username, u.display_name
         FROM project_join_requests jr JOIN users u ON u.id = jr.user_id
        WHERE jr.project_id=$1 ORDER BY jr.created_at DESC`, [p.id]);
    return D({ requests: r.rows });
  }

  // ---------- 加入申请:处理(accept/reject),只有该项目 owner 或站长 ----------
  // 端点是 /decision 不是 /decide —— 见 app/auth/guard.ts PUBLIC_ROUTES 里那条注释:
  // 'decide' 是保留动词,撞上就会被路由守卫判成"仅站长",而这条端点的真实
  // 权限是"owner 或站长"。
  if (method === 'POST' && seg[1] === 'join-requests' && seg[2] && seg[3] === 'decision' && !seg[4]) {
    if (!user) return D({ error: '请先登录' }, 401);
    const id = Number(seg[2]);
    const r = await query(
      `SELECT jr.*, p.owner_id, p.name AS project_name
         FROM project_join_requests jr JOIN projects p ON p.id = jr.project_id
        WHERE jr.id=$1`, [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    const row = r.rows[0] as any;
    const isOwnerOrAdmin = Number(row.owner_id) === Number(user.id) || user.role === 'admin';
    if (!isOwnerOrAdmin) return D({ error: '只有发起人能处理申请' }, 403);
    if (row.status !== 'pending') return D({ error: '该申请已处理' }, 409);

    const decision = body.decision === 'accept' ? 'accepted'
                    : body.decision === 'reject' ? 'rejected' : null;
    if (!decision) return D({ error: '决定只能是 accept 或 reject' }, 400);

    // 同一事务:标记申请 + 加入 project_members,要么两个都发生,要么都不发生——
    // 不会出现"申请显示已通过,但其实没被加进项目"这种旧 bug 的新变种。
    await tx(async (c) => {
      await c.query(
        `UPDATE project_join_requests SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3`,
        [decision, user!.id, id]);
      if (decision === 'accepted') {
        await c.query(
          `INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'member')
           ON CONFLICT DO NOTHING`, [row.project_id, row.user_id]);
      }
    });

    await notify(row.user_id, 'project',
      decision === 'accepted' ? '加入申请已通过' : '加入申请未通过',
      decision === 'accepted' ? `你申请加入「${row.project_name}」已通过。`
                              : `你申请加入「${row.project_name}」未通过。`);
    return D({ ok: true, status: decision });
  }

  if (method === 'GET' && path === '/api/admin/projects/pending') {
    const r = await query(
      `SELECT p.*, u.username AS owner_username, u.display_name AS owner_display_name
         FROM projects p JOIN users u ON u.id=p.owner_id
        WHERE p.status='pending' ORDER BY p.created_at ASC`);
    return D({ projects: r.rows.map((p: any) => ({ ...card(p), id: p.id, description: p.description })) });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'projects' && seg[3] && seg[4] === 'review') {
    const id = Number(seg[3]);
    const r = await query('SELECT id,name,status,owner_id FROM projects WHERE id=$1', [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    if ((r.rows[0] as any).status !== 'pending') return D({ error: '该项目已处理' }, 409);

    // 同一条规则(见 users.ts 的用户审核 与 join-requests 的 /decision):
    // decision 只能是 approve/reject,其它值一律 400,不能默认落到 rejected——
    // 那会把一次格式错误的请求变成对项目不可逆的永久拒绝。
    const status = body.decision === 'approve' ? 'approved'
                 : body.decision === 'reject' ? 'rejected' : null;
    if (!status) return D({ error: '决定只能是 approve 或 reject' }, 400);
    await query(
      `UPDATE projects SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
        WHERE id=$4`,
      [status, String(body.note || '').slice(0, 300), ctx.user!.id, id]);
    await notify((r.rows[0] as any).owner_id, 'project',
      status === 'approved' ? '项目已上线' : '项目未通过',
      status === 'approved' ? `你发起的「${(r.rows[0] as any).name}」已通过审核。`
                            : `「${(r.rows[0] as any).name}」这次未通过,可补充后重新提交。`);
    return D({ ok: true, status, name: (r.rows[0] as any).name });
  }
};

export default projectRoutes;
