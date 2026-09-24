<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  store, openMember, requireLogin,
  actProjectFollow, actProjectJoin, actProjectPoster, actProjectPosterRemove,
  fetchJoinRequests, actJoinRequestDecision,
} from '../store';
import { router, go } from '../../lib/router';
import { api, ago, STATUS, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

// 海报按字符数卡在服务端(app/routes/projects.ts 的 POSTER_MAX_CHARS),
// 700,000 字符的 data URI ≈ 512KB 解码后的原图。这里抄同一个数字,只是为了
// 能在真正发请求之前就把"太大"这件事说清楚,而不是让用户等一个 400 回来。
const POSTER_MAX_CHARS = 700_000;

// adapt() 的产物是"真实详情 + 旧壳占位字段"的混合形状,字段集开放
// (见下方 adapt 注释),刻意用 any 承载;p.error 分支也在这个 ref 里。
const p = ref<any>(null);
const loading = ref(true);
const followBusy = ref(false);
const joinBusy = ref(false);
const posterBusy = ref(false);
const joinRequests = ref<any[]>([]);
const decisionBusy = ref<string | number>('');
const col = () => (p.value ? store.dcolor[p.value.domain] : '#7db4ff');

// GET /projects/:slug 返回的 owner 字段只有 {username,display_name},没有 id,
// 所以"我是不是发起人"直接比 username(不可更改,比 id 更稳)。isOwnerOrAdmin
// 对应后端"owner 或站长"这条统一权限线(海报改写、申请队列都是这条线)。
const isOwner = computed(() => !!(store.user && p.value && p.value.owner && store.user.username === p.value.owner.username));
const isAdmin = computed(() => !!(store.user && store.user.role === 'admin'));
const isOwnerOrAdmin = computed(() => isOwner.value || isAdmin.value);

// 真实接口是 GET /api/projects/:slug → {project:{...}, members:[{username,display_name,role}]},
// 字段集比旧演示数据(核心问题/主要工作/阶段性成果/当前需求/贡献事件流…)
// 单薄得多。这里把真实响应适配成旧模板期望的 p 形状:能对应的字段(name/tagline/
// status/domain/poster/followers/following/pending_join_request/members…)接真实值,
// 没有对应后端字段的(platform/honors/activity/demo/work/stack/milestones/
// gapsDetail/giteeContent/events)一律给安全的空/占位默认值——模板里这些字段
// 大多已有 v-if 保护,会自动收起对应区块,不编造假数据。
function adapt(proj: any, members: any[]) {
  return {
    ...proj,
    domain: proj.domain_id,
    platform: 'Gitee',
    honors: [] as string[],
    activity: 0,
    demo: null,
    problem: proj.description || '',
    // 这四块来自 003 迁移新增的列。此前是写死的空值,于是 02/03/04 三张卡
    // 永远显示占位文案 —— 现在是项目发起人自己填的真内容。
    work: proj.work || '',
    stack: proj.stack || [],
    milestones: proj.milestones || [],
    // 模板里的 candidates 是旧人才匹配功能的残留(已删),给空数组让 v-if 收起来。
    gapsDetail: (proj.gaps || []).map((g: any) => ({ skill: g.skill, note: g.note, candidates: [] as unknown[] })),
    giteeContent: [] as unknown[],
    events: [] as unknown[],
    members: (members || []).map(m => ({ id: m.username, star: m.display_name || m.username, role: m.role })),
  };
}

async function load(id: string) {
  if (!id) return;
  loading.value = true;
  const r = await api('/projects/' + id);
  p.value = (!r || r.error || !r.project) ? { error: true } : adapt(r.project, r.members);
  loading.value = false;
  joinRequests.value = [];
  if (p.value && !p.value.error && isOwnerOrAdmin.value) {
    // GET /projects/:slug/join-requests 返回的是**全部**状态(pending/accepted/rejected),
    // 不是待办队列。此前直接整份渲染,于是已经处理过的申请刷新页面后会重新冒出来,
    // 还带着能点的通过/拒绝 —— 点下去只会拿到 409。这里只留待处理的。
    const all = await fetchJoinRequests(p.value.slug);
    joinRequests.value = (all || []).filter((x: any) => x.status === 'pending');
  }
}
watch(() => router.param, load, { immediate: true });

// 静默刷新(接受申请后用):不经过 loading 态,不闪屏,只是把成员表/申请队列
// 和视角状态(following/pending_join_request)拉到最新。
async function refreshProject() {
  if (!p.value || !p.value.slug) return;
  const r = await api('/projects/' + p.value.slug);
  if (r && r.project) p.value = adapt(r.project, r.members);
}

async function toggleFollow() {
  if (followBusy.value) return;
  followBusy.value = true;
  const want = !p.value.following;
  const r = await actProjectFollow(p.value.slug, want);
  followBusy.value = false;
  if (!r || r.error) { if (r && r.error !== '请先登录') toast(r.error || '操作失败'); return; }
  // 用响应里的权威状态覆盖本地状态,不是自己翻转一个布尔——两个标签页同时
  // 操作时,这里最终对齐的是数据库,不是"我以为我点了什么"。
  p.value.following = r.following;
  p.value.followers = r.followers;
  toast(r.following ? '已关注项目 ✦' : '已取消关注');
}

async function submitJoin() {
  if (!store.user) { requireLogin('申请加入'); return; }
  if (joinBusy.value || p.value.pending_join_request) return;
  const message = window.prompt('想对发起人说点什么?(选填,直接确定可留空)', '');
  if (message === null) return; // 用户点了取消
  joinBusy.value = true;
  const r = await actProjectJoin(p.value.slug, message.trim());
  joinBusy.value = false;
  if (!r || r.error) { if (r && r.error !== '请先登录') toast(r.error || '提交失败'); return; }
  p.value.pending_join_request = true;
  toast(r.note || '已提交加入申请 ✦');
}

function onPosterChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files && input.files[0];
  input.value = ''; // 允许下次重选同一个文件
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = String(reader.result || '');
    if (dataUrl.length > POSTER_MAX_CHARS) {
      toast(`海报太大,编码后需 ≤ ${POSTER_MAX_CHARS.toLocaleString('en-US')} 字符(约 512KB 原图),请压缩后再试`);
      return;
    }
    posterBusy.value = true;
    const r = await actProjectPoster(p.value.slug, dataUrl);
    posterBusy.value = false;
    if (!r || r.error) { toast((r && r.error) || '上传失败'); return; }
    p.value.poster = dataUrl;
    toast('路演海报已更新 ✦');
  };
  reader.onerror = () => toast('读取图片失败,请换一张再试');
  reader.readAsDataURL(f);
}

async function removePoster() {
  if (!p.value || !p.value.poster || posterBusy.value) return;
  posterBusy.value = true;
  const r = await actProjectPosterRemove(p.value.slug);
  posterBusy.value = false;
  if (!r || r.error) { toast((r && r.error) || '删除失败'); return; }
  p.value.poster = null;
  toast('已移除海报');
}

async function decide(item: any, decision: string) {
  if (decisionBusy.value) return;
  decisionBusy.value = item.id;
  const r = await actJoinRequestDecision(item.id, decision);
  decisionBusy.value = '';
  if (!r || r.error) { toast((r && r.error) || '操作失败'); return; }
  joinRequests.value = joinRequests.value.filter((x: any) => x.id !== item.id);
  toast(decision === 'accept' ? `已通过「${item.display_name || item.username}」的申请 ✦` : '已拒绝申请');
  if (decision === 'accept') await refreshProject();
}
</script>

<template>
  <div class="pd-wrap" v-if="!loading && p && !p.error">
    <div class="pd-inner" :style="{ '--pc': col() }">
      <a class="pd-back" @click="go('projects')"><Icon name="back" /> 返回项目</a>

      <!-- 头图 / 路演海报 -->
      <div class="pd-hero" :class="{ 'has-poster': p.poster }">
        <img v-if="p.poster" :src="p.poster" alt="路演海报" class="pd-poster" />
        <div v-else class="pd-hero-fallback" :style="{ background: `radial-gradient(120% 140% at 20% 10%, ${col()}33, transparent 70%)` }"></div>
        <div class="pd-hero-body">
          <div class="pd-tags">
            <span class="badge" :class="(STATUS[p.status] || [])[1]">{{ (STATUS[p.status] || ['进行中'])[0] }}</span>
            <span class="pd-plat" :class="p.platform === 'GitHub' ? 'gh' : 'gt'"><Icon name="link" /> {{ p.platform }}</span>
            <span class="pd-honor" v-for="h in p.honors" :key="h"><Icon name="star" /> {{ h }}</span>
          </div>
          <h1>{{ p.name }}</h1>
          <p class="pd-tag">{{ p.tagline }}</p>
          <div class="pd-domain"><span class="dot" :style="{ background: col() }"></span>{{ store.dname[p.domain] }} · {{ p.members.length }} 名成员 · 近90天活跃度 {{ p.activity }} · <Icon name="send" style="width:.8em" /> {{ p.followers || 0 }} 关注</div>
        </div>
      </div>

      <!-- 管理 / 交互操作 -->
      <div class="pd-actions">
        <button class="btn" :class="p.following ? 'ok' : 'primary'" :disabled="followBusy" @click="toggleFollow">
          <Icon :name="p.following ? 'check' : 'send'" /> {{ p.following ? '已关注' : '关注项目' }}
        </button>
        <button v-if="!isOwner" class="btn ghost" :disabled="joinBusy || p.pending_join_request" @click="submitJoin">
          <Icon :name="p.pending_join_request ? 'clock' : 'star'" /> {{ p.pending_join_request ? '申请审核中' : '申请加入' }}
        </button>
        <a v-if="p.demo" class="btn ghost" :href="p.demo" target="_blank" rel="noopener"><Icon name="play" /> 在线 Demo</a>
        <button v-if="isOwnerOrAdmin" class="btn ghost"
                @click="go('project/' + encodeURIComponent(p.slug) + '/edit')">
          <Icon name="scroll" /> 编辑项目
        </button>
        <label v-if="isOwnerOrAdmin" class="btn ghost pd-upload">
          <Icon name="grid" /> {{ p.poster ? '更换路演海报' : '上传路演海报' }}
          <input type="file" accept="image/*" hidden @change="onPosterChange" :disabled="posterBusy" />
        </label>
        <button v-if="isOwnerOrAdmin && p.poster" class="btn ghost danger" :disabled="posterBusy" @click="removePoster">
          <Icon name="x" /> 移除海报
        </button>
      </div>

      <!-- 信息结构:核心问题 / 主要工作 / 阶段性成果 / 当前需求 -->
      <div class="pd-grid">
        <section class="pd-card">
          <h3><span class="n">01</span> 核心问题</h3>
          <p>{{ p.problem }}</p>
        </section>
        <section class="pd-card">
          <h3><span class="n">02</span> 主要工作</h3>
          <p>{{ p.work }}</p>
          <div class="chips-flow"><span class="chip" v-for="s in p.stack" :key="s">{{ s }}</span></div>
        </section>
        <section class="pd-card">
          <h3><span class="n">03</span> 阶段性成果</h3>
          <ul class="pd-list" v-if="p.milestones && p.milestones.length"><li v-for="(m, i) in p.milestones" :key="i"><Icon name="check" /> {{ m }}</li></ul>
          <p v-else class="dim">成果正在路上 ✦</p>
        </section>
        <section class="pd-card need">
          <h3><span class="n">04</span> 当前需求</h3>
          <div v-if="p.gapsDetail && p.gapsDetail.length">
            <div class="need-item" v-for="g in p.gapsDetail" :key="g.skill">
              <div class="need-head"><Icon name="flag" /> 缺一名「{{ g.skill }}」<span class="dim" v-if="g.note"> · {{ g.note }}</span></div>
              <div class="need-cands" v-if="g.candidates && g.candidates.length">
                <a class="rel-chip" v-for="c in g.candidates.slice(0, 3)" :key="c.member.id" @click="openMember(c.member.id)"><Icon name="star" /> {{ c.member.star }}</a>
              </div>
            </div>
          </div>
          <p v-else class="dim">当前无公开缺口。</p>
        </section>
      </div>

      <!-- 加入申请队列:只有发起人/站长看得到 -->
      <section class="pd-block" v-if="isOwnerOrAdmin">
        <h3>加入申请 <span class="cnt" v-if="joinRequests.length">{{ joinRequests.length }}</span></h3>
        <p class="dim" v-if="!joinRequests.length">暂无待处理的加入申请。</p>
        <div class="pd-card jr-card" v-for="r in joinRequests" :key="r.id">
          <div class="jr-head">
            <div class="jr-who">
              <b>{{ r.display_name || r.username }}</b>
              <span class="dim" v-if="r.display_name && r.display_name !== r.username"> · @{{ r.username }}</span>
              <span class="dim"> · {{ ago(r.created_at) }}</span>
            </div>
            <div class="jr-acts">
              <button class="btn small ok" :disabled="decisionBusy === r.id" @click="decide(r, 'accept')"><Icon name="check" /> 通过</button>
              <button class="btn small danger" :disabled="decisionBusy === r.id" @click="decide(r, 'reject')"><Icon name="x" /> 拒绝</button>
            </div>
          </div>
          <p class="jr-msg" v-if="r.message">"{{ r.message }}"</p>
        </div>
      </section>

      <!-- 项目成员 -->
      <section class="pd-block">
        <h3>项目成员</h3>
        <div class="pd-crew">
          <a class="crew" v-for="m in p.members" :key="m.id" @click="openMember(m.id)">
            <span class="pdot" :style="{ background: col() }"></span>
            <b><Icon name="star" style="color:var(--polaris)" /> {{ m.star }}</b><span class="role">{{ m.role }}</span>
          </a>
        </div>
      </section>

      <!-- 代码平台内容(GitHub / Gitee) -->
      <section class="pd-block" v-if="p.giteeContent && p.giteeContent.length">
        <h3>{{ p.platform }} · 代码与技术内容 <span class="dim">(平台不托管代码,内容在 {{ p.platform }})</span></h3>
        <div class="pd-repo">
          <a class="repo-item" v-for="g in p.giteeContent" :key="g.type" :href="g.url" target="_blank" rel="noopener" :class="{ live: g.live }">
            <span class="ri-type">{{ g.type }}</span><span class="ri-title">{{ g.title }}</span>
            <Icon :name="g.live ? 'dot' : 'link'" />
          </a>
        </div>
      </section>

      <!-- 近期贡献 -->
      <section class="pd-block" v-if="p.events && p.events.length">
        <h3>近期贡献事件</h3>
        <div class="pd-ev" v-for="e in p.events.slice(0, 10)" :key="e.id">
          <span class="when">{{ ago(e.ts) }}</span><span class="tag">{{ e.typeLabel }}</span>
          <span class="what">{{ e.star }} · {{ e.detail }}</span>
        </div>
      </section>
    </div>
  </div>
  <div class="pd-wrap" v-else-if="!loading"><div class="pd-inner"><a class="pd-back" @click="go('projects')"><Icon name="back" /> 返回项目</a><p class="dim" style="padding:40px 0">项目不存在或未上线。</p></div></div>
</template>

<style scoped>
.pd-wrap { padding: 96px 24px 80px; }
.pd-inner { max-width: 1000px; margin: 0 auto; }
.pd-back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3); font-size: 13.5px; cursor: pointer; margin-bottom: 20px; }
.pd-back:hover { color: var(--astral); }
.pd-hero { position: relative; border-radius: 20px; overflow: hidden; border: 1px solid var(--line); margin-bottom: 18px; background: var(--surface); }
.pd-poster { width: 100%; max-height: 340px; object-fit: cover; display: block; }
.pd-hero-fallback { height: 150px; }
.pd-hero-body { padding: 22px 26px 26px; }
.pd-hero.has-poster .pd-hero-body { background: linear-gradient(to top, var(--surface) 60%, transparent); margin-top: -60px; position: relative; }
.pd-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.pd-plat { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; display: inline-flex; align-items: center; gap: 4px; }
.pd-plat.gh { color: var(--ink); border: 1px solid var(--line-strong); background: rgba(125,180,255,.08); }
.pd-plat.gt { color: var(--astral); border: 1px solid rgba(125,180,255,.4); }
.pd-honor { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; color: var(--polaris); background: rgba(255,210,125,.12); border: 1px solid rgba(255,210,125,.4); display: inline-flex; align-items: center; gap: 4px; }
.pd-hero-body h1 { font-size: clamp(26px, 4vw, 38px); font-weight: 800; letter-spacing: -.01em; }
.pd-tag { color: var(--ink-2); font-size: 16px; margin: 8px 0 12px; }
.pd-domain { font-size: 12.5px; color: var(--ink-3); display: inline-flex; align-items: center; gap: 6px; }
.pd-domain .dot { width: 8px; height: 8px; border-radius: 50%; }
.pd-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 26px; }
.pd-actions .btn.ok { background: rgba(110,231,160,.14); border-color: rgba(110,231,160,.5); color: var(--ok); }
.pd-upload { cursor: pointer; }
.cnt { font-size: 12px; font-weight: 700; color: var(--polaris); background: rgba(255,210,125,.14); padding: 1px 9px; border-radius: 999px; margin-left: 4px; }
.jr-card { margin-bottom: 12px; padding: 16px 20px; }
.jr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.jr-who { font-size: 14px; }
.jr-who b { font-weight: 700; }
.jr-acts { display: flex; gap: 8px; flex: none; }
.jr-msg { font-size: 13px; color: var(--ink-2); font-style: italic; padding-top: 10px; margin-top: 10px; border-top: 1px solid var(--line); }
.pd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 26px; }
.pd-card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px 22px; }
.pd-card h3 { font-size: 15px; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
.pd-card h3 .n { font-size: 12px; font-weight: 800; color: var(--pc); background: color-mix(in srgb, var(--pc) 14%, transparent); border-radius: 8px; padding: 3px 8px; }
.pd-card p { color: var(--ink-2); font-size: 14px; line-height: 1.7; }
.chips-flow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.pd-list { list-style: none; margin: 0; padding: 0; }
.pd-list li { display: flex; align-items: flex-start; gap: 8px; color: var(--ink-2); font-size: 13.5px; line-height: 1.7; margin-bottom: 4px; }
.pd-list li :deep(svg) { color: var(--ok); flex: none; margin-top: 4px; }
.need-item { margin-bottom: 12px; }
.need-head { font-size: 13.5px; color: var(--ink); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.need-cands { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.rel-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-2); cursor: pointer; }
.rel-chip:hover { border-color: var(--astral); color: var(--ink); }
.pd-block { margin-bottom: 26px; }
.pd-block > h3 { font-size: 16px; margin-bottom: 14px; }
.pd-block h3 .dim { font-size: 12px; font-weight: 400; }
.pd-crew { display: flex; flex-wrap: wrap; gap: 10px; }
.crew { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; }
.crew:hover { border-color: var(--pc); }
.crew .pdot { width: 8px; height: 8px; border-radius: 50%; }
.crew .role { color: var(--ink-3); font-size: 12px; }
.pd-repo { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.repo-item { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink-2); font-size: 13px; }
.repo-item:hover { border-color: var(--astral); color: var(--ink); }
.repo-item.live { border-color: rgba(110,231,160,.4); }
.ri-type { font-size: 11px; color: var(--ink-3); flex: none; }
.ri-title { flex: 1; }
.pd-ev { display: flex; align-items: baseline; gap: 10px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.pd-ev .when { color: var(--ink-3); font-size: 12px; white-space: nowrap; }
.pd-ev .tag { font-size: 11px; color: var(--astral); border: 1px solid var(--line-strong); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.pd-ev .what { color: var(--ink-2); }
.dim { color: var(--ink-3); }
@media (max-width: 760px) { .pd-grid { grid-template-columns: 1fr; } .pd-wrap { padding-top: 80px; } }
</style>
