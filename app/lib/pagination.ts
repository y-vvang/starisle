// 偏移分页的统一解析与响应 meta。
// 【不做越界钳制】page 超过总页数时照常查询(offset 超尾返回空列表),
// meta.total / total_pages 依然正确 —— 前端据此把页码钳回最后一页,
// 后端保持"查什么给什么"的朴素语义。
export interface PageMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

// query.get() 为 null 时取默认值;非法数字与越界值都夹进 [min,max] 而不是报错——
// 列表页对"翻页参数坏了"正确反应是给一页合理数据,不是 500。
const num = (raw: string | null, d: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw == null || !Number.isFinite(n) ? d : Math.min(max, Math.max(min, Math.trunc(n)));
};

export interface ParsedPagination { page: number; perPage: number }

export function parsePagination(q: URLSearchParams, d: { page?: number; perPage?: number } = {}): ParsedPagination {
  return {
    // per_page 上限 100:够后台一屏审核列表,又能防止 ?per_page=999999 把
    // 分页退化成全量(那是这次改造要解决的问题本身)。
    page: num(q.get('page'), d.page ?? 1, 1, 1e9),
    perPage: num(q.get('per_page'), d.perPage ?? 20, 1, 100),
  };
}

export const pageMeta = (total: number, page: number, perPage: number): PageMeta =>
  ({ page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) });
