// 导入导师与合作机构的初始数据。**幂等**:按 name 找已有行,有就更新、没有才插入,
// 可以反复跑。数据在 app/db/seed/*.json。
//
// 为什么是 CLI 而不是写进迁移:迁移里应该只有结构和真正的枚举(比如 001 里的 6 个
// domains)。导师和学校是会变的业务数据,站长在后台改完之后不该被下一次 migrate 覆盖回去。
//
// 用法:
//   bun app/bin/import-seed.ts            # 导入全部
//   bun app/bin/import-seed.ts courses    # 只导入课程
//   bun app/bin/import-seed.ts mentors    # 只导入导师
//   bun app/bin/import-seed.ts partners   # 只导入机构
//   (npm run seed -- mentors 同效)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, db, tx } from '../db/pool';
import { courses, courseLessons, mentors, mentorCourses, partnerOrgs } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { uniqueSlug } from '../lib/slug';

const read = (f: string): any[] => JSON.parse(readFileSync(join(import.meta.dir, '../db/seed', f), 'utf8'));

async function importMentors() {
  const list = read('mentors.json');
  let added = 0, updated = 0;
  for (const m of list) {
    const cur = await db.select({ id: mentors.id }).from(mentors).where(eq(mentors.name, m.name));
    await tx(async (c) => {
      let id: number;
      if (cur.length) {
        id = cur[0].id;
        await c.update(mentors).set({
          title: m.title, bio: m.bio, contact_email: m.contact_email,
          sort: m.sort, updated_at: sql`now()`,
        }).where(eq(mentors.id, id));
        updated++;
      } else {
        const slug = await uniqueSlug(m.name, 'mentors');
        const r = await c.insert(mentors).values({
          slug, name: m.name, title: m.title, bio: m.bio,
          contact_email: m.contact_email, sort: m.sort,
        }).returning({ id: mentors.id });
        id = r[0].id;
        added++;
      }
      // 课程条目整表替换 —— 与 PATCH /api/admin/mentors/:id 同一个语义
      await c.delete(mentorCourses).where(eq(mentorCourses.mentor_id, id));
      for (const [i, x] of (m.courses || []).entries()) {
        await c.insert(mentorCourses).values({
          mentor_id: id, title: x.title, total_hours: x.total_hours, level: x.level, sort: i,
        });
      }
    });
  }
  console.log(`  导师:新增 ${added} / 更新 ${updated}(共 ${list.length} 条)`);
}

async function importCourses() {
  const list = read('courses.json');
  let added = 0, updated = 0;
  for (const c of list) {
    const cur = await db.select({ id: courses.id }).from(courses).where(eq(courses.title, c.title));
    await tx(async (t) => {
      let id: number;
      if (cur.length) {
        id = cur[0].id;
        // 不动 status —— 站长可能已经把某门课下架了,重跑导入不该把它又发布出去
        await t.update(courses).set({
          subject: c.subject, track: c.track, summary: c.summary, description: c.description,
          instructors: c.instructors, audience: c.audience, total_hours: c.total_hours,
          featured: c.featured, updated_at: sql`now()`,
        }).where(eq(courses.id, id));
        updated++;
      } else {
        const slug = await uniqueSlug(c.title, 'courses');
        // 新建即 published:与上游一致(它启动后课程目录就是可浏览的),否则全新部署的
        // 课程中心是一片空白,而导师页却已经在说「某老师开设微积分」—— 站点自相矛盾。
        // 站长随时可以在后台下架。
        const r = await t.insert(courses).values({
          slug, title: c.title, subject: c.subject, track: c.track,
          summary: c.summary, description: c.description, instructors: c.instructors,
          audience: c.audience, total_hours: c.total_hours, featured: c.featured,
          status: 'published',
        }).returning({ id: courses.id });
        id = r[0].id;
        added++;
      }
      // 课节整表替换。注意这会丢掉站长手工加的课节 —— 但种子里的课纲本来就是权威版本,
      // 而且课节没有外部引用(报名挂在课程上,不挂课节),重建是安全的。
      await t.delete(courseLessons).where(eq(courseLessons.course_id, id));
      for (const l of (c.lessons || [])) {
        await t.insert(courseLessons).values({
          course_id: id, position: l.position, title: l.title,
          summary: l.summary, duration_minutes: l.duration_minutes,
        });
      }
    });
  }
  console.log(`  课程:新增 ${added} / 更新 ${updated}(共 ${list.length} 门)`);
}

async function importPartners() {
  const list = read('partner_orgs.json');
  let added = 0, updated = 0;
  for (const p of list) {
    const cur = await db.select({ id: partnerOrgs.id, cooperation: partnerOrgs.cooperation })
      .from(partnerOrgs).where(eq(partnerOrgs.name, p.name));
    if (cur.length) {
      // cooperation 是站长在后台填的,种子里全是空 —— 不要用空值把人填的内容盖掉
      // (COALESCE 语义保留:仅在传入值为 null 时保留旧值)
      await db.update(partnerOrgs).set({
        category: p.category, website: p.website, monogram: p.monogram, sort: p.sort,
        cooperation: sql`COALESCE(${p.cooperation ?? null}, ${cur[0].cooperation})`,
        updated_at: sql`now()`,
      }).where(eq(partnerOrgs.id, cur[0].id));
      updated++;
    } else {
      const slug = await uniqueSlug(p.name, 'partner_orgs');
      await db.insert(partnerOrgs).values({
        slug, name: p.name, category: p.category, website: p.website,
        cooperation: p.cooperation, monogram: p.monogram, sort: p.sort,
      });
      added++;
    }
  }
  console.log(`  合作机构:新增 ${added} / 更新 ${updated}(共 ${list.length} 条)`);
}

async function main() {
  const what = process.argv[2] || 'all';
  if (!['all', 'courses', 'mentors', 'partners'].includes(what)) {
    console.error('用法: bun app/bin/import-seed.ts [all|courses|mentors|partners]');
    process.exit(1);
  }
  console.log('导入初始数据…');
  if (what === 'all' || what === 'courses') await importCourses();
  if (what === 'all' || what === 'mentors') await importMentors();
  if (what === 'all' || what === 'partners') await importPartners();
  console.log('完成。');
  await pool.end();
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}
export { importCourses, importMentors, importPartners };
