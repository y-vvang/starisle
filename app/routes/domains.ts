import { sql } from 'drizzle-orm';
import { db } from '../db/pool';
import { domains } from '../db/schema';
import type { RouteHandler } from './types';

const domainRoutes: RouteHandler = async (ctx, D) => {
  if (ctx.method === 'GET' && ctx.path === '/api/domains') {
    // sort 非唯一,补 id tiebreaker 保证排序确定(非分页需要,但同样受益)。
    const r = await db.select().from(domains).orderBy(domains.sort, domains.id);
    return D({ domains: r });
  }
  if (ctx.method === 'GET' && ctx.path === '/api/stats') {
    // stats 的两个标量子查询:builder 表达不了这种形态,保留原 SQL
    // (db.execute 的结果就是 pg QueryResult,带 .rows)。
    const r = await db.execute(sql`
      SELECT (SELECT count(*) FROM users    WHERE status='approved')::int AS members,
             (SELECT count(*) FROM projects WHERE status='approved')::int AS projects`);
    return D(r.rows[0]);
  }
};

export default domainRoutes;
