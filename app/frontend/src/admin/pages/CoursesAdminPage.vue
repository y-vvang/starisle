<script setup lang="ts">
// 后台 · 课程管理:课程库(建/改/发布/下架)、课节编排、学习申请审批。
import { ref, computed, onMounted } from 'vue';
import { api, post, patch, del, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';
import PaginationBar from '../../components/PaginationBar.vue';

const TRACKS: Record<string, string> = { math: '数学基础', literacy: '人工智能通识',
                 extension: '学科拓展', application: 'AI 编程与应用' };
const STATUS: Record<string, string> = { draft: '草稿', pending: '待审', published: '已发布', archived: '已下架' };

interface CourseForm {
  title: string; track: string; subject: string; summary: string;
  description: string; instructors: string; audience: string;
  total_hours: string; featured: boolean;
}
const blank = (): CourseForm => ({ title: '', track: 'math', subject: '', summary: '', description: '',
                       instructors: '', audience: '', total_hours: '', featured: false });
const f = ref<CourseForm>(blank());
const editing = ref<number | null>(null);      // null = 新建

const tab = ref('lib');
const courses = ref<any[]>([]);
const requests = ref<any[]>([]);
const lessons = ref<any[]>([]);
const reqPage = ref(1);
const reqPagination = ref({ page: 1, per_page: 20, total: 0, total_pages: 1 });
const sel = ref<number | null>(null);   // 当前编辑/编排的课程 id
const busy = ref('');
const err = ref('');

async function loadCourses() {
  const r = await api('/admin/courses');
  courses.value = (r && r.courses) || [];
}
// 申请 tab 只拉待处理的队列(?status=pending);页头计数用 pagination.total
// (列表被 per_page 截断后 length 只是第一页条数)。课程库 tab 不分页:
// 课节编排的下拉需要全量,站长建课量级有界(见 C1 决策)。
async function loadRequests(p = reqPage.value) {
  reqPage.value = p;
  const r = await api('/admin/course-enrollments?status=pending' + (p > 1 ? `&page=${p}` : ''));
  requests.value = (r && r.requests) || [];
  reqPagination.value = (r && r.pagination) || reqPagination.value;
}
async function loadRequestsClamped() {
  await loadRequests();
  const tp = reqPagination.value.total_pages;
  if (reqPage.value > tp) await loadRequests(Math.max(1, tp));
}
async function loadLessons(slug: string | null | undefined) {
  if (!slug) { lessons.value = []; return; }
  const r = await api('/courses/' + encodeURIComponent(slug));
  lessons.value = (r && r.lessons) || [];
}
onMounted(async () => { await loadCourses(); await loadRequests(); });

const selCourse = computed(() => courses.value.find(c => c.id === sel.value) || null);

function startNew() { editing.value = null; f.value = blank(); err.value = ''; }
function startEdit(c: any) {
  editing.value = c.id; err.value = '';
  f.value = { title: c.title || '', track: c.track, subject: c.subject || '',
              summary: c.summary || '', description: c.description || '',
              instructors: c.instructors || '', audience: c.audience || '',
              total_hours: c.total_hours == null ? '' : String(c.total_hours),
              featured: !!c.featured };
}

async function save() {
  err.value = '';
  if (!f.value.title.trim()) { err.value = '请填写课程名'; return; }
  const body = { ...f.value,
    total_hours: f.value.total_hours === '' ? null : Number(f.value.total_hours) };
  busy.value = 'save';
  const r = editing.value
    ? await patch(`/admin/courses/${editing.value}`, body)
    : await post('/admin/courses', body);
  busy.value = '';
  if (!r || r.error) { err.value = (r && r.error) || '保存失败'; return; }
  toast(editing.value ? '已保存' : '课程已创建');
  await loadCourses();
  if (!editing.value) startNew();
}

async function review(c: any, decision: string) {
  busy.value = 'r' + c.id;
  const r = await post(`/admin/courses/${c.id}/review`, { decision });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(decision === 'approve' ? `已发布「${c.title}」` : `已退回「${c.title}」`);
  await loadCourses();
}

async function setStatus(c: any, status: string) {
  busy.value = 's' + c.id;
  const r = await patch(`/admin/courses/${c.id}`, { status });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(`「${c.title}」已${STATUS[status]}`);
  await loadCourses();
}

// —— 课节 ——
const lf = ref({ title: '', duration_minutes: '', summary: '' });
async function pickCourse(id: number | null) {
  sel.value = id;
  const c = courses.value.find(x => x.id === id);
  await loadLessons(c && c.slug);
}
async function addLesson() {
  if (!sel.value || !lf.value.title.trim()) return;
  busy.value = 'lesson';
  const r = await post(`/admin/courses/${sel.value}/lessons`, {
    title: lf.value.title,
    duration_minutes: lf.value.duration_minutes === '' ? 0 : Number(lf.value.duration_minutes),
    summary: lf.value.summary,
  });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '添加失败');
  lf.value = { title: '', duration_minutes: '', summary: '' };
  await loadLessons(selCourse.value?.slug);
  await loadCourses();
}
async function removeLesson(l: any) {
  if (!confirm(`删除课节「${l.title}」?`)) return;
  busy.value = 'l' + l.id;
  const r = await del(`/admin/lessons/${l.id}`);
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '删除失败');
  await loadLessons(selCourse.value?.slug);
  await loadCourses();
}
// 上下移动:本地交换后把**完整顺序**提交上去(后端只接受一次性的全量顺序,
// 这样幂等、不会出现中间态)。
async function move(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= lessons.value.length) return;
  const ids = lessons.value.map(l => l.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  busy.value = 'move';
  const r = await post(`/admin/courses/${sel.value}/lessons/reorder`, { lesson_ids: ids });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '排序失败');
  await loadLessons(selCourse.value?.slug);
}

// —— 学习申请 ——
async function decide(req: any, decision: string) {
  busy.value = 'e' + req.id;
  const r = await post(`/admin/course-enrollments/${req.id}/review`, { decision });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(decision === 'approve' ? '已开通' : '已拒绝');
  await loadRequestsClamped();
}

function pickReqPage(p: number) { loadRequests(p); }
</script>

<template>
  <!-- 结构与其他四个后台页保持一致:section.admin-page.active。
       漏掉 .active 会被 global.css 的 display:none 藏掉(Task 18 踩过一次:
       DOM 全对、页面全白)。 -->
  <section class="admin-page active">
    <h2>课程管理 · Courses <span style="font-size:13px;color:var(--ink-3);font-weight:400">建课 · 编排课纲 · 审学习申请</span></h2>
    <p class="page-sub">课程由站长创建并发布,学习申请逐条审批。</p>

    <div class="ca-tabs">
      <button class="mode-tab" :class="{ on: tab === 'lib' }" @click="tab = 'lib'">课程库 ({{ courses.length }})</button>
      <button class="mode-tab" :class="{ on: tab === 'lesson' }" @click="tab = 'lesson'">课节编排</button>
      <button class="mode-tab" :class="{ on: tab === 'apply' }" @click="tab = 'apply'">
        学习申请 <span class="cnt" v-if="reqPagination.total">{{ reqPagination.total }}</span>
      </button>
    </div>

    <!-- 课程库 -->
    <div v-if="tab === 'lib'" class="ca-two">
      <div class="ca-list">
        <button class="btn small ghost ca-new" @click="startNew"><Icon name="star" /> 新建课程</button>
        <p v-if="!courses.length" class="dim">还没有课程。</p>
        <div v-for="c in courses" :key="c.id" class="card ca-row" :class="{ on: editing === c.id }">
          <div class="ca-row-main" @click="startEdit(c)">
            <div class="ca-row-title">{{ c.title }}</div>
            <div class="dim ca-row-sub">
              {{ TRACKS[c.track] }} · {{ STATUS[c.status] }} · {{ c.lesson_count || 0 }} 节
            </div>
          </div>
          <!-- 按状态给动作,而不是"非已发布就显示发布" —— 那样草稿会跳过审核队列直接上线,
               而待审的课也没有"退回草稿"的出口。 -->
          <div class="ca-row-act">
            <template v-if="c.status === 'draft' || c.status === 'archived'">
              <button class="btn small ghost" :disabled="busy === 's' + c.id"
                      @click="setStatus(c, 'pending')"><Icon name="send" /> 提交审核</button>
              <button class="btn small ok" :disabled="busy === 'r' + c.id"
                      @click="review(c, 'approve')"><Icon name="check" /> 直接发布</button>
            </template>
            <template v-else-if="c.status === 'pending'">
              <button class="btn small ok" :disabled="busy === 'r' + c.id"
                      @click="review(c, 'approve')"><Icon name="check" /> 发布</button>
              <button class="btn small ghost" :disabled="busy === 'r' + c.id"
                      @click="review(c, 'reject')"><Icon name="back" /> 退回草稿</button>
            </template>
            <button v-else class="btn small ghost" :disabled="busy === 's' + c.id"
                    @click="setStatus(c, 'archived')"><Icon name="x" /> 下架</button>
          </div>
        </div>
      </div>

      <div class="card ca-form">
        <h3>{{ editing ? '编辑课程' : '新建课程' }}</h3>
        <div class="form-field"><label>课程名</label><input v-model="f.title" maxlength="120" /></div>
        <div class="form-field"><label>一级分类</label>
          <select v-model="f.track">
            <option v-for="(label, id) in TRACKS" :key="id" :value="id">{{ label }}</option>
          </select></div>
        <div class="form-field"><label>课程方向</label><input v-model="f.subject" maxlength="60" placeholder="微积分 / 线性代数" /></div>
        <div class="form-field"><label>授课教师</label><input v-model="f.instructors" maxlength="200" placeholder="张老师、李老师" /></div>
        <div class="form-field"><label>总课时(留空 = 持续更新)</label><input v-model="f.total_hours" placeholder="12" /></div>
        <div class="form-field"><label>适合人群</label><input v-model="f.audience" maxlength="200" /></div>
        <div class="form-field"><label>摘要</label><textarea v-model="f.summary" maxlength="500" rows="2"></textarea></div>
        <div class="form-field"><label>详细介绍</label><textarea v-model="f.description" maxlength="8000" rows="4"></textarea></div>
        <label class="ca-check"><input type="checkbox" v-model="f.featured" /> 首页精选</label>
        <p class="jm-err" v-if="err">{{ err }}</p>
        <div class="ca-actions">
          <button class="btn primary" :disabled="busy === 'save'" @click="save">
            <Icon name="check" /> {{ busy === 'save' ? '保存中…' : '保存' }}
          </button>
          <button v-if="editing" class="btn ghost" @click="startNew">取消编辑</button>
        </div>
      </div>
    </div>

    <!-- 课节编排 -->
    <div v-else-if="tab === 'lesson'">
      <div class="form-field ca-pick"><label>选择课程</label>
        <select :value="sel" @change="pickCourse(Number(($event.target as HTMLInputElement).value))">
          <option :value="null">— 请选择 —</option>
          <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select></div>

      <template v-if="sel">
        <div v-for="(l, i) in lessons" :key="l.id" class="card ca-lesson">
          <span class="ca-l-no">{{ String(l.position).padStart(2, '0') }}</span>
          <div class="ca-l-main">
            <div class="ca-l-title">{{ l.title }}</div>
            <div class="dim ca-l-sub">{{ l.duration_minutes ? l.duration_minutes + ' 分钟' : '专题课节' }}<span v-if="l.summary"> · {{ l.summary }}</span></div>
          </div>
          <div class="ca-l-act">
            <button class="btn small ghost" :disabled="i === 0 || busy === 'move'" @click="move(i, -1)">↑</button>
            <button class="btn small ghost" :disabled="i === lessons.length - 1 || busy === 'move'" @click="move(i, 1)">↓</button>
            <button class="btn small danger" :disabled="busy === 'l' + l.id" @click="removeLesson(l)"><Icon name="x" /></button>
          </div>
        </div>
        <p v-if="!lessons.length" class="dim">这门课还没有课节。</p>

        <div class="card ca-form ca-addlesson">
          <h3>新增课节</h3>
          <div class="form-field"><label>标题</label><input v-model="lf.title" maxlength="120" /></div>
          <div class="form-field"><label>时长(分钟,留空 = 专题课节)</label><input v-model="lf.duration_minutes" placeholder="45" /></div>
          <div class="form-field"><label>摘要</label><textarea v-model="lf.summary" maxlength="1000" rows="2"></textarea></div>
          <button class="btn primary" :disabled="busy === 'lesson' || !lf.title.trim()" @click="addLesson">
            <Icon name="check" /> 添加
          </button>
        </div>
      </template>
      <p v-else class="dim">先选一门课。</p>
    </div>

    <!-- 学习申请 -->
    <div v-else>
      <p v-if="!requests.length" class="dim">还没有学习申请。</p>
      <div v-for="r in requests" :key="r.id" class="card ca-req">
        <div class="ca-req-main">
          <div class="ca-req-title">
            {{ r.user.display_name || r.user.username }}
            <span class="dim">· @{{ r.user.username }}</span>
            <span class="badge" :class="'st-' + r.status">{{ r.status === 'pending' ? '待处理' : r.status === 'approved' ? '已开通' : '已拒绝' }}</span>
          </div>
          <div class="dim ca-req-sub">申请学习「{{ r.course.title }}」</div>
          <p v-if="r.message" class="ca-req-msg">"{{ r.message }}"</p>
        </div>
        <div class="ca-req-act" v-if="r.status === 'pending'">
          <button class="btn small ok" :disabled="busy === 'e' + r.id" @click="decide(r, 'approve')"><Icon name="check" /> 开通</button>
          <button class="btn small ghost" :disabled="busy === 'e' + r.id" @click="decide(r, 'reject')"><Icon name="x" /> 拒绝</button>
        </div>
      </div>

      <PaginationBar :page="reqPagination.page" :per-page="reqPagination.per_page"
                     :total="reqPagination.total" @change="pickReqPage" />
    </div>
  </section>
</template>

<style scoped>
.ca-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
/* .mode-tab 是 portal 侧 JoinModal 的 scoped 类,后台这边要自己带一份。 */
.mode-tab { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--line);
            background: transparent; color: var(--ink-3); font: inherit; font-size: 13px;
            font-weight: 600; cursor: pointer; transition: all .2s; }
.mode-tab:hover { color: var(--ink-2); border-color: var(--line-strong); }
.mode-tab.on { background: rgba(255, 210, 125, .14); border-color: var(--polaris); color: var(--polaris); }
.cnt { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 6px;
       border-radius: 999px; background: var(--polaris); color: #fff; font-size: 11px; }
.ca-two { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; align-items: start; }
.ca-list { display: flex; flex-direction: column; gap: 10px; }
.ca-new { align-self: flex-start; }
.ca-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.ca-row.on { border-color: var(--polaris); }
.ca-row-main { flex: 1; cursor: pointer; }
.ca-row-title { font-weight: 600; }
.ca-row-sub { font-size: 12.5px; margin-top: 3px; }
.ca-row-act { display: flex; gap: 6px; }
.ca-form { padding: 18px; }
.ca-form h3 { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
.ca-check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; margin: 4px 0 14px; }
.ca-actions { display: flex; gap: 10px; }
.ca-pick { max-width: 380px; margin-bottom: 18px; }
.ca-lesson { display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-bottom: 8px; }
.ca-l-no { font-weight: 800; color: var(--polaris); font-size: 13px; }
.ca-l-main { flex: 1; }
.ca-l-title { font-weight: 600; }
.ca-l-sub { font-size: 12.5px; margin-top: 3px; }
.ca-l-act { display: flex; gap: 6px; }
.ca-addlesson { margin-top: 18px; max-width: 520px; }
.ca-req { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; margin-bottom: 10px; }
.ca-req-main { flex: 1; }
.ca-req-title { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ca-req-sub { font-size: 13px; margin-top: 4px; }
.ca-req-msg { font-size: 13px; font-style: italic; color: var(--ink-2); margin-top: 8px; }
.ca-req-act { display: flex; gap: 6px; }
.st-approved { color: #1f7a4d; }
.st-rejected { color: #b3261e; }
@media (max-width: 1000px) { .ca-two { grid-template-columns: 1fr; } }
</style>
