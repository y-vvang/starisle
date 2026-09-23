import * as pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

// int8/bigint(OID 20)修在源头:pg driver 默认把 bigint 列读成字符串(怕精度
// 溢出 JS number),但这个项目里所有 bigint 都是 id 自增列,数值远小于
// Number.MAX_SAFE_INTEGER,COUNT(*) 也早就在 SQL 里显式 ::int 转过。此前只
// 在入口(getSession 把 user.id 转 Number)修了一半,出口(publicUser()/
// card() 直接透传数据库行)还在吐字符串——两套约定并存,前端还留着三条注释
// 提醒"这边是字符串"。在这里对 OID 20 统一注册类型解析器,让每一条从
// pg 出来的 bigint 天生就是 Number,入口出口不用再各修一次。
// 这条对三条查询路径都生效:drizzle builder、db.execute(sql``)、裸 pool.query。
const { Pool } = pg;
(pg as any).types.setTypeParser(20, Number);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺少 DATABASE_URL。复制 .env.example 并按其中说明设置。');
  process.exit(1);
}

export const pool = new Pool({ connectionString, max: 10 });

pool.on('error', (err: Error) => {
  // 空闲连接被服务端掐断时会走到这里;不要让它掀翻进程
  console.error('[db] 空闲连接出错:', err.message);
});

type Query = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
export const query: Query = (text, params) =>
  pool.query(text, params as any[]);

// Drizzle 实例:底层就是上面这个 pg Pool。**全库只用这一个 db**;
// 事务一律走下面的 tx()(自管 BEGIN/COMMIT/ROLLBACK),**禁用
// db.transaction()** —— drizzle 那套自己 connect/BEGIN/RELEASE,与自管
// tx 并存必出双 BEGIN 与错误释放。
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

// drizzle-orm ≥ 0.36 会把驱动错误包成 DrizzleQueryError,pg 原错误在 .cause;
// 裸 pool.query / client.query 的错误不包装。捕获唯一索引冲突(23505)时
// 用这个 helper 双向兼容两条路径。
export const pgCode = (e: unknown): string | undefined =>
  (e as any)?.cause?.code ?? (e as any)?.code;

// 事务助手:回调拿到 drizzle 实例(绑定在同一个 client 上,事务语义成立),
// 抛异常自动回滚。
// drizzle(client) 的实例构造是纯对象组装、无 I/O,每个事务新建一份没有开销。
export async function tx<T>(fn: (client: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
  const pgClient = await pool.connect();
  let err: unknown; // 在 catch 里先落到这个变量,finally 才拿得到——即使 ROLLBACK 本身又抛,
                    // err 早已经赋值,finally 依然会把它带给 release()
  try {
    await pgClient.query('BEGIN');
    const result = await fn(drizzle(pgClient, { schema }));
    await pgClient.query('COMMIT');
    return result;
  } catch (e) {
    err = e;
    await pgClient.query('ROLLBACK');
    throw e;
  } finally {
    // client.release() 会把 client 原样还回池子给下一个请求复用;如果上面
    // ROLLBACK 本身就失败了(连接已经处于未知状态),那个"看起来正常"的
    // 连接其实已经中毒。release(err) 是 node-postgres 里"别复用,直接销毁
    // 这个连接"的信号——传参与不传只差这一个词,后果是中毒连接会不会被
    // 下一个不相干的请求捡到。drizzle 的包装错误传进来同样触发销毁,安全。
    pgClient.release(err as Error | undefined);
  }
}
