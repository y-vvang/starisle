// 导师目录 + 指导申请。
// 两条不变量是这组测试存在的主要理由:
//   ① 导师的 contact_email 只能出现在站长视角的响应里(上游在列表/详情剥了它,
//      却在申请列表端点漏了回来,任何人 curl 一下就能拿到);
//   ② 申请人身份只由会话决定,请求体里的 user_id 之类一律无效(上游所有 IDOR
//      都源于从 body/query 读 memberId 这一个习惯)。
import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { resetDb, query } from './helpers/db';
import { call } from './helpers/call';
import { mkUser } from './helpers/seed';

const SECRET = 'mentor-private@example.invalid';

async function mkMentor(root: any, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/admin/mentors', {
    name: '徐老师', title: '课程导师', bio: '带过几届学生做数学建模。',
    contact_email: SECRET,
    courses: [{ title: '微积分', total_hours: 18, level: '中级' }],
    ...extra,
  }, root);
  assert.strictEqual(r.status, 200, '建导师应成功');
  return r.data.mentor;
}

const APPLY = { interest: '想做数学建模方向', background: '学过一点 Python',
                questions: '怎么选题?', weekly_hours: '2-4h' };

beforeEach(resetDb);

// ---------- contact_email 不能泄露 ----------

test('公开列表不含导师邮箱', async () => {
  const root = await mkUser('root', 'admin');
  await mkMentor(root);
  const r = await call('GET', '/api/mentors');
  assert.strictEqual(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes(SECRET), '公开列表泄露了导师邮箱');
});

test('公开详情不含导师邮箱', async () => {
  const root = await mkUser('root', 'admin');
  const m = await mkMentor(root);
  const r = await call('GET', `/api/mentors/${m.slug}`);
  assert.ok(!JSON.stringify(r.data).includes(SECRET), '公开详情泄露了导师邮箱');
});

test('普通成员看自己的申请列表时也拿不到导师邮箱', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('GET', '/api/my/mentor-requests', {}, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.requests.length, 1);
  assert.ok(!JSON.stringify(r.data).includes(SECRET), '成员视角泄露了导师邮箱');
});

test('只有站长的申请列表带导师邮箱(供线下对接)', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('GET', '/api/admin/mentor-requests', {}, root);
  assert.strictEqual(r.status, 200);
  assert.ok(JSON.stringify(r.data).includes(SECRET), '站长应当看得到导师邮箱');
});

// ---------- 申请:只收四个非 PII 字段 ----------

test('申请只接受四个字段,PII 一律不落库', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const r = await call('POST', `/api/mentors/${m.slug}/requests`, {
    ...APPLY,
    // 上游表单收的这些,这里一个都不该进库
    real_name: '张三', contact: '13800138000', school: '北京市十一学校', grade: '高一', age: 16,
  }, alice);
  assert.strictEqual(r.status, 200);
  const row = await query('SELECT * FROM mentor_requests WHERE id=$1', [r.data.request.id]);
  const cols = Object.keys(row.rows[0]);
  for (const bad of ['real_name', 'contact', 'school', 'grade', 'age']) {
    assert.ok(!cols.includes(bad), `mentor_requests 不该有 ${bad} 列`);
  }
  const blob = JSON.stringify(row.rows[0]);
  assert.ok(!blob.includes('13800138000') && !blob.includes('张三'),
            'PII 不该以任何形式落库');
});

test('interest 必填', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const r = await call('POST', `/api/mentors/${m.slug}/requests`, { interest: '  ' }, alice);
  assert.strictEqual(r.status, 400);
});

test('weekly_hours 只接受四个档位', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const r = await call('POST', `/api/mentors/${m.slug}/requests`,
                       { ...APPLY, weekly_hours: '每天八小时' }, alice);
  assert.strictEqual(r.status, 400);
});

test('身份来自会话:请求体里的 user_id 无效', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const m = await mkMentor(root);
  await call('POST', `/api/mentors/${m.slug}/requests`, { ...APPLY, user_id: bob.id }, alice);
  const row = await query('SELECT user_id FROM mentor_requests');
  assert.strictEqual(Number((row.rows[0] as any).user_id), Number(alice.id), '应记在会话用户名下');
});

test('未登录不能申请', async () => {
  const root = await mkUser('root', 'admin');
  const m = await mkMentor(root);
  assert.strictEqual((await call('POST', `/api/mentors/${m.slug}/requests`, APPLY)).status, 401);
});

test('重复申请 → 409', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  assert.strictEqual(r.status, 409);
});

// ---------- 撤回 ----------

test('可以撤回自己的待审申请', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('POST', `/api/mentor-requests/${a.data.request.id}/withdraw`, {}, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM mentor_requests')).rows[0].n, 0);
});

test('撤回别人的申请 → 404(掩护,不用 403)', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('POST', `/api/mentor-requests/${a.data.request.id}/withdraw`, {}, bob);
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM mentor_requests')).rows[0].n, 1);
});

test('已通过的申请不能再撤回 → 409', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  await call('POST', `/api/admin/mentor-requests/${a.data.request.id}/review`,
             { decision: 'approve' }, root);
  const r = await call('POST', `/api/mentor-requests/${a.data.request.id}/withdraw`, {}, alice);
  assert.strictEqual(r.status, 409);
});

// ---------- 站长四态工作流 ----------

test('通过 → 通知申请人;再确认已对接 → completed 且再通知一次', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const id = a.data.request.id;

  const ok = await call('POST', `/api/admin/mentor-requests/${id}/review`, { decision: 'approve' }, root);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.status, 'approved');

  const done = await call('POST', `/api/admin/mentor-requests/${id}/complete`, {}, root);
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.data.status, 'completed');

  const n = await query(`SELECT kind FROM notifications WHERE user_id=$1`, [alice.id]);
  assert.strictEqual(n.rowCount, 2, '通过与对接各发一条');
  assert.ok(n.rows.every((x: any) => x.kind === 'mentor'));
});

test('没通过的申请不能直接标记为已对接 → 409', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const r = await call('POST', `/api/admin/mentor-requests/${a.data.request.id}/complete`, {}, root);
  assert.strictEqual(r.status, 409);
});

test('重复审批 → 409', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  const id = a.data.request.id;
  await call('POST', `/api/admin/mentor-requests/${id}/review`, { decision: 'reject' }, root);
  const r = await call('POST', `/api/admin/mentor-requests/${id}/review`, { decision: 'approve' }, root);
  assert.strictEqual(r.status, 409);
});

test('被拒之后可以重新申请', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  const a = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  await call('POST', `/api/admin/mentor-requests/${a.data.request.id}/review`,
             { decision: 'reject' }, root);
  const again = await call('POST', `/api/mentors/${m.slug}/requests`, APPLY, alice);
  assert.strictEqual(again.status, 200);
});

// ---------- 目录与筛选 ----------

test('隐藏的导师不出现在公开列表', async () => {
  const root = await mkUser('root', 'admin');
  const m = await mkMentor(root);
  await mkMentor(root, { name: '杨老师', contact_email: 'y@example.invalid' });
  assert.strictEqual((await call('GET', '/api/mentors')).data.mentors.length, 2);
  await call('PATCH', `/api/admin/mentors/${m.id}`, { status: 'hidden' }, root);
  assert.strictEqual((await call('GET', '/api/mentors')).data.mentors.length, 1);
});

test('按课程筛选导师', async () => {
  const root = await mkUser('root', 'admin');
  await mkMentor(root);
  await mkMentor(root, { name: '梁老师', contact_email: 'l@example.invalid',
                         courses: [{ title: '信息论', total_hours: 12, level: '高级' }] });
  const r = await call('GET', '/api/mentors', {}, null, 'course=信息论');
  assert.strictEqual(r.data.mentors.length, 1);
  assert.strictEqual(r.data.mentors[0].name, '梁老师');
});

test('导师详情带课程清单', async () => {
  const root = await mkUser('root', 'admin');
  const m = await mkMentor(root);
  const r = await call('GET', `/api/mentors/${m.slug}`);
  assert.strictEqual(r.data.mentor.courses.length, 1);
  assert.strictEqual(r.data.mentor.courses[0].title, '微积分');
  assert.strictEqual(r.data.mentor.courses[0].total_hours, 18);
});

test('普通成员碰不了导师管理端点', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const m = await mkMentor(root);
  for (const [meth, p] of [
    ['POST', '/api/admin/mentors'],
    ['PATCH', `/api/admin/mentors/${m.id}`],
    ['GET', '/api/admin/mentor-requests'],
  ] as const) {
    const r = await call(meth, p, { name: 'x' }, alice);
    assert.ok(r.status === 401 || r.status === 403, `${meth} ${p} 应拒绝,实得 ${r.status}`);
  }
});

// ---------- 合作机构 ----------

test('合作机构公开可读,按分类筛选', async () => {
  const root = await mkUser('root', 'admin');
  await call('POST', '/api/admin/partners', { name: '某某中学', category: '中学', monogram: '某中' }, root);
  await call('POST', '/api/admin/partners', { name: '某某大学', category: '大学', monogram: '某大' }, root);
  const all = await call('GET', '/api/partners');
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.data.partners.length, 2);
  const mid = await call('GET', '/api/partners', {}, null, 'category=中学');
  assert.strictEqual(mid.data.partners.length, 1);
});

test('机构分类只接受三档', async () => {
  const root = await mkUser('root', 'admin');
  const r = await call('POST', '/api/admin/partners', { name: 'x', category: '幼儿园' }, root);
  assert.strictEqual(r.status, 400);
});
