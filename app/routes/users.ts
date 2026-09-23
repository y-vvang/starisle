import { query } from '../db/pool';
import { destroyUserSessions } from '../auth/session';
import { notify } from './notifications';
import { str } from '../lib/str';
import type { RouteHandler } from './types';

const card = (u: any) => ({ id: u.id, username: u.username, display_name: u.display_name,
                            bio: u.bio, repo_url: u.repo_url, created_at: u.created_at });

const userRoutes: RouteHandler = async (ctx, D) => {
  const { method, path, seg, body } = ctx;

  if (method === 'GET' && path === '/api/members') {
    const r = await query(
      `SELECT id,username,display_name,bio,repo_url,created_at FROM users
        WHERE status='approved' ORDER BY created_at DESC`);
    return D({ members: r.rows.map(card) });
  }

  if (method === 'GET' && seg[1] === 'members' && seg[2] && !seg[3]) {
    const r = await query(
      `SELECT id,username,display_name,bio,repo_url,created_at FROM users
        WHERE username=$1 AND status='approved'`, [seg[2]]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    const u = r.rows[0];
    const pj = await query(
      `SELECT p.slug,p.name,p.tagline,p.domain_id FROM projects p
         JOIN project_members pm ON pm.project_id=p.id
        WHERE pm.user_id=$1 AND p.status='approved' ORDER BY p.created_at DESC`, [u.id]);
    return D({ member: card(u), projects: pj.rows });
  }

  if (method === 'GET' && path === '/api/admin/users/pending') {
    const r = await query(
      `SELECT id,username,display_name,email,repo_url,apply_note,created_at FROM users
        WHERE status='pending' ORDER BY created_at ASC`);
    return D({ users: r.rows });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'review') {
    const id = Number(seg[3]);
    const r = await query('SELECT id,status,username FROM users WHERE id=$1', [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    if ((r.rows[0] as any).status !== 'pending') return D({ error: '该申请已处理' }, 409);

    // 与 join-requests 的 /decision 端点同一条规则:decision 只能是 approve/reject,
    // 其它任何值(空对象、拼写错、大小写不对)一律 400,不能落到"非 approve 就默认 rejected"
    // —— 那会把一次格式错误的请求变成对申请人不可逆的永久拒绝(见修复报告 Fix 2)。
    const status = body.decision === 'approve' ? 'approved'
                 : body.decision === 'reject' ? 'rejected' : null;
    if (!status) return D({ error: '决定只能是 approve 或 reject' }, 400);
    await query(
      `UPDATE users SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
        WHERE id=$4`,
      [status, String(body.note || '').slice(0, 300), ctx.user!.id, id]);

    await notify(id, 'account',
      status === 'approved' ? '申请已通过' : '申请未通过',
      status === 'approved' ? '欢迎加入星屿,现在可以登录了。' : '这次未通过,可补充作品后再申请。');
    return D({ ok: true, status, username: (r.rows[0] as any).username });
  }

  if (method === 'POST' && seg[1] === 'admin' && seg[2] === 'users' && seg[3] && seg[4] === 'suspend') {
    const id = Number(seg[3]);
    if (id === ctx.user!.id) return D({ error: '不能停用自己' }, 400);
    const r = await query(
      `UPDATE users SET status='suspended', updated_at=now() WHERE id=$1 RETURNING username`, [id]);
    if (!r.rowCount) return D({ error: 'not found' }, 404);
    await destroyUserSessions(id);          // 停用即踢下线
    return D({ ok: true, username: (r.rows[0] as any).username });
  }
};

export default userRoutes;
