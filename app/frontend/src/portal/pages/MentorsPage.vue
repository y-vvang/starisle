<script setup>
// #/mentors —— 导师目录 + 指导申请 + 合作机构。
//
// 申请表只有四个字段,全是"想做什么"而不是"你是谁" —— 平台不收未成年人的真实姓名、
// 学校年级、联系方式。站长要联系申请人用的是注册邮箱。
// 导师的联系方式只给站长看,对接由站长在站外完成,所以这里没有任何"联系导师"入口。
import { ref, computed, onMounted, watch } from 'vue';
import { store, requireLogin } from '../store';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

const mentors = ref([]);
const partners = ref([]);
const myReq = ref({});           // mentor slug -> 我的申请状态
const course = ref('');
const cat = ref('中学');
const loading = ref(true);
const busy = ref(false);

const applyFor = ref(null);      // 正在申请的导师
const f = ref({ interest: '', background: '', questions: '', weekly_hours: '2-4h' });
const err = ref('');

const HOURS = ['<2h', '2-4h', '4-6h', '>6h'];
const CATS = ['中学', '大学', '企业'];
const LABEL = { pending: '申请审核中', approved: '已通过,等待对接', completed: '已对接', rejected: '未通过' };

// 选项只在「全部课程」那次结果上算一次,之后固定不变。
// 若从**已筛选**的 mentors 推导(它是 computed 时的写法),选中「线代」之后列表只剩一位
// 导师,下拉选项就会跟着塌缩成他教的那三门 —— 其余课从选项里消失,用户必须先切回
// 「全部课程」才能换一门筛。
const courseOptions = ref([]);
const shownPartners = computed(() => partners.value.filter(p => p.category === cat.value));

async function load() {
  loading.value = true;
  const [ms, ps] = await Promise.all([
    api('/mentors' + (course.value ? `?course=${encodeURIComponent(course.value)}` : '')),
    api('/partners'),
  ]);
  mentors.value = (ms && ms.mentors) || [];
  partners.value = (ps && ps.partners) || [];
  if (!course.value) {
    const s = new Set();
    for (const m of mentors.value) for (const c of (m.courses || [])) s.add(c.title);
    courseOptions.value = [...s].sort();
  }
  loading.value = false;
  await loadMine();
}
async function loadMine() {
  myReq.value = {};
  if (!store.user) return;
  const r = await api('/my/mentor-requests');
  for (const q of (r && r.requests) || []) {
    // 同一位导师可能有历史记录,列表按时间倒序,第一条就是最新的
    if (!myReq.value[q.mentor.slug]) myReq.value[q.mentor.slug] = q;
  }
}
onMounted(load);
watch(() => store.user, loadMine);

function openApply(m) {
  if (!requireLogin('申请指导')) return;
  err.value = '';
  f.value = { interest: '', background: '', questions: '', weekly_hours: '2-4h' };
  applyFor.value = m;
}

async function submit() {
  err.value = '';
  if (!f.value.interest.trim()) { err.value = '请写一句你想做的方向'; return; }
  busy.value = true;
  const r = await post(`/mentors/${encodeURIComponent(applyFor.value.slug)}/requests`, f.value);
  busy.value = false;
  if (!r || r.error) { err.value = (r && r.error) || '提交失败,请稍后再试'; return; }
  toast('申请已提交,等站长安排 ✦');
  applyFor.value = null;
  await loadMine();
}

async function withdraw(m) {
  const q = myReq.value[m.slug];
  if (!q || q.status !== 'pending') return;
  if (!confirm('撤回这条申请?')) return;
  const r = await post(`/mentor-requests/${q.id}/withdraw`, {});
  if (!r || r.error) return toast((r && r.error) || '撤回失败');
  toast('已撤回');
  await loadMine();
}
</script>

<template>
  <div class="page wrap">
    <div class="mt-head">
      <div class="jm-kick">导师 · MENTORS</div>
      <h2>找一位带过路的人</h2>
      <p class="dim">
        申请由站长审核,通过后由站长帮你和导师对接。<b>申请表不收姓名、学校和联系方式</b> ——
        你是谁由登录账号决定。
      </p>
    </div>

    <div class="mt-tools" v-if="courseOptions.length">
      <label class="dim">按课程筛选</label>
      <select v-model="course" @change="load">
        <option value="">全部课程</option>
        <option v-for="t in courseOptions" :key="t" :value="t">{{ t }}</option>
      </select>
    </div>

    <p v-if="loading" class="dim">载入中…</p>
    <p v-else-if="!mentors.length" class="dim mt-empty">这个筛选下还没有导师。</p>

    <div v-else class="grid c3">
      <div v-for="m in mentors" :key="m.id" class="card mt-card">
        <div class="mt-name">{{ m.name }}<span class="dim mt-title" v-if="m.title"> · {{ m.title }}</span></div>
        <p class="dim mt-bio" v-if="m.bio">{{ m.bio }}</p>
        <div class="chips-flow mt-courses">
          <span class="chip" v-for="c in m.courses" :key="c.title">
            {{ c.title }}<span class="dim" v-if="c.total_hours"> · {{ c.total_hours }} 课时</span>
          </span>
        </div>
        <div class="mt-act">
          <template v-if="myReq[m.slug]">
            <span class="mt-state" :class="'st-' + myReq[m.slug].status">
              {{ LABEL[myReq[m.slug].status] || myReq[m.slug].status }}
            </span>
            <button v-if="myReq[m.slug].status === 'pending'" class="btn small ghost" @click="withdraw(m)">撤回</button>
            <button v-else-if="myReq[m.slug].status === 'rejected'" class="btn small ghost" @click="openApply(m)">重新申请</button>
          </template>
          <button v-else class="btn small primary" @click="openApply(m)"><Icon name="send" /> 申请指导</button>
        </div>
      </div>
    </div>

    <!-- 合作机构 -->
    <section class="mt-partners" v-if="partners.length">
      <div class="mt-head">
        <div class="jm-kick">合作机构 · PARTNERS</div>
        <h2>学员来自这些学校</h2>
      </div>
      <div class="cs-tabs">
        <button v-for="c in CATS" :key="c" class="mode-tab" :class="{ on: cat === c }" @click="cat = c">{{ c }}</button>
      </div>
      <p v-if="!shownPartners.length" class="dim mt-empty">这一类下还没有登记的机构。</p>
      <div v-else class="grid c4 mt-orgs">
        <a v-for="p in shownPartners" :key="p.id" class="card mt-org"
           :href="p.website || undefined" :target="p.website ? '_blank' : undefined"
           :rel="p.website ? 'noopener' : undefined">
          <span class="mt-mono">{{ p.monogram || p.name.slice(0, 2) }}</span>
          <span class="mt-org-name">{{ p.name }}</span>
          <span class="dim mt-coop" v-if="p.cooperation">{{ p.cooperation }}</span>
        </a>
      </div>
    </section>

    <!-- 申请弹窗 -->
    <Teleport to="body">
      <div class="join-mask" :class="{ open: !!applyFor }" @click="applyFor = null"></div>
      <div class="join-modal" :class="{ open: !!applyFor }" v-if="applyFor">
        <button class="close-x" @click="applyFor = null" aria-label="关闭"><Icon name="x" /></button>
        <div class="jm-head">
          <div class="jm-kick">申请指导</div>
          <h3>向「{{ applyFor.name }}」提交申请</h3>
          <p>只问你想做什么。姓名、学校、联系方式一概不填 —— 站长通过你的账号就能联系到你。</p>
        </div>
        <div class="form-field"><label>想做的方向 *</label>
          <textarea v-model="f.interest" maxlength="1000" rows="2" placeholder="例如:想做用 AI 帮同学整理错题的小工具"></textarea></div>
        <div class="form-field"><label>已经会的(选填)</label>
          <textarea v-model="f.background" maxlength="1000" rows="2" placeholder="学过什么、做过什么"></textarea></div>
        <div class="form-field"><label>想请教的问题(选填)</label>
          <textarea v-model="f.questions" maxlength="1000" rows="2"></textarea></div>
        <div class="form-field"><label>每周能投入</label>
          <select v-model="f.weekly_hours">
            <option v-for="h in HOURS" :key="h" :value="h">{{ h }}</option>
          </select></div>
        <div class="field-hint">请不要在上面几栏里写真实姓名、学校或电话。</div>
        <p class="jm-err" v-if="err">{{ err }}</p>
        <button class="btn primary wide" :disabled="busy" @click="submit">
          <Icon name="send" /> {{ busy ? '提交中…' : '提交申请' }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page { padding-top: 96px; padding-bottom: 80px; }
.mt-head { margin: 0 0 22px; }
.mt-head h2 { font-size: 30px; font-weight: 800; margin: 6px 0 8px; }
.mt-head p { max-width: 62ch; line-height: 1.7; }
.mt-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; font-size: 13px; }
.mt-empty { padding: 30px 0; }
.mt-card { display: flex; flex-direction: column; gap: 8px; }
.mt-name { font-size: 17px; font-weight: 700; }
.mt-title { font-size: 13px; font-weight: 400; }
.mt-bio { font-size: 13.5px; line-height: 1.6; }
.mt-courses { margin-top: 2px; }
.mt-act { margin-top: auto; padding-top: 10px; display: flex; align-items: center; gap: 8px; }
.mt-state { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); }
.st-approved, .st-completed { color: #1f7a4d; border-color: rgba(31,122,77,.35); background: rgba(31,122,77,.07); }
.st-pending { color: var(--polaris); border-color: rgba(194,137,27,.35); background: rgba(194,137,27,.07); }
.st-rejected { color: #b3261e; border-color: rgba(179,38,30,.3); background: rgba(179,38,30,.06); }
.mt-partners { margin-top: 60px; padding-top: 40px; border-top: 1px solid var(--line); }
.cs-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.mode-tab { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--line);
            background: transparent; color: var(--ink-3); font: inherit; font-size: 13px;
            font-weight: 600; cursor: pointer; transition: all .2s; }
.mode-tab:hover { color: var(--ink-2); border-color: var(--line-strong); }
.mode-tab.on { background: rgba(255, 210, 125, .14); border-color: var(--polaris); color: var(--polaris); }
.mt-orgs { gap: 14px; }
.mt-org { display: flex; flex-direction: column; align-items: center; gap: 8px;
          text-align: center; padding: 18px 12px; }
.mt-mono { width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center;
           font-weight: 800; font-size: 15px; color: var(--polaris);
           background: rgba(255,210,125,.12); border: 1px solid rgba(255,210,125,.3); }
.mt-org-name { font-size: 13px; font-weight: 600; line-height: 1.4; }
.mt-coop { font-size: 12px; line-height: 1.5; }
</style>
