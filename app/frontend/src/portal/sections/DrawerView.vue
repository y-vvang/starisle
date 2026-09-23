<script setup>
import { computed, reactive, ref } from 'vue';
import { store, openMember, openProject, closeDrawer, actFollow } from '../store';
import { ago, tzLabel, STAGE, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

const d = computed(() => store.drawer);
// 关注(真实关系)
const followState = reactive({}); // id -> bool 覆盖(本会话)
const followBusy = ref(false);
function iFollow(data) {
  if (followState[data.id] !== undefined) return followState[data.id];
  return (data.followers || []).some(f => f.id === (store.persona && store.persona.ref));
}
function followerCount(data) {
  const base = data.followerCount || 0;
  const ov = followState[data.id];
  if (ov === undefined) return base;
  const was = (data.followers || []).some(f => f.id === (store.persona && store.persona.ref));
  return base + (ov ? 1 : 0) - (was ? 1 : 0);
}
async function toggleFollow(data) {
  followBusy.value = true;
  const r = await actFollow(data.id);
  followBusy.value = false;
  if (r && !r.error) { followState[data.id] = r.following; toast(r.following ? '已关注 ✦' : '已取消关注'); }
  else toast((r && r.error) || '操作失败');
}
const col = computed(() => {
  const x = d.value;
  if (!x.data) return '#7db4ff';
  return store.dcolor[x.data.interests[0]];
});

const STAGE_DEFS = [
  ['星尘 Stardust', '通过准入 + 完成档案'],
  ['星云 Nebula', '≥1 次有效贡献 · 加入 ≥1 个项目'],
  ['超新星 Supernova', '高权重贡献 + 核心维护存活 90 天+ 的项目'],
];
const stageIdx = computed(() => d.value.data?.stage === 'supernova' ? 2 : d.value.data?.stage === 'nebula' ? 1 : 0);
const sparkMax = computed(() => Math.max(...(d.value.data?.spark || [1]), 1));
</script>

<template>
  <div class="drawer-mask" :class="{ open: d.open }" @click="closeDrawer"></div>
  <aside class="drawer" :class="{ open: d.open }">
    <div class="drawer-inner" v-if="d.data" :key="d.kind + d.data.id">
      <button class="close-x" @click="closeDrawer" aria-label="关闭"><Icon name="x" /></button>

      <!-- ============ 成长档案 ============ -->
      <template v-if="d.kind === 'member'">
        <div class="profile-head" :style="{ '--dc': col + '26' }">
          <div class="star-glyph" :style="{ background: `radial-gradient(circle, ${col}44, transparent 70%)`, boxShadow: `0 0 30px ${col}55` }">
            <Icon name="star" class="lg" :style="{ color: col, filter: `drop-shadow(0 0 10px ${col})` }" />
          </div>
          <div style="flex:1">
            <h3>{{ d.data.star }} <span class="badge" :class="d.data.stage">{{ STAGE[d.data.stage] }}</span></h3>
            <div class="sub">{{ tzLabel(d.data.tz) }} · {{ d.data.langs.join(' / ') }} · 入驻 {{ d.data.joinedDaysAgo }} 天 · 星名系化名,数据最小化采集</div>
          </div>
          <button v-if="store.persona && store.persona.ref !== d.data.id" class="btn small follow-btn" :class="{ ok: iFollow(d.data) }" :disabled="followBusy" @click="toggleFollow(d.data)">
            <Icon :name="iFollow(d.data) ? 'check' : 'send'" /> {{ iFollow(d.data) ? '已关注' : '关注' }}
          </button>
        </div>
        <div class="profile-bio">"{{ d.data.bio }}"</div>

        <div class="dim-block rel-block" v-if="d.data.following">
          <div class="dim-title">关系 · 关注与合作(真实关系)</div>
          <div class="rel-stats">
            <span><b>{{ followerCount(d.data) }}</b> 关注者</span>
            <span><b>{{ (d.data.following || []).length }}</b> 关注中</span>
            <span><b>{{ (d.data.collaborators || []).length }}</b> 合作过</span>
          </div>
          <div class="rel-people" v-if="d.data.collaborators && d.data.collaborators.length">
            <span class="rel-lbl">合作过</span>
            <a class="rel-chip" v-for="c in d.data.collaborators.slice(0, 8)" :key="c.id" @click="openMember(c.id)"><Icon name="star" /> {{ c.star }}</a>
          </div>
          <div class="rel-people" v-if="d.data.following && d.data.following.length">
            <span class="rel-lbl">关注</span>
            <a class="rel-chip" v-for="c in d.data.following.slice(0, 8)" :key="c.id" @click="openMember(c.id)"><Icon name="star" /> {{ c.star }}</a>
          </div>
        </div>

        <div class="dim-block" v-if="d.data.growth"><div class="dim-title">成长 · 勋章与积分</div>
          <div class="gr-top">
            <span class="gr-title">{{ d.data.growth.title }}</span>
            <span class="gr-pts"><b>{{ d.data.growth.points }}</b> 积分 · Lv.{{ d.data.growth.level }}</span>
          </div>
          <div class="gr-bar" v-if="d.data.growth.nextAt">
            <span :style="{ width: Math.min(100, d.data.growth.points / d.data.growth.nextAt * 100) + '%' }"></span>
          </div>
          <div class="gr-next" v-if="d.data.growth.nextAt">距下一级还差 {{ Math.max(0, d.data.growth.nextAt - d.data.growth.points) }} 积分</div>
          <div class="gr-badges" v-if="d.data.growth.badges.length">
            <span class="gr-badge" v-for="b in d.data.growth.badges" :key="b.id" :title="b.desc"><Icon :name="b.icon" /> {{ b.name }}</span>
          </div>
        </div>

        <div class="dim-block"><div class="dim-title">Contribution · 贡献光度</div>
          <div class="lum-row">
            <div class="lum-tile vol"><div class="n">{{ d.data.volume }}</div><div class="l">体积 · 历史累计(不衰减,尊重资历)</div></div>
            <div class="lum-tile bri"><div class="n">{{ d.data.brightness }}</div><div class="l">亮度 · 近 90 天时间衰减加权</div></div>
          </div>
          <div class="spark-row">
            <span class="sp" v-for="(v, i) in d.data.spark" :key="i"
              :style="{ height: Math.max(6, v / sparkMax * 100) + '%', animationDelay: i * 40 + 'ms' }"
              :title="`${i === 12 ? '本' : '第 ' + (13 - i)} 周 · 贡献权重 ${v}`"></span>
          </div>
          <div class="spark-cap"><span>13 周前</span><span>近 90 天贡献节律</span><span>本周</span></div>
        </div>

        <div class="dim-block"><div class="dim-title">Journey · 成长星轨</div>
          <div class="stage-track">
            <template v-for="([lbl, crit], i) in STAGE_DEFS" :key="lbl">
              <span v-if="i" class="stage-link" :class="{ lit: i <= stageIdx }"></span>
              <span class="stage-node" :class="{ done: i < stageIdx, now: i === stageIdx }">
                <span class="sdot"></span><span class="slbl">{{ lbl }}</span><span class="scrit">{{ crit }}</span>
              </span>
            </template>
          </div>
        </div>

        <div class="dim-block"><div class="dim-title">Skills · 技能光谱(须有作品佐证)</div>
          <div class="chips-flow"><span class="chip" v-for="s in d.data.skills" :key="s">{{ s }}</span></div>
        </div>
        <div class="dim-block"><div class="dim-title">Interest · 兴趣射线</div>
          <div class="chips-flow"><span class="chip" v-for="i in d.data.interests" :key="i"><span class="dot" :style="{ background: store.dcolor[i] }"></span>{{ store.dname[i] }}</span></div>
        </div>
        <div class="dim-block"><div class="dim-title">Constellations · 所在星座</div>
          <div class="mini-proj" v-for="p in d.data.projects" :key="p.id" @click="openProject(p.id)">
            <span class="pdot" :style="{ background: store.dcolor[p.domain], boxShadow: '0 0 8px ' + store.dcolor[p.domain] }"></span>
            <b>{{ p.name }}</b><span class="role">{{ p.role }}</span>
          </div>
          <div class="empty-hint" v-if="!d.data.projects.length">尚未加入星座</div>
        </div>
        <div class="dim-block" v-if="d.data.portfolio"><div class="dim-title">Portfolio · 作品集(已交付的可验证成果)</div>
          <div class="pf-stats">
            <div class="pf-stat"><b>{{ d.data.portfolio.prCount }}</b><span>合并 PR</span></div>
            <div class="pf-stat"><b>{{ d.data.portfolio.demoCount }}</b><span>Demo 上线</span></div>
            <div class="pf-stat"><b>{{ d.data.portfolio.talkCount }}</b><span>讲座 / 分享</span></div>
          </div>
          <a v-if="d.data.portfolio.repo" class="btn small" :href="'https://gitee.com/' + d.data.portfolio.repo" target="_blank" rel="noopener" style="margin-bottom:10px"><Icon name="link" /> {{ d.data.portfolio.repo }}</a>
          <div class="pf-demo" v-for="pj in d.data.portfolio.demos" :key="pj.id" @click="openProject(pj.id)">
            <span class="pdot" :style="{ background: store.dcolor[pj.domain], boxShadow: '0 0 8px ' + store.dcolor[pj.domain] }"></span>
            <div class="pf-demo-txt"><b>{{ pj.name }}</b><span>{{ pj.tagline }}</span></div>
            <a class="pf-demo-live" :href="pj.demo" target="_blank" rel="noopener" @click.stop><Icon name="dot" style="width:.7em" /> Demo</a>
          </div>
          <div class="pf-ship" v-for="e in d.data.portfolio.shipped" :key="e.id">
            <span class="ic" :class="e.type"><Icon :name="e.type === 'demo_live' ? 'bolt' : 'check'" /></span>
            <span class="pf-ship-t">{{ e.detail }}<template v-if="e.projectName"> · {{ e.projectName }}</template></span>
            <span class="pf-ship-w">{{ ago(e.ts) }}</span>
          </div>
          <div class="empty-hint" v-if="!d.data.portfolio.shipped.length && !d.data.portfolio.demos.length">作品正在路上 ✦</div>
        </div>
        <div class="dim-block" v-if="d.data.timeline && d.data.timeline.length"><div class="dim-title">Journey · 成长时间线(项目 · 贡献 · 资源 · 专栏)</div>
          <div class="tl">
            <div class="tl-item" :class="tItem.kind" v-for="(tItem, i) in d.data.timeline" :key="i">
              <span class="tl-dot"></span>
              <div class="tl-body">
                <span class="tl-lbl">{{ tItem.label }}</span>
                <span class="tl-detail">{{ tItem.detail }}<template v-if="tItem.projectName"> · {{ tItem.projectName }}</template></span>
                <span class="tl-when">{{ ago(tItem.ts) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="dim-block"><div class="dim-title">Events · 贡献事件流(append-only · 唯一事实源)</div>
          <div class="ev-line" v-for="e in d.data.events.slice(0, 12)" :key="e.id">
            <span class="when">{{ ago(e.ts) }}</span><span class="tag">{{ e.typeLabel }}</span>
            <span class="what">{{ e.detail }}<template v-if="e.projectName"> · {{ e.projectName }}</template></span>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.follow-btn { flex: none; align-self: flex-start; }
.follow-btn.ok { background: rgba(110,231,160,.14); border-color: rgba(110,231,160,.5); color: var(--ok); }
.rel-stats { display: flex; gap: 18px; margin-bottom: 12px; }
.rel-stats span { font-size: 12.5px; color: var(--ink-3); }
.rel-stats b { color: var(--ink); font-size: 16px; font-weight: 700; margin-right: 3px; }
.rel-people { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.rel-lbl { font-size: 12px; color: var(--ink-3); margin-right: 2px; }
.rel-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-2); cursor: pointer; transition: border-color .15s, color .15s; }
.rel-chip:hover { border-color: var(--astral); color: var(--ink); }
.gr-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.gr-title { font-size: 14px; font-weight: 700; color: var(--polaris); }
.gr-pts { font-size: 12.5px; color: var(--ink-3); }
.gr-pts b { color: var(--ink); font-size: 16px; }
.gr-bar { height: 7px; border-radius: 999px; background: rgba(125,180,255,.14); overflow: hidden; }
.gr-bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--astral), var(--polaris)); }
.gr-next { font-size: 11.5px; color: var(--ink-3); margin-top: 6px; }
.gr-badges { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.gr-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 5px 11px; border-radius: 999px; color: var(--ink); background: rgba(255,210,125,.1); border: 1px solid rgba(255,210,125,.35); }
.pf-stats { display: flex; gap: 10px; margin-bottom: 14px; }
.pf-stat { flex: 1; text-align: center; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 12px 6px; }
.pf-stat b { display: block; font-size: 22px; color: var(--polaris); line-height: 1; }
.pf-stat span { font-size: 11px; color: var(--ink-3); }
.pf-demo { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; cursor: pointer; transition: border-color .2s; }
.pf-demo:hover { border-color: var(--line-strong); }
.pf-demo .pdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.pf-demo-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pf-demo-txt b { font-size: 13.5px; }
.pf-demo-txt span { font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-demo-live { flex: none; font-size: 11.5px; color: var(--ok); display: inline-flex; align-items: center; gap: 4px; border: 1px solid rgba(74, 222, 128, .3); border-radius: 999px; padding: 3px 10px; }
.pf-ship { display: flex; align-items: center; gap: 9px; padding: 7px 2px; font-size: 12.5px; }
.pf-ship .ic { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border-radius: 7px; }
.pf-ship .ic.merged_pr { color: var(--astral); background: rgba(125, 180, 255, .12); }
.pf-ship .ic.demo_live { color: var(--polaris); background: rgba(255, 210, 125, .12); }
.pf-ship-t { flex: 1; color: var(--ink-2); min-width: 0; }
.pf-ship-w { flex: none; color: var(--ink-3); font-size: 11px; font-family: var(--mono); }
/* 成长时间线 */
.tl { position: relative; padding-left: 4px; }
.tl-item { position: relative; display: flex; gap: 12px; padding: 0 0 14px 16px; border-left: 1.5px solid var(--line); }
.tl-item:last-child { border-left-color: transparent; padding-bottom: 2px; }
.tl-dot { position: absolute; left: -5px; top: 3px; width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); box-shadow: 0 0 0 3px var(--surface); }
.tl-item.contrib .tl-dot { background: var(--astral); }
.tl-item.resource .tl-dot { background: var(--glow-climate); }
.tl-item.column .tl-dot { background: var(--polaris); }
.tl-body { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; }
.tl-lbl { font-weight: 600; color: var(--ink); }
.tl-item.resource .tl-lbl { color: var(--glow-climate); }
.tl-item.column .tl-lbl { color: var(--polaris); }
.tl-detail { color: var(--ink-2); }
.tl-when { color: var(--ink-3); font-size: 11px; font-family: var(--mono); }
</style>
