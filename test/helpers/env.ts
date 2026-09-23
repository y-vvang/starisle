// 唯一职责:在任何连库模块(app/db/pool.ts)被求值之前覆写 DATABASE_URL。
// bunfig.toml 的 [test] preload 会加载它(第一道保险);test/helpers/db.ts 的
// 首条 `import './env'` 再兜一层(第二道,防止单文件直跑绕过 bunfig)。
// 背景:原 CJS 版靠「先给 process.env 赋值、再 require pool」的顺序生效;
// ESM 的静态 import 被提升,模块体里的赋值会晚于被 import 模块的求值,
// 不加这两道保险,测试会连上开发库(本机有 .env 时)甚至直接退出(没有时)。
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://starisle:devpass@localhost:5432/starisle_test';
