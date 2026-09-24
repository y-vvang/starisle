// 项目详情三块内容(技术栈 / 阶段性成果 / 当前需求)在界面上是多行文本框,
// 在接口上是结构化数组。转换只写这一处,发起项目与编辑项目共用,免得两边各拆一遍
// 又拆得不一样。
//
// 约定:
//   技术栈     —— 逗号分隔(半角或全角都吃)
//   阶段性成果 —— 一行一条
//   当前需求   —— 一行一条,写成「技能 | 说明」,竖线与说明可省

export interface Gap { skill: string; note: string }

const clean = (arr: string[]): string[] => arr.map(s => s.trim()).filter(Boolean);

export const linesToList = (s: string | null | undefined): string[] =>
  clean(String(s == null ? '' : s).split('\n'));
export const listToLines = (a: string[] | null | undefined): string =>
  (Array.isArray(a) ? a : []).join('\n');

export const csvToList = (s: string | null | undefined): string[] =>
  clean(String(s == null ? '' : s).split(/[,，]/));
export const listToCsv = (a: string[] | null | undefined): string =>
  (Array.isArray(a) ? a : []).join('、');

export function linesToGaps(s: string | null | undefined): Gap[] {
  return String(s == null ? '' : s).split('\n').map(line => {
    const t = line.trim();
    if (!t) return null;
    // 半角 | 与全角 ｜ 都当分隔符 —— 中文输入法下很容易打出全角的那个
    const i = t.search(/[|｜]/);
    if (i < 0) return { skill: t, note: '' };
    return { skill: t.slice(0, i).trim(), note: t.slice(i + 1).trim() };
  }).filter((g): g is Gap => !!g && !!g.skill);
}

export const gapsToLines = (a: Gap[] | null | undefined): string =>
  (Array.isArray(a) ? a : [])
    .map(g => (g && g.note ? `${g.skill} | ${g.note}` : (g && g.skill) || ''))
    .filter(Boolean).join('\n');
