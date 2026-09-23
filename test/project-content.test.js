'use strict';
// 项目详情页 02/03/04 三块内容字段:work / stack / milestones / gaps
// 这三块此前在前端是写死的空值(adapt() 里 work:'' milestones:[] gapsDetail:[]),
// 数据库根本没有对应列。这组测试钉死新增的读写与校验。
const test = require('node:test');
const assert = require('node:assert');
const { resetDb, closeDb, query } = require('./helpers/db');
const { handle } = require('../app/routes');
const { hash } = require('../app/auth/password');

const call = (method, path, body = {}, user = null) =>
  handle({ method, path, seg: path.split('/').filter(Boolean),
           query: new URLSearchParams(), body, user,
           session: user ? { id: 'fake' } : null, userAgent: 't', ip: '1.1.1.1' });

async function mkUser(username, role = 'member') {
  const r = await query(
    `INSERT INTO users (username,password_hash,display_name,email,role,status)
     VALUES ($1,$2,$3,$4,$5,'approved') RETURNING id`,
    [username, await hash('pw12345678'), username, `${username}@x.com`, role]);
  return { id: r.rows[0].id, username, role, status: 'approved' };
}

const BASE = { name: 'Lumen 学伴', tagline: '给县城中学生的离线 AI 学习伙伴',
               description: '一个能在低配安卓机上跑的学习助手,离线优先。',
               repo_url: 'https://gitee.com/x/lumen', domain_id: 'edu' };

const CONTENT = {
  work: '把 7B 模型量化到能在 4G 内存的红米上跑,再做一层错题 OCR。',
  stack: ['Vue 3', 'Node', 'llama.cpp'],
  milestones: ['跑通离线推理', '接入错题 OCR', '在两所中学试用'],
  gaps: [{ skill: '前端', note: '会 Vue 优先' }, { skill: 'Android', note: '' }],
};

// 建一个已过审项目,返回 slug
async function mkApproved(owner, extra = {}) {
  const r = await call('POST', '/api/projects', { ...BASE, ...extra }, owner);
  assert.strictEqual(r.status, 200, '建项目应成功');
  await query(`UPDATE projects SET status='approved' WHERE slug=$1`, [r.data.project.slug]);
  return r.data.project.slug;
}

test.beforeEach(resetDb);
test.after(closeDb);

test('创建项目时带上四块内容,详情原样返回', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice, CONTENT);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  assert.strictEqual(d.status, 200);
  const p = d.data.project;
  assert.strictEqual(p.work, CONTENT.work);
  assert.deepStrictEqual(p.stack, CONTENT.stack);
  assert.deepStrictEqual(p.milestones, CONTENT.milestones);
  assert.deepStrictEqual(p.gaps, CONTENT.gaps);
});

test('不带这四块创建时,详情返回空值而不是 undefined', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  const p = d.data.project;
  assert.strictEqual(p.work, null, 'work 未填应为 null');
  assert.deepStrictEqual(p.stack, [], 'stack 未填应为空数组');
  assert.deepStrictEqual(p.milestones, []);
  assert.deepStrictEqual(p.gaps, []);
});

test('属主 PATCH 能改这四块', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const r = await call('PATCH', `/api/projects/${slug}`, {
    work: '改过的工作', stack: ['Rust'], milestones: ['第一版上线'],
    gaps: [{ skill: '设计', note: '做图标' }],
  }, alice);
  assert.strictEqual(r.status, 200);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  const p = d.data.project;
  assert.strictEqual(p.work, '改过的工作');
  assert.deepStrictEqual(p.stack, ['Rust']);
  assert.deepStrictEqual(p.milestones, ['第一版上线']);
  assert.deepStrictEqual(p.gaps, [{ skill: '设计', note: '做图标' }]);
});

test('PATCH 只传一个字段时,其余三块不被清空', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice, CONTENT);
  await call('PATCH', `/api/projects/${slug}`, { work: '只改这个' }, alice);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  const p = d.data.project;
  assert.strictEqual(p.work, '只改这个');
  assert.deepStrictEqual(p.stack, CONTENT.stack, 'stack 不该被连带清空');
  assert.deepStrictEqual(p.milestones, CONTENT.milestones);
});

test('传空数组能把内容清空(与"不传"区分开)', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice, CONTENT);
  await call('PATCH', `/api/projects/${slug}`, { stack: [], gaps: [] }, alice);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  assert.deepStrictEqual(d.data.project.stack, []);
  assert.deepStrictEqual(d.data.project.gaps, []);
  assert.deepStrictEqual(d.data.project.milestones, CONTENT.milestones, '没传的不受影响');
});

test('stack 不是数组 → 400,且不落库', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice, CONTENT);
  const r = await call('PATCH', `/api/projects/${slug}`, { stack: 'Vue, Node' }, alice);
  assert.strictEqual(r.status, 400);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  assert.deepStrictEqual(d.data.project.stack, CONTENT.stack, '原值应完好');
});

test('stack 元素不是字符串 → 400', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const r = await call('PATCH', `/api/projects/${slug}`, { stack: ['ok', 42] }, alice);
  assert.strictEqual(r.status, 400);
});

test('gaps 元素缺 skill → 400', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const r = await call('PATCH', `/api/projects/${slug}`, { gaps: [{ note: '只有说明' }] }, alice);
  assert.strictEqual(r.status, 400);
});

test('gaps 元素不是对象 → 400', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const r = await call('PATCH', `/api/projects/${slug}`, { gaps: ['前端'] }, alice);
  assert.strictEqual(r.status, 400);
});

test('条目数超过上限 → 400', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const many = Array.from({ length: 21 }, (_, i) => `第 ${i} 条`);
  const r = await call('PATCH', `/api/projects/${slug}`, { milestones: many }, alice);
  assert.strictEqual(r.status, 400);
});

test('单条内容超长 → 400', async () => {
  const alice = await mkUser('alice');
  const slug = await mkApproved(alice);
  const r = await call('PATCH', `/api/projects/${slug}`, { milestones: ['x'.repeat(201)] }, alice);
  assert.strictEqual(r.status, 400);
});

test('非属主改已上线项目的内容 → 403,内容不变', async () => {
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const slug = await mkApproved(alice, CONTENT);
  const r = await call('PATCH', `/api/projects/${slug}`, { work: '我不是属主' }, bob);
  assert.strictEqual(r.status, 403);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  assert.strictEqual(d.data.project.work, CONTENT.work);
});

test('站长能改别人项目的内容', async () => {
  const alice = await mkUser('alice');
  const root = await mkUser('root', 'admin');
  const slug = await mkApproved(alice, CONTENT);
  const r = await call('PATCH', `/api/projects/${slug}`, { work: '站长改的' }, root);
  assert.strictEqual(r.status, 200);
  const d = await call('GET', `/api/projects/${slug}`, {}, alice);
  assert.strictEqual(d.data.project.work, '站长改的');
});

test('公开列表不返回这四块(只有详情才带)', async () => {
  const alice = await mkUser('alice');
  await mkApproved(alice, CONTENT);
  const list = await call('GET', '/api/projects');
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.projects.length >= 1);
  const card = list.data.projects[0];
  assert.strictEqual(card.work, undefined, '列表卡片不该带 work');
  assert.strictEqual(card.milestones, undefined);
});
