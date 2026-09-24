// ?status= 多值解析(逗号分隔)。near-online 的课程/导师/加入申请三类审核
// 状态列语义不同(accepted vs approved vs completed),白名单按端点传入;
// 全部命中才收,否则 'invalid'(调方 400)——与 ?track=/?category= 同一条
// "非法值响亮失败"的风格,不静默过滤成空列表。
export function statusesParam(q: URLSearchParams, allowed: readonly string[]): string[] | 'invalid' {
  const raw = q.get('status');
  if (!raw) return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [];                    // ?status= (空值) 视为不过滤
  return parts.every(s => allowed.includes(s)) ? parts : 'invalid';
}
