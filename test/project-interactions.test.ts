import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { resetDb, query } from './helpers/db';
import { call } from './helpers/call';
import { mkUser, PROJECT_NEW as NEW } from './helpers/seed';
import { needsAdmin } from '../app/auth/guard';

// 1x1 透明 PNG 的真实 base64,不要求端点解码,只要求格式与长度校验通过。
const POSTER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function mkApprovedProject(owner: any, admin: any) {
  const c = await call('POST', '/api/projects', NEW, owner);
  const slug: string = c.data.project.slug;
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, admin);
  return { slug, pid: Number(pid) };
}

beforeEach(resetDb);

// ---------- 海报:上传 / 删除,owner-or-admin only ----------

test('海报:项目成员(非 owner)不能上传 → 403', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);
  await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, bob);
  assert.strictEqual(r.status, 403);
  const p = await query('SELECT poster FROM projects WHERE slug=$1', [slug]);
  assert.strictEqual((p.rows[0] as any).poster, null);
});

test('海报:owner 能上传', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, alice);
  assert.strictEqual(r.status, 200);
  const p = await query('SELECT poster FROM projects WHERE slug=$1', [slug]);
  assert.strictEqual((p.rows[0] as any).poster, POSTER);
});

test('海报:admin 能上传(即使不是 owner)', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, root);
  assert.strictEqual(r.status, 200);
});

test('海报:匿名不能上传 → 401', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER });
  assert.strictEqual(r.status, 401);
});

test('海报:非 owner 探测别人未过审项目的海报端点 → 404(不能用 403 泄露项目存在)', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = c.data.project.slug; // 从未审核,仍是 pending

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, bob);
  assert.strictEqual(r.status, 404);
});

test('海报:超过大小上限 → 400', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);
  const huge = 'data:image/png;base64,' + 'A'.repeat(800000);

  const r = await call('POST', `/api/projects/${slug}/poster`, { poster: huge }, alice);
  assert.strictEqual(r.status, 400);
});

test('海报:owner 能删除,非 owner 成员不能', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);
  await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);
  await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, alice);

  const denied = await call('DELETE', `/api/projects/${slug}/poster`, {}, bob);
  assert.strictEqual(denied.status, 403);

  const ok = await call('DELETE', `/api/projects/${slug}/poster`, {}, alice);
  assert.strictEqual(ok.status, 200);
  const p = await query('SELECT poster FROM projects WHERE slug=$1', [slug]);
  assert.strictEqual((p.rows[0] as any).poster, null);
});

// ---------- 关注:任何登录用户,幂等 ----------

test('关注两次只留一行', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug, pid } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/follow`, {}, bob);
  await call('POST', `/api/projects/${slug}/follow`, {}, bob);
  const rows = await query('SELECT * FROM project_follows WHERE project_id=$1 AND user_id=$2', [pid, bob.id]);
  assert.strictEqual(rows.rowCount, 1);
});

test('取消关注会删掉那一行', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug, pid } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/follow`, {}, bob);
  const un = await call('POST', `/api/projects/${slug}/follow`, { follow: false }, bob);
  assert.strictEqual(un.status, 200);
  assert.strictEqual(un.data.following, false);
  const rows = await query('SELECT * FROM project_follows WHERE project_id=$1 AND user_id=$2', [pid, bob.id]);
  assert.strictEqual(rows.rowCount, 0);
});

test('关注数统计准确', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const { slug } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/follow`, {}, bob);
  await call('POST', `/api/projects/${slug}/follow`, {}, carol);
  const r = await call('GET', `/api/projects/${slug}/follow`, {}, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.followers, 2);
  assert.strictEqual(r.data.following, false); // alice(owner)自己没关注
});

test('关注:匿名 401', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);
  assert.strictEqual((await call('POST', `/api/projects/${slug}/follow`)).status, 401);
  assert.strictEqual((await call('GET', `/api/projects/${slug}/follow`)).status, 401);
});

// ---------- 加入申请 ----------

test('重复的待处理申请 → 409,被拒绝后可以重新提交', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);

  const first = await call('POST', `/api/projects/${slug}/join`, { message: '我想加入' }, bob);
  assert.strictEqual(first.status, 200);
  const dup = await call('POST', `/api/projects/${slug}/join`, { message: '再申请一次' }, bob);
  assert.strictEqual(dup.status, 409);

  const list = await call('GET', `/api/projects/${slug}/join-requests`, {}, alice);
  const reqId = list.data.requests.find((r: any) => r.username === 'bob').id;
  const decided = await call('POST', `/api/join-requests/${reqId}/decision`, { decision: 'reject' }, alice);
  assert.strictEqual(decided.status, 200);

  const again = await call('POST', `/api/projects/${slug}/join`, { message: '再来一次' }, bob);
  assert.strictEqual(again.status, 200);
});

test('通过申请:project_members 新增一行,且申请状态标记为 accepted(同一事务)', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug, pid } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/join`, { message: '我想加入' }, bob);
  const list = await call('GET', `/api/projects/${slug}/join-requests`, {}, alice);
  const reqId = list.data.requests.find((r: any) => r.username === 'bob').id;

  const r = await call('POST', `/api/join-requests/${reqId}/decision`, { decision: 'accept' }, alice);
  assert.strictEqual(r.status, 200);

  const mem = await query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [pid, bob.id]);
  assert.strictEqual(mem.rowCount, 1);
  assert.strictEqual((mem.rows[0] as any).role, 'member');

  const jr = await query('SELECT status,decided_by FROM project_join_requests WHERE id=$1', [reqId]);
  assert.strictEqual((jr.rows[0] as any).status, 'accepted');
  assert.strictEqual(Number((jr.rows[0] as any).decided_by), Number(alice.id));

  const n = await query(`SELECT * FROM notifications WHERE user_id=$1 AND kind='project'`, [bob.id]);
  assert.ok(n.rowCount! >= 1);
});

test('非 owner(且非 admin)不能处理申请 → 403', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const { slug } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/join`, { message: 'hi' }, bob);
  const list = await call('GET', `/api/projects/${slug}/join-requests`, {}, alice);
  const reqId = list.data.requests[0].id;

  const r = await call('POST', `/api/join-requests/${reqId}/decision`, { decision: 'accept' }, carol);
  assert.strictEqual(r.status, 403);
});

test('admin 也能处理申请', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/join`, { message: 'hi' }, bob);
  const list = await call('GET', `/api/projects/${slug}/join-requests`, {}, alice);
  const reqId = list.data.requests[0].id;

  const r = await call('POST', `/api/join-requests/${reqId}/decision`, { decision: 'accept' }, root);
  assert.strictEqual(r.status, 200);
});

test('owner 不能申请加入自己的项目 → 400', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkApprovedProject(alice, root);

  const r = await call('POST', `/api/projects/${slug}/join`, {}, alice);
  assert.strictEqual(r.status, 400);
});

test('已经是成员的人不能再申请加入 → 409', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);
  await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);

  const r = await call('POST', `/api/projects/${slug}/join`, {}, bob);
  assert.strictEqual(r.status, 409);
});

test('加入申请:匿名 401,列表非 owner 403,未过审项目对非 owner 404', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);

  assert.strictEqual((await call('POST', `/api/projects/${slug}/join`)).status, 401);
  assert.strictEqual((await call('GET', `/api/projects/${slug}/join-requests`)).status, 401);
  assert.strictEqual((await call('GET', `/api/projects/${slug}/join-requests`, {}, bob)).status, 403);

  const c2 = await call('POST', '/api/projects', NEW, alice); // 未过审
  const slug2 = c2.data.project.slug;
  assert.strictEqual((await call('POST', `/api/projects/${slug2}/join`, {}, bob)).status, 404);
});

test('发起人收到"有人申请加入"的通知', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);

  await call('POST', `/api/projects/${slug}/join`, { message: 'hi' }, bob);
  const n = await query(`SELECT * FROM notifications WHERE user_id=$1 AND kind='project'`, [alice.id]);
  assert.ok(n.rowCount! >= 1);
});

// ---------- 项目详情里的海报 / 关注 / 申请状态 ----------

test('项目详情:携带 poster、followers、(登录时)following 与 pending_join_request', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const { slug } = await mkApprovedProject(alice, root);
  await call('POST', `/api/projects/${slug}/poster`, { poster: POSTER }, alice);
  await call('POST', `/api/projects/${slug}/follow`, {}, bob);
  await call('POST', `/api/projects/${slug}/join`, { message: 'hi' }, bob);

  const anon = await call('GET', `/api/projects/${slug}`);
  assert.strictEqual(anon.data.project.poster, POSTER);
  assert.strictEqual(anon.data.project.followers, 1);
  assert.strictEqual(anon.data.project.following, undefined);

  const asBob = await call('GET', `/api/projects/${slug}`, {}, bob);
  assert.strictEqual(asBob.data.project.following, true);
  assert.strictEqual(asBob.data.project.pending_join_request, true);
});

// ---------- 路由守卫:/decision 不撞 ADMIN_VERBS 的 'decide' 保留字 ----------

test('guard:join-requests 的 decision 端点不需要站长身份(owner 能直接过网关)', () => {
  assert.strictEqual(
    needsAdmin('POST', '/api/join-requests/1/decision'.split('/').filter(Boolean)),
    false);
});
