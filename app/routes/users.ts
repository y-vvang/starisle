import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/pool';
import { projects, projectMembers, users } from '../db/schema';
import { parsePagination, pageMeta } from '../lib/pagination';
import { destroyUserSessions } from '../auth/session';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const card = (u: { id: number; username: string; display_name: string;
                    bio: string | null; repo_url: string | null; created_at: Date }) =>
  ({ id: u.id, username: u.username, display_name: u.display_name,
     bio: u.bio, repo_url: u.repo_url, created_at: u.created_at });

const userRoutes: RouteHandler = async (ctx, D) => {
  const { method, path, seg, body, query: qs } = ctx;

  // GET /api/members?page=&per_page=
  if (method === 'GET' && path === '/api/members') {
    const { page, perPage } = parsePagination(qs);
    const where = eq(users.status, 'approved');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
    const r = await db.select({
      id: users.id, username: users.username, display_name: users.display_name,
      bio: users.bio, repo_url: users.repo_url, created_at: users.created_at,
    }).from(users).where(where)
      .orderBy(desc(users.created_at), desc(users.id))
      .limit(perPage).offset((page - 1) * perPage);
    return D({ members: r.map(card), pagination: pageMeta(n, page, perPage) });
  }

  if (method === 'GET' && seg[1] === 'members' && seg[2] && !seg[3]) {
    const r = await db.select({
      id: users.id, username: users.username, display_name: users.display_name,
      bio: users.bio, repo_url: users.repo_url, created_at: users.created_at,
    }).from(users).where(and(eq(users.username, seg[2]), eq(users.status, 'approved')));
    if (!r.length) return D({ error: 'not found' }, 404);
    const u = r[0];
    const pj = await db.select({
      slug: projects.slug, name: projects.name, tagline: projects.tagline, domain_id: projects.domain_id,
    }).from(projects)
      .innerJoin(projectMembers, eq(projectMembers.project_id, projects.id))
      .where(and(eq(projectMembers.user_id, u.id), eq(projects.status, 'approved')))
      .orderBy(desc(projects.created_at));
    return D({ member: card(u), projects: pj });
  }

  // GET /api/admin/users/pending?page=&per_page=
  if (method === 'GET' && path === '/api/admin/users/pending') {
    const { page, perPage } = parsePagination(qs);
    const where = eq(users.status, 'pending');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
    const r = await db.select({
      id: users.id, username: users.username, display_name: users.display_name,
      email: users.email, repo_url: users.repo_url, apply_note: users.apply_note,
      created_at: users.created_at,
    }).from(users).where(where)
      .orderBy(asc(users.created_at), asc(users.id))
      .limit(perPage).offset((page - 1) * perPage);
    return D({ users: r, pagination: pageMeta(n, page, perPage) });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'review') {
    const id = Number(seg[3]);
    const r = await db.select({ id: users.id, status: users.status, username: users.username })
      .from(users).where(eq(users.id, id));
    if (!r.length) return D({ error: 'not found' }, 404);
    if (r[0].status !== 'pending') return D({ error: '该申请已处理' }, 409);

    // 与 join-requests 的 /decision 端点同一条规则:decision 只能是 approve/reject,
    // 其它任何值(空对象、拼写错、大小写不对)一律 400,不能落到"非 approve 就默认 rejected"
    // —— 那会把一次格式错误的请求变成对申请人不可逆的永久拒绝(见修复报告 Fix 2)。
    const status = body.decision === 'approve' ? 'approved'
                 : body.decision === 'reject' ? 'rejected' : null;
    if (!status) return D({ error: '决定只能是 approve 或 reject' }, 400);
    await db.update(users).set({
      status,
      review_note: String(body.note || '').slice(0, 300),
      reviewed_by: ctx.user!.id,
      reviewed_at: sql`now()`, updated_at: sql`now()`,
    }).where(eq(users.id, id));

    await notify(id, 'account',
      status === 'approved' ? '申请已通过' : '申请未通过',
      status === 'approved' ? '欢迎加入星屿,现在可以登录了。' : '这次未通过,可补充作品后再申请。');
    return D({ ok: true, status, username: r[0].username });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'suspend') {
    const id = Number(seg[3]);
    if (id === ctx.user!.id) return D({ error: '不能停用自己' }, 400);
    const r = await db.update(users).set({ status: 'suspended', updated_at: sql`now()` })
      .where(eq(users.id, id)).returning({ username: users.username });
    if (!r.length) return D({ error: 'not found' }, 404);
    await destroyUserSessions(id);          // 停用即踢下线
    return D({ ok: true, username: r[0].username });
  }
};

export default userRoutes;
