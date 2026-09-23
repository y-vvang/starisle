<script setup>
import { inject, onMounted, ref } from 'vue';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

const shared = inject('shared', { dname: {}, dcolor: {} });
const pending = ref([]);
const busy = ref('');

async function load() {
  const r = await api('/admin/projects/pending');
  pending.value = (r && r.projects) || [];
}
onMounted(load);

async function review(pj, decision) {
  busy.value = pj.id;
  const r = await post(`/admin/projects/${pj.id}/review`, { decision, note: decision === 'reject' ? '内容不完整,请补充后重投' : '' });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(decision === 'approve' ? `已通过「${r.name}」,已上线到项目中心` : `已驳回「${r.name}」`);
  await load();
}
</script>

<template>
  <section class="admin-page active">
    <h2>待审项目 · Projects <span style="font-size:13px;color:var(--ink-3);font-weight:400">发起 → 站长审核 → 上线</span></h2>
    <p class="page-sub">用户发起的项目先进这里,由站长核验内容完整性与仓库关联后再上线。通过后自动出现在项目中心;未通过的不对外展示。</p>

    <div class="empty" v-if="!pending.length"><Icon name="check" style="color:var(--ok)" /> 暂无待审核项目 —— 一切都已就绪。</div>

    <div class="card pj" v-for="pj in pending" :key="pj.id" :style="{ '--pc': shared.dcolor[pj.domain_id] || 'var(--astral)' }">
      <div class="pj-head">
        <div class="planet" :style="{ background: `radial-gradient(circle at 32% 30%, ${shared.dcolor[pj.domain_id] || 'var(--astral)'}, #0a0f22 130%)` }"></div>
        <div class="pj-title">
          <h3>{{ pj.name }} <span class="badge warn">待审核</span></h3>
          <div class="pj-tagline">{{ pj.tagline || '（未填标语）' }}</div>
          <div class="pj-meta">
            <span class="dot" :style="{ background: shared.dcolor[pj.domain_id] || 'var(--astral)' }"></span>{{ shared.dname[pj.domain_id] || '未分类' }}
            · 发起人 {{ pj.owner ? (pj.owner.display_name || pj.owner.username) : '—' }}
          </div>
        </div>
      </div>
      <p class="pj-desc">{{ pj.description }}</p>
      <div class="pj-row" v-if="pj.repo_url"><span class="lbl">仓库</span><a class="repo" :href="pj.repo_url.startsWith('http') ? pj.repo_url : 'https://' + pj.repo_url" target="_blank" rel="noopener"><Icon name="link" /> {{ pj.repo_url }}</a></div>
      <div class="pj-row" v-else><span class="lbl">仓库</span><span class="dim">未关联仓库 —— 建议要求补充</span></div>
      <div class="pj-acts">
        <button class="btn small ok" :disabled="busy === pj.id" @click="review(pj, 'approve')"><Icon name="check" /> 通过并上线</button>
        <button class="btn small ghost" :disabled="busy === pj.id" @click="review(pj, 'reject')"><Icon name="x" /> 驳回</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.empty { font-size: 14px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; padding: 30px 0; }
.pj { margin-bottom: 14px; border-top: 2px solid var(--pc); }
.pj-head { display: flex; gap: 16px; align-items: flex-start; }
.planet { width: 46px; height: 46px; border-radius: 50%; flex: none; box-shadow: 0 0 20px -4px var(--pc); }
.pj-title h3 { font-size: 17px; display: flex; align-items: center; gap: 10px; }
.pj-tagline { font-size: 13px; color: var(--ink-2); margin-top: 4px; }
.pj-meta { font-size: 12px; color: var(--ink-3); margin-top: 6px; display: inline-flex; align-items: center; gap: 6px; }
.pj-meta .dot { width: 8px; height: 8px; border-radius: 50%; }
.pj-desc { font-size: 13px; color: var(--ink-2); line-height: 1.65; margin: 14px 0; }
.pj-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12.5px; }
.pj-row .lbl { color: var(--ink-3); width: 48px; flex: none; }
.repo { color: var(--astral); display: inline-flex; align-items: center; gap: 5px; }
.dim { color: var(--ink-3); }
.pj-acts { display: flex; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
</style>
