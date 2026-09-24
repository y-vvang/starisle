<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { store, openProject, actPublishProject, refreshProjects } from '../store';
import { STATUS, toast } from '../../lib/api';
import { t } from '../../lib/i18n';
import Icon from '../../components/Icon.vue';
import PaginationBar from '../../components/PaginationBar.vue';

// 状态标签:恒为 0 的文档化空壳(公开列表全 approved、card 不带 gaps,
// 前三个值在库里不存在、recruit 比对恒空)—— 分页改造不动这个壳,
// 清壳是过渡期收尾的事,见 docs/MODULES.md。
const STATUS_TABS: [string, string][] = [
  ['', '全部'],
  ['thriving', '存活 90 天+'],
  ['active', '活跃'],
  ['incubating', '孵化中'],
  ['recruit', '招募中'],
];

// 领域筛选走服务端(?domain=):切换即重置回第 1 页。
const df = ref('');
const showPub = ref(false);
const busy = ref(false);

const list = computed(() => store.projectsState.list);
const pagination = computed(() => store.projectsState.pagination
  ?? { page: 1, per_page: 20, total: 0, total_pages: 1 });
// 领域 chip 的"有没有项目"凭证:GET /api/projects 随响应带 domain_counts
// (全库 approved 计数,不被当前筛选/页码影响)——chips 不再依赖整份列表。
const countDomain = (d: string) => store.projectsState.domainCounts[d] || 0;

onMounted(() => { refreshProjects({ reset: true }); });

function pickDomain(d: string) {
  df.value = d;
  refreshProjects({ reset: true, domain: d });
}
function pickPage(p: number) {
  refreshProjects({ page: p });
  window.scrollTo({ top: (document.getElementById('projects')?.offsetTop ?? 0) - 60 });
}

const pf = reactive({ name: '', domain: 'agent', tagline: '', desc: '', repo: '', stack: '', gap: '' });
async function publish() {
  if (!pf.name.trim() || pf.desc.trim().length < 20) { toast('请填项目名 + 至少 20 字简介'); return; }
  busy.value = true;
  const r = await actPublishProject({
    name: pf.name, domain: pf.domain, tagline: pf.tagline, desc: pf.desc, repo: pf.repo,
    // 发起人由服务端从登录会话推断,前端不传也不该传。
    // (原先这里有个 founderId: store.persona?.ref —— persona 是已删除的演示身份体系,
    //  恒为 undefined;注释里说的"服务端兜底成 db.members[0]"也是旧内存后端的行为。)
    stack: pf.stack.split(/[,，、\s]+/).filter(Boolean),
    gaps: pf.gap ? [{ skill: pf.gap, note: '' }] : [],
  });
  busy.value = false;
  if (r && !r.error) {
    toast('已提交 ✦ 运营审核通过后上线到项目中心');
    Object.assign(pf, { name: '', tagline: '', desc: '', repo: '', stack: '', gap: '' });
    showPub.value = false;
  } else toast(r?.error || '提交失败');
}
</script>

<template>
  <section class="section" id="projects">
    <span class="divider-star">✦</span>
    <div class="wrap">
      <div class="sec-head" v-reveal="0">
        <div class="sec-kicker">Projects</div>
        <h2 class="sec-title">项目<span class="en">PROJECTS</span></h2>
        <p class="sec-sub">{{ t('每个项目都有 Gitee 仓库、贡献者、多数有公开 Demo。浏览、加入,或发起你自己的 —— 发起后经运营审核上线。', 'Every project has a Gitee repo, contributors, and usually a live demo. Browse, join, or start your own — new projects go live after review.') }}</p>
      </div>

      <!-- 浏览 + 发布 同页:顶部一行操作 -->
      <div class="page-bar" v-reveal="1">
        <div class="tabs">
          <!-- 状态标签是文档化空壳(见 script 注释):recruit 等值恒 0,只有"全部"亮 -->
          <span class="chip" v-for="[k, l] in STATUS_TABS" :key="k" :class="{ active: !k }">
            {{ l }}<span class="c" v-if="k">0</span><span class="c" v-else>{{ pagination.total }}</span>
          </span>
        </div>
        <button class="btn small primary" @click="showPub = !showPub"><Icon name="flag" /> {{ showPub ? '收起' : '发起项目' }}</button>
      </div>

      <!-- 领域二级筛选:服务端 ?domain=,计数来自 domain_counts -->
      <div class="proj-filters sub" v-reveal="1">
        <span class="chip mini" :class="{ active: !df }" @click="pickDomain('')">全部领域</span>
        <template v-for="d in store.domains" :key="d.id">
          <span v-if="countDomain(d.id)" class="chip mini" :class="{ active: df === d.id }" @click="pickDomain(d.id)">
            <span class="dot" :style="{ background: d.color }"></span>{{ d.name }}
          </span>
        </template>
      </div>

      <!-- 同页发布表单 -->
      <div class="pub-form card" v-if="showPub" v-reveal="1">
        <div class="pf-grid">
          <div class="form-field"><label>项目名</label><input v-model="pf.name" maxlength="40" placeholder="例如:离线学伴 Lumen" /></div>
          <div class="form-field"><label>领域</label><select v-model="pf.domain"><option v-for="d in store.domains" :key="d.id" :value="d.id">{{ d.name }}</option></select></div>
          <div class="form-field"><label>一句话</label><input v-model="pf.tagline" maxlength="60" placeholder="给谁解决什么问题" /></div>
          <div class="form-field"><label>Gitee 仓库</label><input v-model="pf.repo" placeholder="gitee.com/你/仓库" /></div>
          <div class="form-field"><label>技术栈(逗号分隔)</label><input v-model="pf.stack" placeholder="Python, ONNX, Kotlin" /></div>
          <div class="form-field"><label>正在找(缺口技能)</label><input v-model="pf.gap" maxlength="20" placeholder="例如:视觉设计" /></div>
        </div>
        <div class="form-field"><label>简介(≥20 字)</label><textarea v-model="pf.desc" maxlength="400" placeholder="在做什么、进展到哪、Gitee 上有什么。"></textarea></div>
        <button class="btn primary" :disabled="busy" @click="publish"><Icon name="check" /> 提交(运营审核后上线)</button>
      </div>

      <div class="proj-count" v-reveal="1">共 {{ pagination.total }} 个项目</div>

      <div class="grid c3">
        <div class="card proj-card hoverable" v-for="(p, i) in list" :key="p.id"
          :style="{ '--pc': store.dcolor[p.domain] + '66' }" @click="openProject(p.id)"
          role="button" tabindex="0" :aria-label="'查看项目 ' + p.name" @keydown.enter="openProject(p.id)" @keydown.space.prevent="openProject(p.id)" v-reveal="i % 6">
          <div class="planet" :style="{ background: `radial-gradient(circle at 32% 30%, ${store.dcolor[p.domain]}, #0a0f22 130%)`, color: store.dcolor[p.domain] }"></div>
          <h4>{{ p.name }} <span class="badge" :class="(STATUS[p.status] || [])[1]">{{ (STATUS[p.status] || ['进行中'])[0] }}</span></h4>
          <div class="tagline">{{ p.tagline }}</div>
          <div class="meta">
            <span class="chip"><span class="dot" :style="{ background: store.dcolor[p.domain] }"></span>{{ store.dname[p.domain] }}</span>
            <span>{{ p.members.length }} 名成员</span><span>活跃度 {{ p.activity }}</span>
            <span v-if="p.demo" style="color:var(--ok);display:inline-flex;align-items:center;gap:4px"><Icon name="dot" style="width:.7em" /> Demo 在线</span>
          </div>
          <div class="gap-flag" v-if="p.gaps.length"><Icon name="flag" /> 缺 {{ p.gaps.map(g => g.skill).join('、') }} —— 等你补位</div>
        </div>
      </div>

      <PaginationBar :page="pagination.page" :per-page="pagination.per_page"
                     :total="pagination.total" @change="pickPage" />
    </div>
  </section>
</template>

<style scoped>
.page-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs .chip .c { margin-left: 6px; font-size: 11px; color: var(--ink-3); }
.tabs .chip.active .c { color: inherit; }
.tabs .chip { cursor: default; }   /* 恒 0 的空壳标签不可点 */
.proj-filters.sub { margin-bottom: 18px; opacity: .92; }
.proj-filters.sub .chip.mini { font-size: 12px; padding: 4px 10px; }
.pub-form { margin-bottom: 20px; padding: 20px 22px; }
.pf-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 18px; margin-bottom: 12px; }
.proj-count { font-size: 12.5px; color: var(--ink-3); margin-bottom: 16px; }
@media (max-width: 720px) { .pf-grid { grid-template-columns: 1fr; } }
</style>
