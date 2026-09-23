'use strict';
const { randomBytes } = require('node:crypto');
const { query } = require('../db/pool');

const RESERVED_WORDS = new Set([
  'review',
  'decide',
  'grant',
  'clear',
  'pending',
  'suspend'
]);

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // 非字母数字(含中文)一律转连字符
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
}

// 表名要拼进 SQL(占位符只能绑值不能绑标识符),所以走白名单而不是信任调用方。
// 往这里加表之前先确认那张表真的有 slug citext UNIQUE 列。
// 值是"转写结果为空时"的回退前缀 —— 纯中文标题 slugify 后是空串,必须有个兜底,
// 而兜底串会直接出现在 URL 里,所以要跟着表走:课程回退成 p-xxxxxx(p = project)
// 会让人以为点错了地方。
const SLUG_TABLES = { projects: 'p', courses: 'c', mentors: 'm', partner_orgs: 'o' };

async function uniqueSlug(name, table = 'projects') {
  const prefix = SLUG_TABLES[table];
  if (!prefix) throw new Error(`uniqueSlug: 未登记的表 ${table}`);
  const taken = async (s) => {
    const r = await query(`SELECT 1 FROM ${table} WHERE slug=$1`, [s]);
    return r.rowCount > 0;
  };

  let base = slugify(name);
  if (!base) base = prefix + '-' + randomBytes(3).toString('hex');

  // Check if base is a reserved word
  if (RESERVED_WORDS.has(base)) {
    // Start from -2 to find a non-reserved variant
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!await taken(candidate)) return candidate;
    }
    return `${base}-${randomBytes(3).toString('hex')}`;
  }

  let candidate = base;
  for (let i = 2; i < 100; i++) {
    if (!await taken(candidate)) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

module.exports = { slugify, uniqueSlug, RESERVED_WORDS };
