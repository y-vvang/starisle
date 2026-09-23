'use strict';
// 课程中心:课程展示 + 课纲 + 学习申请审批。
// 移植自上游的课程模块,但身份一律来自会话(上游是客户端自报 personaId,零校验),
// 站长端点一律挂 /api/admin/ 前缀(上游的 /api/admin/ 只是路径前缀,不是权限边界)。
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { handle } = require('../app/routes');
const { hash } = require('../app/auth/password');

const call = (method, path, body = {}, user = null, qs = '') =>
  handle({ method, path, seg: path.split('/').filter(Boolean),
           query: new URLSearchParams(qs), body, user,
           session: user ? { id: 'fake' } : null, userAgent: 't', ip: '1.1.1.1' });

async function mkUser(username, role = 'member') {
  const r = await query(
    `INSERT INTO users (username,password_hash,display_name,email,role,status)
     VALUES ($1,$2,$3,$4,$5,'approved') RETURNING id`,
    [username, await hash('pw12345678'), username, `${username}@x.com`, role]);
  return { id: r.rows[0].id, username, role, status: 'approved' };
}

const NEW = { title: '微积分预备', track: 'math', subject: '微积分',
              summary: '从极限讲到导数', description: '给没学过大学数学的中学生。',
              instructors: '张老师、李老师', audience: '审核通过的社区成员', total_hours: 12 };

// 建一门已发布的课,返回 {id, slug}。
// 默认排一节课 —— 课纲为空的课不接受申请(见下方那条边界用例),而多数用例要测的是
// 申请流程本身,不是"空课纲"这个边界。要一门光秃秃的课就传 { lessons: false },
// 课节编排类的用例也该传它,否则这一节默认课会把 position 断言算错。
async function mkPublished(root, extra = {}, opts = {}) {
  const c = await call('POST', '/api/admin/courses', { ...NEW, ...extra }, root);
  assert.strictEqual(c.status, 200, '建课应成功');
  const id = c.data.course.id;
  if (opts.lessons !== false) {
    await call('POST', `/api/admin/courses/${id}/lessons`, { title: '开课说明' }, root);
  }
  await call('POST', `/api/admin/courses/${id}/review`, { decision: 'approve' }, root);
  return { id, slug: c.data.course.slug };
}

test.beforeEach(resetDb);
test.after(closeDb);

// ---------- 公开浏览 ----------

test('公开列表只返回已发布的课', async () => {
  const root = await mkUser('root', 'admin');
  await mkPublished(root);
  await call('POST', '/api/admin/courses', { ...NEW, title: '还没发布的课' }, root); // 停在 draft
  const r = await call('GET', '/api/courses');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.courses.length, 1);
  assert.strictEqual(r.data.courses[0].title, '微积分预备');
});

test('匿名能看已发布课的详情与课纲', async () => {
  const root = await mkUser('root', 'admin');
  const { id, slug } = await mkPublished(root, {}, { lessons: false });
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: '第一节:极限', duration_minutes: 45 }, root);
  const r = await call('GET', `/api/courses/${slug}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.course.title, '微积分预备');
  assert.strictEqual(r.data.lessons.length, 1);
  assert.strictEqual(r.data.lessons[0].position, 1);
});

test('未发布的课对匿名与普通成员都是 404(不是 403,不泄露存在)', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/admin/courses', NEW, root);
  const slug = c.data.course.slug;
  assert.strictEqual((await call('GET', `/api/courses/${slug}`)).status, 404);
  assert.strictEqual((await call('GET', `/api/courses/${slug}`, {}, alice)).status, 404);
  assert.strictEqual((await call('GET', `/api/courses/${slug}`, {}, root)).status, 200, '站长看得到');
});

test('按 track 过滤', async () => {
  const root = await mkUser('root', 'admin');
  await mkPublished(root);
  await mkPublished(root, { title: 'AI 通识', track: 'literacy' });
  const r = await call('GET', '/api/courses', {}, null, 'track=literacy');
  assert.strictEqual(r.data.courses.length, 1);
  assert.strictEqual(r.data.courses[0].track, 'literacy');
});

// ---------- 学习申请 ----------

test('登录成员可以申请学习,拿到 pending', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  const r = await call('POST', `/api/courses/${slug}/enroll`, { message: '想学' }, alice);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.enrollment.status, 'pending');
});

test('未登录申请 → 401', async () => {
  const root = await mkUser('root', 'admin');
  const { slug } = await mkPublished(root);
  assert.strictEqual((await call('POST', `/api/courses/${slug}/enroll`, {})).status, 401);
});

test('重复申请 → 409,且不产生第二行', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const r = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  assert.strictEqual(r.status, 409);
  const n = await query('SELECT count(*)::int AS n FROM course_enrollments');
  assert.strictEqual(n.rows[0].n, 1);
});

test('未发布的课不能申请 → 404', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const c = await call('POST', '/api/admin/courses', NEW, root);
  const r = await call('POST', `/api/courses/${c.data.course.slug}/enroll`, {}, alice);
  assert.strictEqual(r.status, 404);
});

test('详情里带上自己的申请状态,且看不到别人的', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const { slug } = await mkPublished(root);
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const a = await call('GET', `/api/courses/${slug}`, {}, alice);
  assert.strictEqual(a.data.enrollment.status, 'pending');
  const b = await call('GET', `/api/courses/${slug}`, {}, bob);
  assert.strictEqual(b.data.enrollment, null, '别人没申请过就是 null');
});

test('我的课程只返回自己的', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const { slug } = await mkPublished(root);
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const a = await call('GET', '/api/my/courses', {}, alice);
  assert.strictEqual(a.data.courses.length, 1);
  const b = await call('GET', '/api/my/courses', {}, bob);
  assert.strictEqual(b.data.courses.length, 0);
  assert.strictEqual((await call('GET', '/api/my/courses')).status, 401);
});

// ---------- 站长审批 ----------

test('站长通过学习申请 → approved 且给申请人发通知', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  const e = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const r = await call('POST', `/api/admin/course-enrollments/${e.data.enrollment.id}/review`,
                       { decision: 'approve' }, root);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'approved');
  const n = await query('SELECT kind FROM notifications WHERE user_id=$1', [alice.id]);
  assert.strictEqual(n.rowCount, 1);
  assert.strictEqual(n.rows[0].kind, 'course');
});

test('重复审批同一条申请 → 409', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  const e = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const id = e.data.enrollment.id;
  await call('POST', `/api/admin/course-enrollments/${id}/review`, { decision: 'approve' }, root);
  const r = await call('POST', `/api/admin/course-enrollments/${id}/review`, { decision: 'reject' }, root);
  assert.strictEqual(r.status, 409);
});

test('已经通过之后不能再申请 → 409', async () => {
  // 两条各管一段的部分唯一索引之间有缝:申请通过后那行变成 approved,
  // pending 的那条索引就不再挡它,而新插入的是 pending 也不违反 approved 那条 ——
  // 结果是已经在学的人能无限重复申请,站长队列里反复看到同一个人。
  // 改成一条覆盖 status IN ('pending','approved') 的索引来堵住。
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  const e = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  await call('POST', `/api/admin/course-enrollments/${e.data.enrollment.id}/review`,
             { decision: 'approve' }, root);
  const again = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  assert.strictEqual(again.status, 409);
  const n = await query('SELECT count(*)::int AS n FROM course_enrollments');
  assert.strictEqual(n.rows[0].n, 1, '不该多出一条 pending');
});

test('被拒之后可以重新申请(旧行留档)', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  const e = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  await call('POST', `/api/admin/course-enrollments/${e.data.enrollment.id}/review`,
             { decision: 'reject' }, root);
  const again = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  assert.strictEqual(again.status, 200);
  const n = await query('SELECT count(*)::int AS n FROM course_enrollments');
  assert.strictEqual(n.rows[0].n, 2, '旧的 rejected 应该留着');
});

test('站长审批列表不返回申请人邮箱', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { slug } = await mkPublished(root);
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  const r = await call('GET', '/api/admin/course-enrollments', {}, root);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.requests.length, 1);
  const blob = JSON.stringify(r.data);
  assert.ok(!blob.includes('@x.com'), '站长审报名不需要邮箱,不该顺手 join 出来');
});

// ---------- 课节管理 ----------

test('课节按加入顺序排 position,重排端点一次提交完整顺序', async () => {
  const root = await mkUser('root', 'admin');
  const { id, slug } = await mkPublished(root, {}, { lessons: false });
  const a = await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'A' }, root);
  const b = await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'B' }, root);
  const c = await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'C' }, root);
  const ids = [c.data.lesson.id, a.data.lesson.id, b.data.lesson.id];
  const r = await call('POST', `/api/admin/courses/${id}/lessons/reorder`, { lesson_ids: ids }, root);
  assert.strictEqual(r.status, 200);
  const d = await call('GET', `/api/courses/${slug}`);
  assert.deepStrictEqual(d.data.lessons.map(l => l.title), ['C', 'A', 'B']);
  assert.deepStrictEqual(d.data.lessons.map(l => l.position), [1, 2, 3]);
});

test('重排时漏掉或混入别的课的课节 → 400', async () => {
  const root = await mkUser('root', 'admin');
  const { id } = await mkPublished(root);
  const other = await mkPublished(root, { title: '另一门课' });
  const a = await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'A' }, root);
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'B' }, root);
  const x = await call('POST', `/api/admin/courses/${other.id}/lessons`, { title: 'X' }, root);
  assert.strictEqual(
    (await call('POST', `/api/admin/courses/${id}/lessons/reorder`, { lesson_ids: [a.data.lesson.id] }, root)).status,
    400, '漏掉一条');
  assert.strictEqual(
    (await call('POST', `/api/admin/courses/${id}/lessons/reorder`,
                { lesson_ids: [a.data.lesson.id, x.data.lesson.id] }, root)).status,
    400, '混入别的课的课节');
});

test('删课节后剩余 position 重排连续', async () => {
  const root = await mkUser('root', 'admin');
  const { id, slug } = await mkPublished(root, {}, { lessons: false });
  const a = await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'A' }, root);
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'B' }, root);
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'C' }, root);
  await call('DELETE', `/api/admin/lessons/${a.data.lesson.id}`, {}, root);
  const d = await call('GET', `/api/courses/${slug}`);
  assert.deepStrictEqual(d.data.lessons.map(l => l.position), [1, 2]);
  assert.deepStrictEqual(d.data.lessons.map(l => l.title), ['B', 'C']);
});

test('删课连带删课节与报名(外键级联)', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { id, slug } = await mkPublished(root, {}, { lessons: false });
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: 'A' }, root);
  await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  await query('DELETE FROM courses WHERE id=$1', [id]);
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM course_lessons')).rows[0].n, 0);
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM course_enrollments')).rows[0].n, 0);
});

// ---------- 校验与权限 ----------

test('建课校验:标题必填、track 必须合法', async () => {
  const root = await mkUser('root', 'admin');
  assert.strictEqual((await call('POST', '/api/admin/courses', { ...NEW, title: '' }, root)).status, 400);
  assert.strictEqual((await call('POST', '/api/admin/courses', { ...NEW, track: 'nope' }, root)).status, 400);
});

test('课程 slug 避开保留动词', async () => {
  const root = await mkUser('root', 'admin');
  const c = await call('POST', '/api/admin/courses', { ...NEW, title: 'review' }, root);
  assert.strictEqual(c.status, 200);
  assert.notStrictEqual(c.data.course.slug, 'review');
});

test('普通成员碰不了任何站长端点', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { id } = await mkPublished(root);
  for (const [m, p] of [
    ['GET', '/api/admin/courses'],
    ['POST', '/api/admin/courses'],
    ['PATCH', `/api/admin/courses/${id}`],
    ['POST', `/api/admin/courses/${id}/review`],
    ['POST', `/api/admin/courses/${id}/lessons`],
    ['GET', '/api/admin/course-enrollments'],
  ]) {
    const r = await call(m, p, { decision: 'approve' }, alice);
    assert.ok(r.status === 401 || r.status === 403, `${m} ${p} 应拒绝,实得 ${r.status}`);
  }
});

test('站长把课改回 draft 后,公开列表里就没有了', async () => {
  const root = await mkUser('root', 'admin');
  const { id } = await mkPublished(root);
  assert.strictEqual((await call('GET', '/api/courses')).data.courses.length, 1);
  await call('PATCH', `/api/admin/courses/${id}`, { status: 'archived' }, root);
  assert.strictEqual((await call('GET', '/api/courses')).data.courses.length, 0);
});

test('后台课程列表必须返回完整字段 —— 缺一个,后台编辑就会静默清空它', async () => {
  // 这条钉的是一个真实发生过的数据丢失链:
  //   GET /api/admin/courses 返回 card()(不含 description/audience)
  //   → 后台 startEdit() 用 c.description 回填,拿到 undefined → 表单里是空串
  //   → save() 把整份表单 PATCH 上去,description:'' 一起发
  //   → collectCourse 见到 typeof ''==='string',把列写成 null
  // 净结果:站长只想改个标题,详细介绍和适合人群被清空,且没有任何提示。
  // 所以后台列表**必须**返回后台表单会回填的每一个字段。
  const root = await mkUser('root', 'admin');
  await mkPublished(root, { description: '这段详细介绍必须能原样回到后台表单里。',
                            audience: '学过一点编程的高中生' });
  const r = await call('GET', '/api/admin/courses', {}, root);
  assert.strictEqual(r.status, 200);
  const c = r.data.courses[0];
  for (const k of ['title', 'track', 'subject', 'summary', 'description',
                   'instructors', 'audience', 'total_hours', 'featured', 'status']) {
    assert.notStrictEqual(c[k], undefined, `后台列表缺字段 ${k},后台编辑会把它清空`);
  }
  assert.strictEqual(c.description, '这段详细介绍必须能原样回到后台表单里。');
  assert.strictEqual(c.audience, '学过一点编程的高中生');
});

test('公开列表则不带 description/audience(正文只在详情给)', async () => {
  const root = await mkUser('root', 'admin');
  await mkPublished(root, { description: '正文不该出现在列表里', audience: '某某人群' });
  const r = await call('GET', '/api/courses');
  assert.strictEqual(r.data.courses[0].description, undefined);
  assert.strictEqual(r.data.courses[0].audience, undefined);
});

test('课纲还没排的课不能申请 → 409(否则站长队列里全是"申请一门空课")', async () => {
  const root = await mkUser('root', 'admin');
  const alice = await mkUser('alice');
  const { id, slug } = await mkPublished(root, {}, { lessons: false });   // 已发布但一节课都没有
  const r = await call('POST', `/api/courses/${slug}/enroll`, {}, alice);
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await query('SELECT count(*)::int AS n FROM course_enrollments')).rows[0].n, 0);
  // 排上一节之后就能申请了
  await call('POST', `/api/admin/courses/${id}/lessons`, { title: '第一节' }, root);
  assert.strictEqual((await call('POST', `/api/courses/${slug}/enroll`, {}, alice)).status, 200);
});
