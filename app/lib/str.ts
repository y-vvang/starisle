// 请求体字符串字段的统一清洗:trim + 截长(先 String() 防 null/undefined)。
// 原先在 auth/projects/courses/mentors 四个路由文件里各有一份逐字相同的
// 副本,TS 化时收敛到这一处 —— 行为等价,只是不再各自维护。
export const str = (v: unknown, n: number): string =>
  String(v == null ? '' : v).trim().slice(0, n);
