'use strict';
// 测试一律打 TEST_DATABASE_URL,绝不碰开发库
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://starisle:devpass@localhost:5432/starisle_test';

const { pool, query } = require('../../app/db/pool');

// 顺序无所谓,CASCADE 会处理外键。
// 但**没有外键指回 users 的表必须自己列进来** —— 只写 users 的话,靠级联能顺带清掉
// projects/courses(它们有 owner_id / created_by),却清不掉 mentors 与 partner_orgs,
// 于是那两张表会跨用例累积,后面的断言看到的是前面所有用例留下的数据总和。
// (导师那组测试第一次跑就是这么炸的:期望 2 个导师,实得 25 个。)
const TABLES = [
  'sessions', 'notifications',
  'project_members', 'projects',
  'course_enrollments', 'course_lessons', 'courses',
  'mentor_requests', 'mentor_courses', 'mentors', 'partner_orgs',
  'users',
];

async function resetDb() {
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

const closeDb = () => pool.end();

module.exports = { resetDb, closeDb, query, pool };
