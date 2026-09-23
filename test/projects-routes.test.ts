import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { resetDb, query } from './helpers/db';
import { call } from './helpers/call';
import { mkUser, PROJECT_NEW as NEW } from './helpers/seed';

beforeEach(resetDb);

test('发起项目 → pending,且不出现在公开列表', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', NEW, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.project.status, 'pending');
  const pub = await call('GET', '/api/projects');
  assert.strictEqual(pub.data.projects.length, 0);
});

test('发起人被记为 owner,且自动进 project_members', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', NEW, alice);
  const p = await query('SELECT owner_id FROM projects WHERE slug=$1', [r.data.project.slug]);
  assert.strictEqual(Number((p.rows[0] as any).owner_id), Number(alice.id));
  const pm = await query(
    `SELECT role FROM project_members pm JOIN projects p ON p.id=pm.project_id
      WHERE p.slug=$1 AND pm.user_id=$2`, [r.data.project.slug, alice.id]);
  assert.strictEqual((pm.rows[0] as any).role, 'owner');
});

test('匿名不能发起项目', async () => {
  const r = await call('POST', '/api/projects', NEW);
  assert.strictEqual(r.status, 401);
});

test('站长通过后进入公开列表并通知发起人', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;

  const rev = await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  assert.strictEqual(rev.status, 200);

  const pub = await call('GET', '/api/projects');
  assert.strictEqual(pub.data.projects.length, 1);

  const n = await query(`SELECT * FROM notifications WHERE user_id=$1 AND kind='project'`, [alice.id]);
  assert.strictEqual(n.rowCount, 1);
});

test('重复审核 → 409', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  const again = await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  assert.strictEqual(again.status, 409);
});

// 修复回归(Fix 2):与用户审核同一个 bug——旧实现 `body.decision === 'approve'
// ? 'approved' : 'rejected'` 把任何格式错误的请求都静默判成"未通过",且不可逆
// (再次调用 409,项目也没法用同一个 slug 重新提交)。这里补上校验,与
// join-requests 的 /decision 端点、users.ts 的用户审核同一条规则。
test('格式错误的 decision(如 {})→ 400,不落到默认 rejected,行也不变', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;
  const r = await call('POST', `/api/admin/projects/${pid}/review`, {}, root);
  assert.strictEqual(r.status, 400);
  const p = await query('SELECT status FROM projects WHERE id=$1', [pid]);
  assert.strictEqual((p.rows[0] as any).status, 'pending');
});

test('decision 拼写/大小写错误(如 "Approve")→ 400,不落到默认 rejected', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [c.data.project.slug])).rows[0].id;
  const r = await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'Approve' }, root);
  assert.strictEqual(r.status, 400);
  const p = await query('SELECT status FROM projects WHERE id=$1', [pid]);
  assert.strictEqual((p.rows[0] as any).status, 'pending');
});

test('owner 能看到自己未过审的项目详情,别人看不到', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);

  assert.strictEqual((await call('GET', `/api/projects/${slug}`, {}, alice)).status, 200);
  assert.strictEqual((await call('GET', `/api/projects/${slug}`, {}, bob)).status, 404);
  assert.strictEqual((await call('GET', `/api/projects/${slug}`)).status, 404);
});

test('只有 owner 能改项目', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);
  // 先过审:非 owner 的 403 只在"项目已公开"时才成立,否则会撞上下面新加的掩护规则
  // (未过审项目对非 owner/非站长一律 404,理由见 PATCH 掩护那两个测试)。
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  assert.strictEqual((await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, bob)).status, 403);
  assert.strictEqual((await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, alice)).status, 200);
});

test('PATCH:非 owner 探测别人未过审的项目 → 404(不能用 403 泄露项目存在)', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c); // 从未审核,仍是 pending
  const r = await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, bob);
  assert.strictEqual(r.status, 404);
});

test('PATCH:非 owner 改别人已过审的项目 → 仍是 403(没有矫枉过正把所有权限错都变 404)', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  const r = await call('PATCH', `/api/projects/${slug}`, { tagline: '改了' }, bob);
  assert.strictEqual(r.status, 403);
});

test('改名不改 slug', async () => {
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);
  await call('PATCH', `/api/projects/${slug}`, { name: '完全不同的名字' }, alice);
  const r = await query('SELECT slug,name FROM projects WHERE slug=$1', [slug]);
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual((r.rows[0] as any).name, '完全不同的名字');
});

test('owner 能加成员,非 owner 不能', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);
  // 先过审,理由同上面 PATCH 那个测试:非 owner 的 403 只在项目已公开时成立。
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);

  assert.strictEqual((await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, carol)).status, 403);
  const ok = await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);
  assert.strictEqual(ok.status, 200);
  const dup = await call('POST', `/api/projects/${slug}/members`, { username: 'bob' }, alice);
  assert.strictEqual(dup.status, 409);
  assert.ok(bob);
});

test('加成员:非 owner 探测别人未过审的项目 → 404(不能用 403 泄露项目存在)', async () => {
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c); // 从未审核,仍是 pending
  const r = await call('POST', `/api/projects/${slug}/members`, { username: 'carol' }, bob);
  assert.strictEqual(r.status, 404);
});

test('加成员:非 owner 加别人已过审项目的成员 → 仍是 403(没有矫枉过正把所有权限错都变 404)', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const c = await call('POST', '/api/projects', NEW, alice);
  const slug = r_slug(c);
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);
  const r = await call('POST', `/api/projects/${slug}/members`, { username: 'carol' }, bob);
  assert.strictEqual(r.status, 403);
});

test('非法 domain_id → 400', async () => {
  const alice = await mkUser('alice');
  const r = await call('POST', '/api/projects', { ...NEW, domain_id: 'nonexistent' }, alice);
  assert.strictEqual(r.status, 400);
});

test('待审列表只有站长能看', async () => {
  const alice = await mkUser('alice');
  await call('POST', '/api/projects', NEW, alice);
  assert.strictEqual((await call('GET', '/api/admin/projects/pending', {}, alice)).status, 403);
  const root = await mkUser('root', 'admin');
  const r = await call('GET', '/api/admin/projects/pending', {}, root);
  assert.strictEqual(r.data.projects.length, 1);
});

// 小工具:从创建响应里取 slug(原 JS 版直接内联 r.data.project.slug,这里
// 抽出来只是让上面几个用例少一层括号,语义不变)。
function r_slug(c: { data: { project: { slug: string } } }) {
  return c.data.project.slug;
}
