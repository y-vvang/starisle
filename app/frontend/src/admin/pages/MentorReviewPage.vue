<script setup lang="ts">
// 后台 · 导师申请审批。
// 三段:待处理 / 已通过待对接(**只有这里显示导师邮箱**,供站长在站外联系)/ 处理留痕。
// 申请里没有申请人的姓名、学校、联系方式 —— 本项目不收这些;要联系申请人用注册邮箱。
import { ref, computed, onMounted } from 'vue';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

const list = ref<any[]>([]);
const busy = ref<string | number>('');

async function load() {
  const r = await api('/admin/mentor-requests');
  list.value = (r && r.requests) || [];
}
onMounted(load);

const pending   = computed(() => list.value.filter(x => x.status === 'pending'));
const approved  = computed(() => list.value.filter(x => x.status === 'approved'));
const archived  = computed(() => list.value.filter(x => ['rejected', 'completed'].includes(x.status)));

async function act(r: any, kind: string) {
  busy.value = r.id;
  const res = kind === 'complete'
    ? await post(`/admin/mentor-requests/${r.id}/complete`, {})
    : await post(`/admin/mentor-requests/${r.id}/review`, { decision: kind });
  busy.value = '';
  if (!res || res.error) return toast((res && res.error) || '操作失败');
  toast(kind === 'approve' ? '已通过,记得联系导师' : kind === 'reject' ? '已婉拒' : '已标记为对接完成');
  await load();
}

const who = (r: any) => r.user.display_name || r.user.username;
</script>

<template>
  <section class="admin-page active">
    <h2>导师申请 · Mentors <span style="font-size:13px;color:var(--ink-3);font-weight:400">审核 · 线下对接 · 留痕</span></h2>
    <p class="page-sub">通过之后由你按导师邮箱在站外联系,对接完成再回来点一下「已对接」。</p>

    <h3 class="sec-h"><Icon name="user" style="color:var(--warn)" /> 待处理 <span class="cnt">{{ pending.length }}</span></h3>
    <div class="empty" v-if="!pending.length"><Icon name="check" style="color:var(--ok)" /> 没有待处理的申请。</div>
    <div class="card mr" v-for="r in pending" :key="r.id">
      <div class="mr-head">
        <div>
          <div class="mr-who">{{ who(r) }} <span class="dim">· @{{ r.user.username }}</span></div>
          <div class="dim mr-sub">申请「{{ r.mentor.name }}」的指导 · 每周 {{ r.weekly_hours || '未填' }}</div>
        </div>
        <div class="mr-acts">
          <button class="btn small ok" :disabled="busy === r.id" @click="act(r, 'approve')"><Icon name="check" /> 通过</button>
          <button class="btn small ghost" :disabled="busy === r.id" @click="act(r, 'reject')"><Icon name="x" /> 婉拒</button>
        </div>
      </div>
      <dl class="mr-body">
        <dt>想做的方向</dt><dd>{{ r.interest }}</dd>
        <template v-if="r.background"><dt>已经会的</dt><dd>{{ r.background }}</dd></template>
        <template v-if="r.questions"><dt>想请教</dt><dd>{{ r.questions }}</dd></template>
      </dl>
    </div>

    <h3 class="sec-h"><Icon name="link" style="color:var(--polaris)" /> 已通过,待对接 <span class="cnt" v-if="approved.length">{{ approved.length }}</span></h3>
    <div class="empty" v-if="!approved.length"><Icon name="check" style="color:var(--ok)" /> 没有待对接的。</div>
    <div class="card mr" v-for="r in approved" :key="r.id">
      <div class="mr-head">
        <div>
          <div class="mr-who">{{ who(r) }} <span class="dim">· @{{ r.user.username }}</span></div>
          <div class="dim mr-sub">
            导师「{{ r.mentor.name }}」·
            <span class="mr-mail" v-if="r.mentor.contact_email">{{ r.mentor.contact_email }}</span>
            <span class="dim" v-else>(未登记邮箱)</span>
          </div>
        </div>
        <div class="mr-acts">
          <button class="btn small ok" :disabled="busy === r.id" @click="act(r, 'complete')"><Icon name="check" /> 已对接</button>
        </div>
      </div>
      <p class="mr-hint dim">导师邮箱只在这一页出现,不会给申请人看到。</p>
    </div>

    <h3 class="sec-h"><Icon name="scroll" /> 处理留痕</h3>
    <div class="empty" v-if="!archived.length">还没有已完成或已婉拒的申请。</div>
    <div class="card mr mr-done" v-for="r in archived" :key="r.id">
      <div class="mr-who">
        {{ who(r) }} <span class="dim">→ {{ r.mentor.name }}</span>
        <span class="mr-state" :class="'st-' + r.status">{{ r.status === 'completed' ? '已对接' : '已婉拒' }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec-h { font-size: 16px; margin: 26px 0 14px; display: flex; align-items: center; gap: 8px; }
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
