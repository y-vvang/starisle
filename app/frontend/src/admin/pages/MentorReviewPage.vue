<script setup lang="ts">
// 后台 · 导师申请审批。
// 三段:待处理 / 已通过待对接(**只有这里显示导师邮箱**,供站长在站外联系)/ 处理留痕。
// 原先是"全量拉回、本地三段切分"—— 分页后本地切分只能切当前页,改成按
// ?status= 服务端切分:pending / approved / rejected,completed(多值)。
// 申请里没有申请人的姓名、学校、联系方式 —— 本项目不收这些;要联系申请人用注册邮箱。
import { ref, computed, onMounted, watch } from 'vue';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';
import PaginationBar from '../../components/PaginationBar.vue';

type TabKey = 'pending' | 'approved' | 'archived';
const TABS: [TabKey, string, string][] = [
  ['pending', '待处理', 'pending'],
  ['approved', '已通过,待对接', 'approved'],
  ['archived', '处理留痕', 'rejected,completed'],
];

const tab = ref<TabKey>('pending');
const list = ref<any[]>([]);
const busy = ref<string | number>('');
const page = ref(1);
const pagination = ref({ page: 1, per_page: 20, total: 0, total_pages: 1 });
// 各 tab 的独立待办角标(进入页面时拉一次;翻 tab 时顺带刷新 own)
const tabCounts = ref<Record<string, number>>({ pending: 0, approved: 0, archived: 0 });

const currentQS = () => TABS.find(t => t[0] === tab.value)![2];

async function load(p = page.value) {
  page.value = p;
  const params = new URLSearchParams({ status: currentQS(), page: String(p) });
  const r = await api('/admin/mentor-requests?' + params.toString());
  list.value = (r && r.requests) || [];
  pagination.value = (r && r.pagination) || pagination.value;
  tabCounts.value[tab.value] = pagination.value.total;
}
async function loadCounts() {
  for (const [key, , st] of TABS) {
    const r = await api(`/admin/mentor-requests?status=${st}&per_page=1`);
    tabCounts.value[key] = (r && r.pagination && r.pagination.total) || 0;
  }
}
onMounted(async () => { await loadCounts(); await load(); });

// act 后重拉当前 tab,并按"这页删空了就退回上一页"钳制;别的 tab 的角标也要刷新
async function loadClamped() {
  await load();
  const tp = pagination.value.total_pages;
  if (page.value > tp) await load(Math.max(1, tp));
  await loadCounts();
}
watch(tab, () => load(1));

async function act(r: any, kind: string) {
  busy.value = r.id;
  const res = kind === 'complete'
    ? await post(`/admin/mentor-requests/${r.id}/complete`, {})
    : await post(`/admin/mentor-requests/${r.id}/review`, { decision: kind });
  busy.value = '';
  if (!res || res.error) return toast((res && res.error) || '操作失败');
  toast(kind === 'approve' ? '已通过,记得联系导师' : kind === 'reject' ? '已婉拒' : '已标记为对接完成');
  await loadClamped();
}

const who = (r: any) => r.user.display_name || r.user.username;
const showMail = computed(() => tab.value === 'approved');
</script>

<template>
  <section class="admin-page active">
    <h2>导师申请 · Mentors <span style="font-size:13px;color:var(--ink-3);font-weight:400">审核 · 线下对接 · 留痕</span></h2>
    <p class="page-sub">通过之后由你按导师邮箱在站外联系,对接完成再回来点一下「已对接」。</p>

    <!-- 三段改 status tab:?status= 服务端切分(本地切分只能切当前页,分页后会漏) -->
    <div class="mr-tabs">
      <button class="mode-tab" v-for="[key, label, st] in TABS" :key="key"
              :class="{ on: tab === key }" @click="tab = key">
        {{ label }} <span class="cnt" v-if="tabCounts[key]">{{ tabCounts[key] }}</span>
      </button>
    </div>

    <div class="empty" v-if="!list.length"><Icon name="check" style="color:var(--ok)" />
      {{ tab === 'pending' ? '没有待处理的申请。' : tab === 'approved' ? '没有待对接的。' : '还没有已完成或已婉拒的申请。' }}</div>

    <!-- 待处理 / 待对接 共用审批卡;留痕是瘦行 -->
    <div v-for="r in list" :key="r.id">
      <div v-if="tab !== 'archived'" class="card mr">
        <div class="mr-head">
          <div>
            <div class="mr-who">{{ who(r) }} <span class="dim">· @{{ r.user.username }}</span></div>
            <div class="dim mr-sub">
              <template v-if="tab === 'pending'">申请「{{ r.mentor.name }}」的指导 · 每周 {{ r.weekly_hours || '未填' }}</template>
              <template v-else>导师「{{ r.mentor.name }}」·
                <span class="mr-mail" v-if="r.mentor.contact_email">{{ r.mentor.contact_email }}</span>
                <span class="dim" v-else>(未登记邮箱)</span>
              </template>
            </div>
          </div>
          <div class="mr-acts">
            <template v-if="tab === 'pending'">
              <button class="btn small ok" :disabled="busy === r.id" @click="act(r, 'approve')"><Icon name="check" /> 通过</button>
              <button class="btn small ghost" :disabled="busy === r.id" @click="act(r, 'reject')"><Icon name="x" /> 婉拒</button>
            </template>
            <button v-else class="btn small ok" :disabled="busy === r.id" @click="act(r, 'complete')"><Icon name="check" /> 已对接</button>
          </div>
        </div>
        <dl class="mr-body">
          <dt>想做的方向</dt><dd>{{ r.interest }}</dd>
          <template v-if="r.background"><dt>已经会的</dt><dd>{{ r.background }}</dd></template>
          <template v-if="r.questions"><dt>想请教</dt><dd>{{ r.questions }}</dd></template>
        </dl>
        <p class="mr-hint dim" v-if="showMail">导师邮箱只在这一页出现,不会给申请人看到。</p>
      </div>
      <div v-else class="card mr mr-done">
        <div class="mr-who">
          {{ who(r) }} <span class="dim">→ {{ r.mentor.name }}</span>
          <span class="mr-state" :class="'st-' + r.status">{{ r.status === 'completed' ? '已对接' : '已婉拒' }}</span>
        </div>
      </div>
    </div>

    <PaginationBar :page="pagination.page" :per-page="pagination.per_page"
                   :total="pagination.total" @change="(p: number) => load(p)" />
  </section>
</template>

<style scoped>
.mr-tabs { display: flex; gap: 8px; margin: 20px 0 16px; flex-wrap: wrap; }
/* .mode-tab 与其他后台页同一份样式(CoursesAdminPage 也各带一份) */
.mode-tab { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--line);
            background: transparent; color: var(--ink-3); font: inherit; font-size: 13px;
            font-weight: 600; cursor: pointer; transition: all .2s; }
.mode-tab:hover { color: var(--ink-2); border-color: var(--line-strong); }
.mode-tab.on { background: rgba(255, 210, 125, .14); border-color: var(--polaris); color: var(--polaris); }
.cnt { font-size: 12px; color: var(--warn); background: rgba(251, 191, 36, .14); padding: 1px 9px; border-radius: 999px; }
.empty { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
.mr { margin-bottom: 12px; padding: 14px 16px; }
.mr-head { display: flex; align-items: flex-start; gap: 14px; }
.mr-head > div:first-child { flex: 1; }
.mr-who { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mr-sub { font-size: 12.5px; margin-top: 4px; }
.mr-mail { font-family: var(--mono, monospace); font-size: 12px; color: var(--astral); }
.mr-acts { display: flex; gap: 8px; flex: none; }
.mr-body { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line);
           display: grid; grid-template-columns: 88px 1fr; gap: 6px 14px; font-size: 13px; }
.mr-body dt { color: var(--ink-3); font-size: 12.5px; }
.mr-body dd { color: var(--ink-2); line-height: 1.6; }
.mr-hint { font-size: 12px; margin-top: 10px; }
.mr-done { padding: 10px 16px; }
.mr-state { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); }
.st-completed { color: #1f7a4d; border-color: rgba(31,122,77,.35); }
.st-rejected { color: var(--ink-3); }
</style>
