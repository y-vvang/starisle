// 分页改造的钉桩:默认值、per_page 夹紧、越界页、total 与筛选叠加、
// domain_counts、?q= 的 ILIKE 转义、?status= 多值与非法值 400。
import { test, beforeEach } from 'bun:test';
import assert from 'node:assert';
import { resetDb, query } from './helpers/db';
import { call } from './helpers/call';
import { mkUser, PROJECT_NEW } from './helpers/seed';

const pg = 'SELECT pagination FROM x'; // noop placeholder → 下方直接用 call()

beforeEach(resetDb);

// 造一个已过审项目(直接 UPDATE status 绕过审核端点,与 project-content 同法)
async function mkApprovedProject(owner: any, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/projects', { ...PROJECT_NEW, ...extra }, owner);
  assert.strictEqual(r.status, 200, '建项目应成功');
  await query(`UPDATE projects SET status='approved' WHERE slug=$1`, [r.data.project.slug]);
  return r.data.project;
}

// ---------- 分页参数语义 ----------

test('projects 默认分页:meta 正确,total 是全库 approved 数', async () => {
  const alice = await mkUser('alice');
  await mkApprovedProject(alice);
  await mkApprovedProject(alice, { name: 'Lumen 二号' });
  const r = await call('GET', '/api/projects');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.projects.length, 2);
  assert.deepStrictEqual(r.data.pagination, { page: 1, per_page: 20, total: 2, total_pages: 1 });
  // 新兄弟键必须存在;domain_counts 是"每领域有多少个 approved 项目"
  assert.deepStrictEqual(r.data.domain_counts, { edu: 2 });
});

test('per_page 夹紧到 [1,100](999 → 100),不影响 meta 里的 per_page', async () => {
  const alice = await mkUser('alice');
  for (const n of ['一', '二', '三']) {
    await mkApprovedProject(alice, { name: 'Lumen ' + n });
  }
  const r = await call('GET', '/api/projects', {}, null, 'page=1&per_page=999');
  assert.strictEqual(r.data.pagination.per_page, 100);
  assert.strictEqual(r.data.projects.length, 3); // 只有 3 条数据
  // 非数字也回到默认
  const bad = await call('GET', '/api/projects', {}, null, 'page=oops&per_page=oops');
  assert.strictEqual(bad.data.pagination.page, 1);
  assert.strictEqual(bad.data.pagination.per_page, 20);
});

test('越界页返回空列表,pagination 仍然正确', async () => {
  const alice = await mkUser('alice');
  await mkApprovedProject(alice);
  const r = await call('GET', '/api/projects', {}, null, 'page=5&per_page=2');
  assert.strictEqual(r.data.projects.length, 0);
  assert.deepStrictEqual(r.data.pagination, { page: 5, per_page: 2, total: 1, total_pages: 1 });
});

test('跨页:per_page=2 + 3 条数据 → 第二页 1 条,排序稳定', async () => {
  const alice = await mkUser('alice');
  for (const n of ['甲', '乙', '丙']) {
    await mkApprovedProject(alice, { name: 'Lumen ' + n });
  }
  const p1 = await call('GET', '/api/projects', {}, null, 'per_page=2&page=1');
  const p2 = await call('GET', '/api/projects', {}, null, 'per_page=2&page=2');
  assert.strictEqual(p1.data.projects.length, 2);
  assert.strictEqual(p2.data.projects.length, 1);
  assert.strictEqual(p2.data.pagination.total_pages, 2);
  // 3 个项目同名同刻创建(同一事务里逐条插入,created_at 可能同一微秒),
  // 没有 id tiebreaker 时两页可能重叠 —— 断言两页无交集
  const slugs1 = new Set(p1.data.projects.map((x: any) => x.slug));
  for (const p of p2.data.projects) {
    assert.ok(!slugs1.has(p.slug), '第二页不应重复第一页的项目:' + p.slug);
  }
});

// ---------- ?domain= 筛选 ----------

test('?domain= 过滤 total;domain_counts 不受 ?domain= 影响', async () => {
  const alice = await mkUser('alice');
  await mkApprovedProject(alice, { domain_id: 'edu' });
  await mkApprovedProject(alice, { domain_id: 'edu', name: 'Lumen 二号' });
  await mkApprovedProject(alice, { domain_id: 'agent', name: 'Lumen 三号' });

  const filtered = await call('GET', '/api/projects', {}, null, 'domain=edu');
  assert.strictEqual(filtered.data.projects.length, 2);
  assert.strictEqual(filtered.data.pagination.total, 2);
  // counts 仍然是全库视图(agent 的项目没丢)
  assert.deepStrictEqual(filtered.data.domain_counts, { edu: 2, agent: 1 });

  const bad = await call('GET', '/api/projects', {}, null, 'domain=nonexistent');
  assert.strictEqual(bad.status, 400);
});

// ---------- ?q= 四字段搜索 + ILIKE 转义 ----------

const COURSE_NEW = { title: '临时课', track: 'math', subject: '', summary: '',
                     description: '', instructors: '', audience: '', total_hours: 4 };
async function mkPublishedCourse(root: any, extra: Record<string, unknown> = {}) {
  const c = await call('POST', '/api/admin/courses', { ...COURSE_NEW, ...extra }, root);
  assert.strictEqual(c.status, 200, '建课应成功');
  return c.data.course;
}

test('?q= 命中 title/summary/instructors 四字段', async () => {
  const root = await mkUser('root', 'admin');
  const mk = async (c: Record<string, unknown>) => {
    const r = await call('POST', '/api/admin/courses', { ...COURSE_NEW, ...c }, root);
    assert.strictEqual(r.status, 200);
    // 公开列表只回 published
    await call('POST', `/api/admin/courses/${r.data.course.id}/review`, { decision: 'approve' }, root);
    return r.data.course;
  };
  await mk({ title: '微积分预备', instructors: '张老师' });
  await mk({ title: '别的不课', summary: '讲微积分的课' });
  for (const [kw, want] of [['微积分', 2], ['张老师', 1], ['published', 0]] as const) {
    const r = await call('GET', '/api/courses', {}, null, 'q=' + encodeURIComponent(kw));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.courses.length, want, `q=${kw} 应命中 ${want} 门`);
  }
});

test('?q= 的 % 是字面量不是通配符(ILIKE 转义)', async () => {
  const root = await mkUser('root', 'admin');
  // 一门标题里真有 % 的课;若 % 未被转义,q='w%' 会把 'wxy' 也捞出来
  const a = await call('POST', '/api/admin/courses', { ...COURSE_NEW, title: 'w%折扣课' }, root);
  await call('POST', '/api/admin/courses', { ...COURSE_NEW, title: 'wxy普通课' }, root);
  await call('POST', `/api/admin/courses/${a.data.course.id}/review`, { decision: 'approve' }, root);
  const r = await call('GET', '/api/courses', {}, null, 'q=' + encodeURIComponent('w%'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.courses.length, 1, '% 未转义时会当通配符匹配到一切');
  assert.strictEqual(r.data.courses[0].title, 'w%折扣课');
});

// ---------- join-requests 的 ?status=(单值 / 多值 / 非法 400) ----------

test('join-requests ?status= 单值、多值、非法值', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const carol = await mkUser('carol');
  const dave  = await mkUser('dave');
  const c = await call('POST', '/api/projects', PROJECT_NEW, alice);
  const slug = c.data.project.slug;
  const pid = (await query('SELECT id FROM projects WHERE slug=$1', [slug])).rows[0].id;
  await call('POST', `/api/admin/projects/${pid}/review`, { decision: 'approve' }, root);

  // bob → reject(1 条 rejected);carol → accept(1 条 accepted);dave 留 pending
  await call('POST', `/api/projects/${slug}/join`, { message: '想加入' }, bob);
  const jr = async () => (await call('GET', `/api/projects/${slug}/join-requests`, {}, alice)).data.requests;
  await call('POST', `/api/join-requests/${(await jr()).find((x: any) => x.status === 'pending').id}/decision`,
             { decision: 'reject' }, alice);
  await call('POST', `/api/projects/${slug}/join`, { message: '我也想' }, carol);
  await call('POST', `/api/join-requests/${(await jr()).find((x: any) => x.status === 'pending').id}/decision`,
             { decision: 'accept' }, alice);
  await call('POST', `/api/projects/${slug}/join`, { message: '第三个' }, dave);

  const jrPath = `/api/projects/${slug}/join-requests`;
  const all = await call('GET', jrPath, {}, alice);
  assert.strictEqual(all.data.requests.length, 3); // 默认仍是全量(向后兼容)
  const pend = await call('GET', jrPath, {}, alice, 'status=pending');
  assert.strictEqual(pend.data.requests.length, 1);
  assert.strictEqual(pend.data.pagination.total, 1);
  const multi = await call('GET', jrPath, {}, alice, 'status=accepted,rejected');
  assert.strictEqual(multi.data.requests.length, 2);
  const bad = await call('GET', jrPath, {}, alice, 'status=approved');
  assert.strictEqual(bad.status, 400, 'approved 不是这里的词(这里是 accepted)');
});

// ---------- admin 审核列表的 ?status= 多值 ----------

test('admin/mentor-requests ?status 多值(留痕视图 rejected+completed)', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const m = await call('POST', '/api/admin/mentors', {
    name: '徐老师', courses: [{ title: '微积分', total_hours: 18, level: '中级' }],
  }, root);
  assert.strictEqual(m.status, 200);
  await call('POST', `/api/mentors/${m.data.mentor.slug}/requests`,
             { interest: '方向', weekly_hours: '2-4h' }, alice);
  await call('POST', `/api/mentors/${m.data.mentor.slug}/requests`,
             { interest: '方向 B', weekly_hours: '2-4h' }, bob);
  // alice → approve → complete(completed);bob 留 pending,bob 再 reject?pending 无法双轨,
  // 改:对 bob 的申请 reject → rejected
  const list = await call('GET', '/api/admin/mentor-requests', {}, root, 'status=pending');
  const byUser = (u: string) => list.data.requests.find((x: any) => x.user.username === u).id;
  await call('POST', `/api/admin/mentor-requests/${byUser('alice')}/review`, { decision: 'approve' }, root);
  await call('POST', `/api/admin/mentor-requests/${byUser('alice')}/complete`, {}, root);
  // bob 的申请此刻还在 pending;对它 reject:
  await call('POST', `/api/admin/mentor-requests/${byUser('bob')}/review`, { decision: 'reject' }, root);

  const arch = await call('GET', '/api/admin/mentor-requests', {}, root, 'status=rejected,completed');
  assert.strictEqual(arch.data.requests.length, 2);
  const pend = await call('GET', '/api/admin/mentor-requests', {}, root, 'status=pending');
  assert.strictEqual(pend.data.requests.length, 0);
  const bad = await call('GET', '/api/admin/mentor-requests', {}, root, 'status=accepted');
  assert.strictEqual(bad.status, 400);
});

test('admin/course-enrollments ?status 多值', async () => {
  const root  = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob   = await mkUser('bob');
  const c = await call('POST', '/api/admin/courses', COURSE_NEW, root);
  await call('POST', `/api/admin/courses/${c.data.course.id}/lessons`, { title: '第一节' }, root);
  await call('POST', `/api/admin/courses/${c.data.course.id}/review`, { decision: 'approve' }, root);
  const slug = c.data.course.slug;
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  await call('POST', `/api/courses/${slug}/enroll`, {}, bob);
  // alice 通过,course-enrollments 索引允许 bob 再来一条(alice 现在有 pending+approved 各一)
  const list = await call('GET', '/api/admin/course-enrollments', {}, root, 'status=pending');
  const aid = list.data.requests.find((x: any) => x.user.username === 'alice').id;
  await call('POST', `/api/admin/course-enrollments/${aid}/review`, { decision: 'approve' }, root);
  const mix = await call('GET', '/api/admin/course-enrollments', {}, root, 'status=approved,pending');
  assert.strictEqual(mix.data.requests.length, 2);
  const rej = await call('GET', '/api/admin/course-enrollments', {}, root, 'status=rejected');
  assert.strictEqual(rej.data.requests.length, 0);
});

// ---------- 其余端点的分页 ----------

test('members 与 admin/users/pending 分页', async () => {
  const root = await mkUser('root', 'admin');
  for (const n of ['p1', 'p2', 'p3']) {
    await mkUser(n);
  }
  // mkUser 建的是 approved 用户;待审列表要 pending,直接 UPDATE 成注册初态
  await query(`UPDATE users SET status='pending' WHERE username IN ('p1','p2','p3')`);
  const pend = await call('GET', '/api/admin/users/pending', {}, root, 'per_page=2');
  assert.strictEqual(pend.data.users.length, 2);  // per_page=2 夹住 3 条 pending
  assert.strictEqual(pend.data.pagination.total, 3);
  const app = await call('GET', '/api/members', {}, null, 'per_page=2');
  assert.strictEqual(app.data.members.length, 1); // 剩下 root 是 approved
  assert.strictEqual(app.data.pagination.total, 1);
});

test('notifications 分页(默认 per_page=50)', async () => {
  const alice = await mkUser('alice');
  for (let i = 0; i < 5; i++) {
    await query(
      `INSERT INTO notifications (user_id, kind, title, body) VALUES ($1,'account','t','b')`, [alice.id]);
  }
  const d = await call('GET', '/api/notifications', {}, alice);
  assert.strictEqual(d.data.notifications.length, 5);
  assert.strictEqual(d.data.pagination.per_page, 50);
  const p1 = await call('GET', '/api/notifications', {}, alice, 'per_page=2&page=2');
  assert.strictEqual(p1.data.notifications.length, 2);
});

// ---------- 新端点 GET /api/mentor-courses ----------

test('mentor-courses:distinct 标题,供筛选下拉', async () => {
  const root = await mkUser('root', 'admin');
  await call('POST', '/api/admin/mentors', {
    name: '徐老师', courses: [{ title: '微积分', total_hours: 18, level: '中级' }],
  }, root);
  await call('POST', '/api/admin/mentors', {
    name: '梁老师', courses: [{ title: '微积分' }, { title: '信息论' }],
  }, root);
  const r = await call('GET', '/api/mentor-courses');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([...r.data.courses].sort(), ['信息论', '微积分']);
  // 匿名可达(白名单)
  assert.strictEqual((await call('GET', '/api/mentor-courses')).status, 200);
});
