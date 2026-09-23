// 测试一律打 TEST_DATABASE_URL,绝不碰开发库。
// 【import 顺序是契约】'./env' 必须是第一条 import —— 见 env.ts 头部注释。
import './env';
import { pool, query } from '../../app/db/pool';

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

export async function resetDb() {
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

// 刻意不导出 closeDb:bun test 单进程顺序执行所有测试文件(与 node --test 的
// 每文件一进程不同),第一个文件把池关掉,后面全部文件都会拿到
// "Cannot use a pool after calling end"。连接池交给进程退出回收。
export { query, pool };
