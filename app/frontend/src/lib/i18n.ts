import { reactive } from 'vue';

// 结构层 i18n:导航 / 版块标题副题 / 主要按钮切换中英。
// 种子内容(成员简介、项目、课题正文等)仍为中文 —— 这是一份中文社区的展示 demo。
export const i18n = reactive({ lang: 'zh' });
export function setLang(l: string) { i18n.lang = l; }
export function toggleLang() { i18n.lang = i18n.lang === 'zh' ? 'en' : 'zh'; }
// t(中文, English):en 缺省时回退中文
export function t(zh: string, en?: string): string { return i18n.lang === 'en' && en ? en : zh; }
