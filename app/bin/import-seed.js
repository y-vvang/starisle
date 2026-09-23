'use strict';
// 导入导师与合作机构的初始数据。**幂等**:按 name 找已有行,有就更新、没有才插入,
// 可以反复跑。数据在 app/db/seed/*.json。
//
// 为什么是 CLI 而不是写进迁移:迁移里应该只有结构和真正的枚举(比如 001 里的 6 个
// domains)。导师和学校是会变的业务数据,站长在后台改完之后不该被下一次 migrate 覆盖回去。
//
// 用法:
//   DATABASE_URL=... node app/bin/import-seed.js            # 导入全部
//   DATABASE_URL=... node app/bin/import-seed.js courses    # 只导入课程
//   DATABASE_URL=... node app/bin/import-seed.js mentors    # 只导入导师
//   DATABASE_URL=... node app/bin/import-seed.js partners   # 只导入机构
const fs = require('node:fs');
const path = require('node:path');
const { pool, query, tx } = require('../db/pool');
const { uniqueSlug } = require('../lib/slug');

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '../db/seed', f), 'utf8'));

async function importMentors() {
  const list = read('mentors.json');
  let added = 0, updated = 0;
  for (const m of list) {
    const cur = await query('SELECT id FROM mentors WHERE name=$1', [m.name]);
    await tx(async (c) => {
      let id;
      if (cur.rowCount) {
        id = cur.rows[0].id;
        await c.query(
          `UPDATE mentors SET title=$1, bio=$2, contact_email=$3, sort=$4, updated_at=now()
            WHERE id=$5`,
          [m.title, m.bio, m.contact_email, m.sort, id]);
        updated++;
      } else {
        const slug = await uniqueSlug(m.name, 'mentors');
        const r = await c.query(
          `INSERT INTO mentors (slug,name,title,bio,contact_email,sort)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [slug, m.name, m.title, m.bio, m.contact_email, m.sort]);
        id = r.rows[0].id;
        added++;
      }
      // 课程条目整表替换 —— 与 PATCH /api/admin/mentors/:id 同一个语义
      await c.query('DELETE FROM mentor_courses WHERE mentor_id=$1', [id]);
      for (const [i, x] of (m.courses || []).entries()) {
        await c.query(
          `INSERT INTO mentor_courses (mentor_id,title,total_hours,level,sort)
           VALUES ($1,$2,$3,$4,$5)`, [id, x.title, x.total_hours, x.level, i]);
      }
    });
  }
  console.log(`  导师:新增 ${added} / 更新 ${updated}(共 ${list.length} 条)`);
}

async function importCourses() {
  const list = read('courses.json');
  let added = 0, updated = 0;
  for (const c of list) {
    const cur = await query('SELECT id FROM courses WHERE title=$1', [c.title]);
    await tx(async (t) => {
      let id;
      if (cur.rowCount) {
        id = cur.rows[0].id;
        // 不动 status —— 站长可能已经把某门课下架了,重跑导入不该把它又发布出去
        await t.query(
          `UPDATE courses SET subject=$1, track=$2, summary=$3, description=$4,
                  instructors=$5, audience=$6, total_hours=$7, featured=$8, updated_at=now()
            WHERE id=$9`,
          [c.subject, c.track, c.summary, c.description, c.instructors,
           c.audience, c.total_hours, c.featured, id]);
        updated++;
      } else {
        const slug = await uniqueSlug(c.title, 'courses');
        // 新建即 published:与上游一致(它启动后课程目录就是可浏览的),否则全新部署的
        // 课程中心是一片空白,而导师页却已经在说「某老师开设微积分」—— 站点自相矛盾。
        // 站长随时可以在后台下架。
        const r = await t.query(
          `INSERT INTO courses (slug,title,subject,track,summary,description,
                                instructors,audience,total_hours,featured,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published') RETURNING id`,
          [slug, c.title, c.subject, c.track, c.summary, c.description,
           c.instructors, c.audience, c.total_hours, c.featured]);
        id = r.rows[0].id;
        added++;
      }
      // 课节整表替换。注意这会丢掉站长手工加的课节 —— 但种子里的课纲本来就是权威版本,
      // 而且课节没有外部引用(报名挂在课程上,不挂课节),重建是安全的。
      await t.query('DELETE FROM course_lessons WHERE course_id=$1', [id]);
      for (const l of (c.lessons || [])) {
        await t.query(
          `INSERT INTO course_lessons (course_id,position,title,summary,duration_minutes)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, l.position, l.title, l.summary, l.duration_minutes]);
      }
    });
  }
  console.log(`  课程:新增 ${added} / 更新 ${updated}(共 ${list.length} 门)`);
}

async function importPartners() {
  const list = read('partner_orgs.json');
  let added = 0, updated = 0;
  for (const p of list) {
    const cur = await query('SELECT id, cooperation FROM partner_orgs WHERE name=$1', [p.name]);
    if (cur.rowCount) {
      // cooperation 是站长在后台填的,种子里全是空 —— 不要用空值把人填的内容盖掉
      await query(
        `UPDATE partner_orgs SET category=$1, website=$2, monogram=$3, sort=$4,
                cooperation=COALESCE($5, cooperation), updated_at=now()
          WHERE id=$6`,
        [p.category, p.website, p.monogram, p.sort, p.cooperation, cur.rows[0].id]);
      updated++;
    } else {
      const slug = await uniqueSlug(p.name, 'partner_orgs');
      await query(
        `INSERT INTO partner_orgs (slug,name,category,website,cooperation,monogram,sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [slug, p.name, p.category, p.website, p.cooperation, p.monogram, p.sort]);
      added++;
    }
  }
  console.log(`  合作机构:新增 ${added} / 更新 ${updated}(共 ${list.length} 条)`);
}

async function main() {
  const what = process.argv[2] || 'all';
  if (!['all', 'courses', 'mentors', 'partners'].includes(what)) {
    console.error('用法: node app/bin/import-seed.js [all|courses|mentors|partners]');
    process.exit(1);
  }
  console.log('导入初始数据…');
  if (what === 'all' || what === 'courses') await importCourses();
  if (what === 'all' || what === 'mentors') await importMentors();
  if (what === 'all' || what === 'partners') await importPartners();
  console.log('完成。');
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { importCourses, importMentors, importPartners };
