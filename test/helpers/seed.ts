import { hash } from '../../app/auth/password';
import type { SessionUser } from '../../app/auth/session';
import { query } from './db';

// 原先 5 个测试文件各有一份逐字相同的副本,收敛到这里。
// display_name 一并返回:ctx.user(SessionUser)的形状需要它,而通知文案用的是
// `user.display_name || user.username`,display_name 与 username 同值,行为不变。
export async function mkUser(username: string, role = 'member'): Promise<SessionUser> {
  // 注:不能让 $1 同时喂给 username(citext)和 display_name(text)——
  // PG 17 在这台环境上会报「inconsistent types deduced for parameter $1 (citext
  // versus text)」。语义不变(display_name 仍等于 username),只是改成各自独立占位符。
  const r = await query(
    `INSERT INTO users (username,password_hash,display_name,email,role,status)
     VALUES ($1,$2,$3,$4,$5,'approved') RETURNING id`,
    [username, await hash('pw12345678'), username, `${username}@x.com`, role]);
  return { id: (r.rows[0] as any).id, username, display_name: username, role, status: 'approved' };
}

// 项目创建的标准 payload(原先 projects-routes / project-interactions 两份逐字副本,
// project-content 的 BASE 同值但保留原名)。
export const PROJECT_NEW = { name: 'Lumen 学伴', tagline: '给县城中学生的离线 AI 学习伙伴',
                             description: '一个能在低配安卓机上跑的学习助手,离线优先。',
                             repo_url: 'https://gitee.com/x/lumen', domain_id: 'edu' };
