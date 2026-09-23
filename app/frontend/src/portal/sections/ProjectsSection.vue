<script setup>
import { computed, reactive, ref } from 'vue';
import { store, openProject, actPublishProject } from '../store';
import { STATUS, toast } from '../../lib/api';
import { t } from '../../lib/i18n';
import Icon from '../../components/Icon.vue';

const sf = ref('');       // 状态筛选
const df = ref('');       // 领域筛选
const showPub = ref(false);
const busy = ref(false);

// 状态标签(基于真实生命周期 + 招募中缺口)
const STATUS_TABS = [
  ['', '全部'],
  ['thriving', '存活 90 天+'],
  ['active', '活跃'],
  ['incubating', '孵化中'],
  ['recruit', '招募中'],
];
function matchStatus(p) {
  if (!sf.value) return true;
  if (sf.value === 'recruit') return p.gaps && p.gaps.length;
  return p.status === sf.value;
}
const list = computed(() => store.projects.filter(p => matchStatus(p) && (!df.value || p.domain === df.value)));
const countStatus = s => store.projects.filter(p => s === 'recruit' ? (p.gaps && p.gaps.length) : p.status === s).length;
const countDomain = d => store.projects.filter(p => p.domain === d).length;

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
          <span class="chip" v-for="[k, l] in STATUS_TABS" :key="k" :class="{ active: sf === k }" @click="sf = k">
            {{ l }}<span class="c" v-if="k">{{ countStatus(k) }}</span><span class="c" v-else>{{ store.projects.length }}</span>
          </span>
        </div>
        <button class="btn small primary" @click="showPub = !showPub"><Icon name="flag" /> {{ showPub ? '收起' : '发起项目' }}</button>
      </div>

      <!-- 领域二级筛选 -->
      <div class="proj-filters sub" v-reveal="1">
        <span class="chip mini" :class="{ active: !df }" @click="df = ''">全部领域</span>
        <template v-for="d in store.domains" :key="d.id">
          <span v-if="countDomain(d.id)" class="chip mini" :class="{ active: df === d.id }" @click="df = d.id">
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

      <div class="proj-count" v-reveal="1">{{ list.length }} 个项目</div>

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
    </div>
  </section>
</template>

<style scoped>
.page-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs .chip .c { margin-left: 6px; font-size: 11px; color: var(--ink-3); }
.tabs .chip.active .c { color: inherit; }
.proj-filters.sub { margin-bottom: 18px; opacity: .92; }
.proj-filters.sub .chip.mini { font-size: 12px; padding: 4px 10px; }
.pub-form { margin-bottom: 20px; padding: 20px 22px; }
.pf-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 18px; margin-bottom: 12px; }
.proj-count { font-size: 12.5px; color: var(--ink-3); margin-bottom: 16px; }
@media (max-width: 720px) { .pf-grid { grid-template-columns: 1fr; } }
</style>
