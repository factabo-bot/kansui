'use strict';
// ベランダ潅水アプリ
// データ：GitHubの非公開リポジトリ（data/q15/*.jsonl, data/shots/*.jsonl, data/status.json, config/programs.json）
//        ＋ ntfyのデータ用トピックの最新1通（最大15分遅れの値）
// 設計：vault 30_Blueberry/ベランダ_日射比例潅水_データ記録と遠隔設定_設計.md

const APP_VER = '1.4.0';
const LS_KEY = 'kansui-app';
const DEFAULT_REPO = 'factabo-bot/veranda-kansui';
const JST = 9 * 3600;
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const KIND_JA = { manual: '手動', fixed: '固定時刻', solar: '日射比例' };
const LIMITS = { sec: [1, 120], interval: [10, 1440], maxDay: [1, 40], fixed: 4, programsUsed: 8, overrides: 4 };

const S = {
  settings: loadSettings(),
  topics: null, status: null,
  programs: null, programsSha: null, draft: null,
  files: {},          // path -> 配列（jsonl）/ null（ない）
  latest: null,       // ntfyの最新1通（変換済み）
  loading: false, error: null,
  view: { range: 14, metric: 'peak', dayFull: false },
};

// ---- 小さな道具 -------------------------------------------------------------
function loadSettings() {
  try { return Object.assign({ token: '', repo: DEFAULT_REPO }, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch (e) { return { token: '', repo: DEFAULT_REPO }; }
}
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(S.settings)); } catch (e) { /* 保存できなくても動く */ } }
const $ = (sel, el = document) => el.querySelector(sel);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function pad(n) { return String(n).padStart(2, '0'); }
// JST（UTC+9固定）の年月日・時刻
function jst(ts) {
  const d = new Date((ts + JST) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), wd: d.getUTCDay() };
}
function dayKeyOf(ts) { const t = jst(ts); return `${t.y}-${pad(t.m)}-${pad(t.d)}`; }
function monthOf(ts) { const t = jst(ts); return `${t.y}-${pad(t.m)}`; }
function hmOf(ts) { const t = jst(ts); return `${pad(t.hh)}:${pad(t.mm)}`; }
function nowTs() { return Math.floor(Date.now() / 1000); }
function todayKey() { return dayKeyOf(nowTs()); }
function dayStart(key) { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 1000 - JST; }
function addDays(key, n) { return dayKeyOf(dayStart(key) + n * 86400 + 3600); }
function dayLabel(key) {
  const t = jst(dayStart(key) + 3600);
  return `${t.m}月${t.d}日（${'日月火水木金土'[t.wd]}）`;
}
function fmtN(v, digits = 0) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function ago(ts) {
  const s = nowTs() - ts;
  if (s < 90) return 'たった今';
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${Math.round(s / 3600)}時間前`;
  return `${Math.round(s / 86400)}日前`;
}
function parseIsoTs(s) { const t = Date.parse(s); return isFinite(t) ? Math.floor(t / 1000) : null; }
function toMin(hm) { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- GitHub ----------------------------------------------------------------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function gh(path, { raw = false, method = 'GET', body = null } = {}) {
  const { token, repo } = S.settings;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method, cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new ApiError(res.status, `GitHub ${res.status}`);
  return raw ? res.text() : res.json();
}
function b64encodeUtf8(s) {
  const bytes = new TextEncoder().encode(s); let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, '')); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function parseJsonl(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) { const l = line.trim(); if (l) { try { out.push(JSON.parse(l)); } catch (e) { /* 壊れた行は飛ばす */ } } }
  return out;
}
function errText(e) {
  if (e instanceof ApiError) {
    if (e.status === 401) return '鍵が違うか、期限が切れています。設定で鍵を入れ直してください。';
    if (e.status === 403) return '鍵に権限が足りません（Contents の読み書き）。';
    if (e.status === 409 || e.status === 422) return 'ほかで更新されていました。読み直してから、もう一度保存してください。';
    return `GitHubとの通信に失敗しました（${e.status}）。`;
  }
  return '通信に失敗しました。電波の良い所でもう一度試してください。';
}

// ---- 読み込み ----------------------------------------------------------------
async function loadCore() {
  if (!S.settings.token) { S.error = 'no-token'; return; }
  S.loading = true; S.error = null; render();
  try {
    const [topics, status, prog] = await Promise.all([
      gh('config/topics.json', { raw: true }),
      gh('data/status.json', { raw: true }),
      gh('config/programs.json'),
    ]);
    if (topics === null && prog === null) { S.error = 'no-repo'; return; }
    S.topics = topics ? JSON.parse(topics) : null;
    S.status = status ? JSON.parse(status) : null;
    if (prog) {
      S.programs = JSON.parse(b64decodeUtf8(prog.content));
      S.programsSha = prog.sha;
      if (!S.draft || !isDirty()) S.draft = clone(S.programs);
    }
    S.files = {};
    await loadLatest();
  } catch (e) {
    S.error = errText(e);
  } finally {
    S.loading = false;
  }
}

async function loadLatest() {
  S.latest = null;
  S.liveNotices = [];
  if (S.topics?.notify) {
    try {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(S.topics.notify)}/json?poll=1&since=12h`, { cache: 'no-store' });
      if (res.ok) {
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.event === 'message') S.liveNotices.push({ ts: ev.time, id: ev.id, message: ev.message || '', priority: ev.priority || 3 });
        }
      }
    } catch (e) { /* 通知の履歴が取れなくても表示は続ける */ }
  }
  if (!S.topics?.data) return;
  try {
    // 最新1通だけだと、装置が再起動した直後は中身が空になる。リポジトリに取り込まれる前の分も拾うため、直近6時間分をまとめて読む
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(S.topics.data)}/json?poll=1&since=6h`, { cache: 'no-store' });
    if (!res.ok) return;
    const q = new Map(), sh = new Map();
    let last = null, lastNow = null;
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue;
      let ev, m;
      try { ev = JSON.parse(line); m = JSON.parse(ev.message || '{}'); } catch (e) { continue; }
      if (m.v !== 1) continue;
      for (const a of m.q || []) q.set(a[0], { ts: a[0], solar_vs: a[1], solar_max_v: a[2] / 100, bat_v: a[3] ? a[3] / 100 : null, refill_low: !!a[4], shots: a[5], pump_s: a[6] });
      for (const a of m.s || []) sh.set(`${a[0]}-${a[1]}`, { ts: a[0], kind: { m: 'manual', f: 'fixed', a: 'solar' }[a[1]] || a[1], sec: a[2] });
      if (!last || ev.time >= last.ev.time) last = { ev, m };
      // 再起動の直後は測る前の0が入っているので、電池が0の「いま」は使わない
      if (m.now && m.now[2] > 0 && (!lastNow || m.now[0] >= lastNow[0])) lastNow = m.now;
    }
    if (!last) return;
    S.latest = {
      received: last.ev.time, fw: last.m.fw, cfg: last.m.cfg, p: last.m.p,
      now: lastNow ? { ts: lastNow[0], solar_v: lastNow[1] / 100, bat_v: lastNow[2] / 100, refill_low: !!lastNow[3] } : null,
      q: [...q.values()],
      s: [...sh.values()],
    };
  } catch (e) { /* 最新が取れなくてもリポジトリの記録で表示する */ }
}

async function ensureMonths(months) {
  const need = [];
  for (const mo of months) for (const kind of ['q15', 'shots', 'events']) {
    const p = `data/${kind}/${mo}.jsonl`;
    if (!(p in S.files)) need.push(p);
  }
  if (!need.length) return;
  const res = await Promise.all(need.map(p => gh(p, { raw: true }).catch(() => null)));
  need.forEach((p, i) => { S.files[p] = parseJsonl(res[i]); });
}
function monthsBetween(fromKey, toKey) {
  const out = []; let [y, m] = fromKey.split('-').map(Number); const [ty, tm] = toKey.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

// 15分ごとの記録（リポジトリ＋最新1通）を、時刻→記録の表にする
function binsBetween(fromTs, toTs) {
  const map = new Map();
  for (const mo of monthsBetween(dayKeyOf(fromTs), dayKeyOf(toTs - 1))) {
    for (const r of S.files[`data/q15/${mo}.jsonl`] || []) map.set(r.ts, r);
  }
  for (const r of S.latest?.q || []) map.set(r.ts, r);
  return [...map.values()].filter(r => r.ts >= fromTs && r.ts < toTs).sort((a, b) => a.ts - b.ts);
}
function noticesBetween(fromTs, toTs) {
  const map = new Map();
  for (const mo of monthsBetween(dayKeyOf(fromTs), dayKeyOf(toTs - 1))) {
    for (const r of S.files[`data/events/${mo}.jsonl`] || []) map.set(r.id, r);
  }
  for (const r of S.liveNotices || []) map.set(r.id, r);
  return [...map.values()].filter(r => r.ts >= fromTs && r.ts < toTs).sort((a, b) => a.ts - b.ts);
}
function shotsBetween(fromTs, toTs) {
  const map = new Map();
  for (const mo of monthsBetween(dayKeyOf(fromTs), dayKeyOf(toTs - 1))) {
    for (const r of S.files[`data/shots/${mo}.jsonl`] || []) map.set(`${r.ts}-${r.kind}`, r);
  }
  for (const r of S.latest?.s || []) map.set(`${r.ts}-${r.kind}`, r);
  return [...map.values()].filter(r => r.ts >= fromTs && r.ts < toTs).sort((a, b) => a.ts - b.ts);
}
// 連続する1時間（15分×4）の日射の最大
function peakHour(bins) {
  let best = 0;
  for (let i = 0; i < bins.length; i++) {
    let sum = 0;
    for (let j = i; j < bins.length && bins[j].ts < bins[i].ts + 3600; j++) sum += bins[j].solar_vs;
    if (sum > best) best = sum;
  }
  return best;
}
function daySummary(key) {
  const a = dayStart(key), b = a + 86400;
  const bins = binsBetween(a, b), shots = shotsBetween(a, b);
  const bats = bins.map(r => r.bat_v).filter(v => v);
  return {
    key, bins, shots,
    sol: bins.reduce((s, r) => s + r.solar_vs, 0),
    peak: peakHour(bins),
    nShots: shots.length,
    pumpS: shots.reduce((s, r) => s + r.sec, 0),
    batMin: bats.length ? Math.min(...bats) : null,
    refillLow: bins.some(r => r.refill_low),
  };
}
function mlOf(sec) { const f = S.draft?.common?.flow_ml_s || S.programs?.common?.flow_ml_s || 0; return f > 0 ? sec * f : null; }

// ---- 潅水プログラム ----------------------------------------------------------
function isDirty() { return S.programs && S.draft && JSON.stringify(S.programs) !== JSON.stringify(S.draft); }
function progById(id) { return (S.draft?.programs || []).find(p => p.id === id); }
function progName(id) { if (!id || id === 'stop') return '停止'; return progById(id)?.name || '（削除されたプログラム）'; }
function programForDay(key) {
  const d = S.draft; if (!d) return null;
  for (const o of d.overrides || []) if (key >= o.start && key <= o.end) return { id: o.program, by: 'override', o };
  const m = Number(key.slice(5, 7));
  return { id: (d.months || [])[m - 1] || 'stop', by: 'month' };
}
function describeProgram(p) {
  const parts = [];
  if (p.fixed?.length) parts.push(p.fixed.map(f => `${f.time} ${f.sec}秒`).join('、'));
  if (p.prop?.on) parts.push(`日射比例 ${fmtN(p.prop.thresh_vs)}V・秒ごとに${p.prop.sec}秒（${p.prop.start}〜${p.prop.end}）`);
  if (!parts.length) return '給水しない（記録だけ）';
  parts.push(`${p.cutoff}以降はしない`);
  return parts.join(' ／ ');
}
function newProgram() {
  return {
    id: 'p' + Date.now().toString(36), name: '新しいプログラム', memo: '',
    fixed: [], prop: { on: false, thresh_vs: 0, sec: 10, interval_min: 20, start: '08:00', end: '16:00' },
    cutoff: '17:00', max_day: 16, max_action: 'notify',
  };
}
function validateDraft(d) {
  const errs = [];
  const used = new Set();
  (d.months || []).forEach(id => { if (id && id !== 'stop') used.add(id); });
  const today = todayKey();
  for (const o of d.overrides || []) {
    if (!o.start || !o.end || o.start > o.end) errs.push('期間の上書き：開始日と終了日を確かめてください');
    if (o.end >= today && o.program !== 'stop') used.add(o.program);
  }
  if (used.size > LIMITS.programsUsed) errs.push(`同時に使えるプログラムは${LIMITS.programsUsed}つまでです`);
  if ((d.overrides || []).filter(o => o.end >= todayKey()).length > LIMITS.overrides) errs.push(`期間の上書きは${LIMITS.overrides}件までです`);
  for (const p of d.programs || []) {
    const n = p.name || '名前なし';
    if (!p.name?.trim()) errs.push('名前のないプログラムがあります');
    for (const f of p.fixed || []) if (!/^\d\d:\d\d$/.test(f.time) || !(f.sec >= 1 && f.sec <= 120)) errs.push(`${n}：固定時刻の時刻か秒数（1〜120秒）を確かめてください`);
    if (p.prop?.on) {
      if (!(p.prop.thresh_vs > 0)) errs.push(`${n}：日射比例のしきい値を入れてください`);
      if (!(p.prop.sec >= 1 && p.prop.sec <= 120)) errs.push(`${n}：日射比例の秒数は1〜120秒です`);
      if (!(p.prop.interval_min >= 10)) errs.push(`${n}：最短の間隔は10分以上です`);
      if (toMin(p.prop.start) >= toMin(p.prop.end)) errs.push(`${n}：日射比例の時間帯の始まりと終わりを確かめてください`);
    }
    if (!(p.max_day >= 1 && p.max_day <= 40)) errs.push(`${n}：1日の上限は1〜40回です`);
  }
  const c = d.common || {};
  if (!(c.manual_sec >= 1 && c.manual_sec <= 120)) errs.push('手動ボタンの秒数は1〜120秒です');
  if (!(c.bat_stop_v <= c.bat_warn_v)) errs.push('電池の停止電圧は警告電圧以下にしてください');
  return [...new Set(errs)];
}
async function saveDraft() {
  const errs = validateDraft(S.draft);
  if (errs.length) { toast(errs[0], 4000); return; }
  const btn = $('#btn-save'); btn.disabled = true;
  try {
    const d = clone(S.draft);
    d.version = Math.max((S.programs.version || 0) + 1, nowTs());
    const text = JSON.stringify(d, null, 1) + '\n';
    const res = await gh('config/programs.json', {
      method: 'PUT',
      body: { message: `潅水プログラムを更新（アプリ、版${d.version}）`, content: b64encodeUtf8(text), sha: S.programsSha, branch: 'main' },
    });
    S.programs = d; S.draft = clone(d); S.programsSha = res.content.sha;
    if (S.status) S.status.cfg_latest = d.version;
    toast('保存しました。15分ほどで装置に届きます', 3500);
  } catch (e) {
    toast(errText(e), 5000);
  } finally {
    btn.disabled = false; updateSavebar();
  }
}
function updateSavebar() {
  const bar = $('#savebar');
  const show = !!isDirty() && ['programs', 'program', 'settings'].includes(route().name);
  bar.hidden = !show;
}

// ---- 画面の切り替え --------------------------------------------------------
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || 'today';
  const [name, arg] = h.split('/');
  return { name, arg };
}
async function render() {
  const r = route();
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (r.name === 'program' ? 'programs' : r.name)));
  const page = $('#page');
  updateSavebar();
  if (S.error === 'no-token' || r.name === 'settings') { page.innerHTML = viewSettings(); bindSettings(); return; }
  if (S.loading && !S.programs) { page.innerHTML = '<p class="skeleton">読み込んでいます…</p>'; return; }
  if (S.error === 'no-repo') { page.innerHTML = `<h1 class="title">保存先が見つかりません</h1>${callout('err', '鍵の対象に <b>veranda-kansui</b> が入っているか、設定の「保存先」が正しいか確かめてください。')}<div class="btns"><a class="btn" href="#settings">設定を開く</a></div>`; return; }
  if (S.error) { page.innerHTML = `<h1 class="title">読み込めませんでした</h1>${callout('err', esc(S.error))}<div class="btns"><button class="btn" id="btn-retry">もう一度</button><a class="btn" href="#settings">設定</a></div>`; $('#btn-retry').onclick = () => loadCore().then(render); return; }
  try {
    if (r.name === 'history') { page.innerHTML = '<p class="skeleton">読み込んでいます…</p>'; await renderHistory(page); }
    else if (r.name === 'programs') { page.innerHTML = viewPrograms(); bindPrograms(); }
    else if (r.name === 'program') { page.innerHTML = viewProgram(r.arg); bindProgram(r.arg); }
    else { page.innerHTML = '<p class="skeleton">読み込んでいます…</p>'; await renderToday(page, r.arg || todayKey()); }
  } catch (e) {
    page.innerHTML = `<h1 class="title">表示できませんでした</h1>${callout('err', esc(errText(e)))}`;
  }
  updateSavebar();
}
function callout(kind, html) { return `<div class="callout ${kind}"><span class="mark"></span><div>${html}</div></div>`; }

// ---- 今日 --------------------------------------------------------------------
async function renderToday(page, key) {
  const isToday = key === todayKey();
  await ensureMonths([key.slice(0, 7)]);
  const sum = daySummary(key);
  const st = S.status || {};
  const last = S.latest || null;
  const lastTs = last?.received || parseIsoTs(st.received);
  const cfgApplied = last?.cfg ?? st.cfg_applied;
  const cfgLatest = S.programs?.version ?? st.cfg_latest;
  const now = last?.now || (st.now ? { ts: parseIsoTs(st.now.t), solar_v: st.now.solar_v, bat_v: st.now.bat_v, refill_low: st.now.refill_low } : null);
  const pf = programForDay(key);

  let html = `<div class="datenav">
      <button class="icon-btn" id="d-prev" aria-label="前の日">‹</button>
      <input type="date" id="d-pick" value="${key}" max="${todayKey()}" aria-label="日付">
      <button class="icon-btn" id="d-next" aria-label="次の日" ${isToday ? 'disabled' : ''}>›</button>
      ${isToday ? '' : '<button class="btn ghost small" id="d-today">今日へ</button>'}
    </div>
    <h1 class="title">${isToday ? '今日' : esc(dayLabel(key))}</h1>
    <p class="subtitle">${isToday ? esc(dayLabel(key)) : ''}</p>`;

  if (isToday) {
    if (!lastTs) html += callout('warn', 'まだ装置から記録が届いていません。');
    else if (nowTs() - lastTs > 40 * 60) html += callout('warn', `最後に記録が届いたのは${esc(ago(lastTs))}（${esc(hmOf(lastTs))}）です。Wi-Fiか電池を確かめてください。`);
    html += '<div class="props">';
    html += prop('プログラム', `${esc(progName(pf?.id))}${pf?.by === 'override' ? ' <span class="tag yellow">期間の上書き</span>' : ''}`);
    if (cfgApplied != null && cfgLatest != null) {
      html += prop('設定の反映', cfgApplied >= cfgLatest ? '<span class="tag green">反映済み</span>' : '<span class="tag yellow">反映待ち</span> <span class="muted small">15分ほどで届きます</span>');
    }
    if (now) {
      html += prop('電池', now.bat_v ? `<span class="num">${fmtN(now.bat_v, 2)} V</span>` : '—');
      html += prop('タンク', now.refill_low ? '<span class="tag red">水が少ない</span>' : '<span class="tag green">水あり</span>');
      html += prop('いまの日射', `<span class="num">${fmtN(now.solar_v, 2)} V</span>`);
    }
    if (lastTs) html += prop('最終受信', `${esc(hmOf(lastTs))} <span class="muted small">${esc(ago(lastTs))}</span>`);
    html += '</div>';
  } else {
    html += `<div class="props">${prop('プログラム', esc(progName(pf?.id)) + ' <span class="muted small">今の割り当てから表示</span>')}</div>`;
  }

  const ml = mlOf(sum.pumpS);
  html += `<div class="stats">
    ${stat('日射の合計', fmtN(sum.sol), 'V・秒')}
    ${stat('最大1時間', fmtN(sum.peak), 'V・秒')}
    ${stat('給水', sum.nShots, '回')}
    ${stat('給水量', ml != null ? fmtN(ml) : fmtN(sum.pumpS), ml != null ? 'mL' : '秒')}
  </div>`;

  html += `<h2>日射（15分ごと）</h2><p class="hint">棒をタップするか、指でなぞると、その15分の数字が下に出ます。</p>${dayChart(key, sum, isToday)}
    <div class="legend"><span><i style="background:var(--bar)"></i>日射の積算</span><span><i style="background:var(--green)"></i>給水</span>${isToday ? '<span><i style="background:var(--red)"></i>いま</span>' : ''}</div>
    <div id="bin-info" class="bin-info"></div>`;

  html += '<h2>給水</h2>';
  if (!sum.shots.length) html += '<p class="muted">この日の給水はありません。</p>';
  else {
    html += `<div class="table-wrap"><table class="db"><thead><tr><th>時刻</th><th>種類</th><th class="r">秒数</th><th class="r">量</th></tr></thead><tbody>`;
    for (const s of sum.shots) {
      const m = mlOf(s.sec);
      html += `<tr><td class="num">${hmOf(s.ts)}</td><td>${esc(KIND_JA[s.kind] || s.kind)}</td><td class="r">${s.sec}</td><td class="r">${m != null ? fmtN(m) + ' mL' : '—'}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  const tank = tankEvents(sum.bins);
  html += '<h2>タンクの水</h2>';
  if (!tank.length) html += `<p class="muted">${sum.bins.length ? (sum.bins[sum.bins.length - 1].refill_low ? 'この日はずっと水が少ない状態でした。' : '変化はありません。') : '記録がありません。'}</p>`;
  else html += `<div class="list">${tank.map(t => `<div class="row" style="cursor:default"><div class="main"><div class="name">${esc(t.text)}</div><div class="desc num">${hmOf(t.ts)}ごろ</div></div></div>`).join('')}</div>`;

  const notices = noticesBetween(dayStart(key), dayStart(key) + 86400);
  html += '<h2>通知</h2>';
  if (!notices.length) html += '<p class="muted">この日の通知はありません。</p>';
  else html += `<div class="list">${notices.map(n => `<div class="row" style="cursor:default"><div class="main"><div class="name">${esc(n.message)}${(n.priority || 3) >= 4 ? ' <span class="tag red">重要</span>' : ''}</div><div class="desc num">${hmOf(n.ts)}</div></div></div>`).join('')}</div>`;

  page.innerHTML = html;
  bindDayChart(key, sum);
  page.querySelectorAll('#seg-day button').forEach(b => b.onclick = () => { S.view.dayFull = b.dataset.v === '1'; rerenderSoft(); });
  const go = k => { location.hash = k === todayKey() ? '#today' : `#today/${k}`; };
  $('#d-prev').onclick = () => go(addDays(key, -1));
  $('#d-next').onclick = () => { if (!isToday) go(addDays(key, 1)); };
  $('#d-pick').onchange = e => { if (e.target.value) go(e.target.value); };
  const tb = $('#d-today'); if (tb) tb.onclick = () => go(todayKey());
}
function prop(k, vHtml) { return `<div class="prop"><div class="k">${esc(k)}</div><div class="v">${vHtml}</div></div>`; }
function stat(k, v, unit) { return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}<small>${esc(unit)}</small></div></div>`; }
function tankEvents(bins) {
  const out = [];
  for (let i = 1; i < bins.length; i++) {
    if (!bins[i - 1].refill_low && bins[i].refill_low) out.push({ ts: bins[i].ts, text: '水が少なくなった（補充の目安）' });
    if (bins[i - 1].refill_low && !bins[i].refill_low) out.push({ ts: bins[i].ts, text: '水が補充された' });
  }
  return out;
}
const DAY_CHART = { W: 400, H: 230, L: 30, R: 6, T: 14, B: 22 };
// 表示する時間の範囲。ふだんは日中（5〜19時。暗くない記録があればその分広げる）、切り替えで24時間
function dayRange(key, sum) {
  const a = dayStart(key);
  if (S.view.dayFull) return [a, a + 86400];
  let s = 5, e = 19;
  for (const r of sum.bins) {
    if (r.solar_max_v < 0.02) continue;
    const h = (r.ts - a) / 3600;
    s = Math.min(s, Math.floor(h)); e = Math.max(e, Math.ceil(h + 0.25));
  }
  return [a + s * 3600, a + e * 3600];
}
function niceTop(v) {
  const x = Math.max(v * 1.1, 20);
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (x <= m * mag) return m * mag;
  return 10 * mag;
}
// グラフの棒をタップ・なぞると、その15分の数字を出す
function bindDayChart(key, sum) {
  const svg = $('#daychart'), info = $('#bin-info'), sel = $('#bin-sel');
  if (!svg || !info) return;
  const { W, L, R } = DAY_CHART;
  const iw = W - L - R;
  const [a0, a1] = dayRange(key, sum);
  const byStart = new Map(sum.bins.map(r => [r.ts, r]));
  const show = binTs => {
    const r = byStart.get(binTs);
    const shots = sum.shots.filter(s => s.ts >= binTs && s.ts < binTs + 900);
    sel.setAttribute('x', L + ((binTs - a0) / (a1 - a0)) * iw);
    sel.setAttribute('width', (900 / (a1 - a0)) * iw);
    sel.removeAttribute('hidden');
    let h = `<div class="bin-head num">${hmOf(binTs)}〜${hmOf(binTs + 900)}</div>`;
    if (!r) h += '<p class="muted small">この15分の記録はありません。</p>';
    else {
      h += '<div class="props">';
      h += prop('日射の積算', `<span class="num">${fmtN(r.solar_vs, 1)} V・秒</span> <span class="muted small">平均 ${fmtN(r.solar_vs / 900, 2)} V</span>`);
      h += prop('いちばん強いとき', `<span class="num">${fmtN(r.solar_max_v, 2)} V</span>`);
      h += prop('電池', r.bat_v ? `<span class="num">${fmtN(r.bat_v, 2)} V</span>` : '—');
      h += prop('タンク', r.refill_low ? '<span class="tag red">水が少ない</span>' : '<span class="tag green">水あり</span>');
      h += '</div>';
    }
    if (shots.length) h += `<div class="props">${prop('給水', shots.map(s => `${hmOf(s.ts)} ${esc(KIND_JA[s.kind] || s.kind)} ${s.sec}秒`).join('<br>'))}</div>`;
    info.innerHTML = h;
  };
  const pick = ev => {
    const rect = svg.getBoundingClientRect();
    const xs = ((ev.clientX - rect.left) / rect.width) * W;
    const frac = clamp((xs - L) / iw, 0, 0.9999);
    show(a0 + Math.floor((frac * (a1 - a0)) / 900) * 900);
  };
  let down = false;
  svg.addEventListener('pointerdown', ev => { down = true; try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 古いブラウザ */ } pick(ev); });
  svg.addEventListener('pointermove', ev => { if (down || ev.pointerType === 'mouse') pick(ev); });
  svg.addEventListener('pointerup', () => { down = false; });
  svg.addEventListener('pointercancel', () => { down = false; });
  // 最初は、記録のある最後の15分（今日）か、日射のいちばん多い15分（ほかの日）を出す
  const inRange = sum.bins.filter(r => r.ts >= a0 && r.ts < a1);
  if (inRange.length) {
    const first = key === todayKey() ? inRange[inRange.length - 1] : inRange.reduce((m, r) => (r.solar_vs > m.solar_vs ? r : m), inRange[0]);
    show(first.ts);
  } else {
    info.innerHTML = '<p class="muted small">この範囲の記録はありません。</p>';
  }
}
function dayChart(key, sum, isToday) {
  const { W, H, L, R, T, B } = DAY_CHART;
  const iw = W - L - R, ih = H - T - B;
  const [a0, a1] = dayRange(key, sum);
  const bins = sum.bins.filter(r => r.ts >= a0 && r.ts < a1);
  const top = niceTop(Math.max(0, ...bins.map(r => r.solar_vs)));
  const x = ts => L + ((ts - a0) / (a1 - a0)) * iw;
  const y = v => T + ih - (v / top) * ih;
  const hours = (a1 - a0) / 3600;
  let s = `<div class="seg chart-seg" id="seg-day"><button data-v="0" class="${S.view.dayFull ? '' : 'on'}">日中</button><button data-v="1" class="${S.view.dayFull ? 'on' : ''}">24時間</button></div>
    <svg class="chart daychart" id="daychart" viewBox="0 0 ${W} ${H}" role="img" aria-label="15分ごとの日射の積算と給水の時刻">
    <rect id="bin-sel" class="binsel" x="0" y="${T - 8}" width="0" height="${ih + 8}" hidden/>`;
  for (let i = 0; i <= 4; i++) { const v = (top / 4) * i; s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 3}" y="${y(v) + 3}" text-anchor="end">${fmtN(v)}</text>`; }
  const step = hours > 16 ? 3 : 2;
  const h0 = Math.round((a0 - dayStart(key)) / 3600);
  for (let h = Math.ceil(h0 / step) * step; h <= h0 + hours; h += step) {
    const tx = x(dayStart(key) + h * 3600);
    s += `<line class="grid" x1="${tx}" x2="${tx}" y1="${T}" y2="${T + ih}" opacity=".5"/><text x="${tx}" y="${H - 6}" text-anchor="middle">${h}時</text>`;
  }
  const bw = Math.max(1, (900 / (a1 - a0)) * iw - 1);
  const peakStart = peakWindow(sum.bins);
  for (const r of bins) {
    const hi = peakStart != null && r.ts >= peakStart && r.ts < peakStart + 3600;
    s += `<rect class="bar${hi ? ' hi' : ''}" x="${x(r.ts) + 0.5}" y="${y(r.solar_vs)}" width="${bw}" height="${Math.max(0, T + ih - y(r.solar_vs))}"></rect>`;
  }
  let outside = 0;
  for (const sh of sum.shots) {
    if (sh.ts < a0 || sh.ts >= a1) { outside++; continue; }
    const cx = x(sh.ts);
    s += `<line class="shot" x1="${cx}" x2="${cx}" y1="${T - 2}" y2="${T + ih}" opacity=".35"/><circle class="shotdot" cx="${cx}" cy="${T - 4}" r="3"></circle>`;
  }
  if (isToday) { const n = nowTs(); if (n >= a0 && n < a1) { const cx = x(n); s += `<line class="nowline" x1="${cx}" x2="${cx}" y1="${T}" y2="${T + ih}"/>`; } }
  s += '</svg>';
  const notes = [];
  if (peakStart != null) notes.push(`濃い色は、この日いちばん日射が多かった1時間（${hmOf(peakStart)}〜）です。`);
  if (outside) notes.push(`グラフの範囲の外に給水が${outside}回あります（下の一覧を見てください）。`);
  if (notes.length) s += `<p class="hint">${notes.join('')}</p>`;
  return s;
}
function peakWindow(bins) {
  let best = 0, at = null;
  for (let i = 0; i < bins.length; i++) {
    let sum = 0;
    for (let j = i; j < bins.length && bins[j].ts < bins[i].ts + 3600; j++) sum += bins[j].solar_vs;
    if (sum > best) { best = sum; at = bins[i].ts; }
  }
  return best > 0 ? at : null;
}

// ---- 履歴 --------------------------------------------------------------------
async function renderHistory(page) {
  const n = S.view.range;
  const end = todayKey(), start = addDays(end, -(n - 1));
  await ensureMonths(monthsBetween(start, end));
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(daySummary(addDays(end, -i)));
  const metric = S.view.metric;
  const M = {
    peak: { label: '最大1時間の日射', unit: 'V・秒', get: d => d.peak },
    sol: { label: '1日の日射の合計', unit: 'V・秒', get: d => d.sol },
    shots: { label: '給水の回数', unit: '回', get: d => d.nShots },
    bat: { label: '電池（その日の最低）', unit: 'V', get: d => d.batMin },
  }[metric];
  const withData = days.filter(d => d.bins.length);
  const peaks = withData.map(d => d.peak);
  let html = `<h1 class="title">履歴</h1><p class="subtitle">${esc(dayLabel(start))} 〜 ${esc(dayLabel(end))}</p>
    <div class="btns">
      <div class="seg" id="seg-range">${[7, 14, 30, 90].map(v => `<button data-v="${v}" class="${v === n ? 'on' : ''}">${v}日</button>`).join('')}</div>
      <div class="seg" id="seg-metric">${[['peak', '最大1時間'], ['sol', '日射合計'], ['shots', '給水'], ['bat', '電池']].map(([v, l]) => `<button data-v="${v}" class="${v === metric ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>`;
  if (peaks.length) {
    html += callout('info', `この期間の「最大1時間の日射」は、いちばん多い日で <b class="num">${fmtN(Math.max(...peaks))}</b> V・秒、平均で <b class="num">${fmtN(peaks.reduce((a, b) => a + b, 0) / peaks.length)}</b> V・秒でした。日射比例のしきい値を決める目安になります。`);
  }
  if (metric === 'bat') html += `<h2>電池の電圧（15分ごと）</h2>${batteryChart(dayStart(start), dayStart(end) + 86400)}`;
  else html += `<h2>${esc(M.label)}</h2>${historyChart(days, M)}`;
  html += `<h2>日ごと</h2><div class="table-wrap"><table class="db"><thead><tr>
      <th>日付</th><th class="r">最大1時間</th><th class="r">日射合計</th><th class="r">給水</th><th class="r">量</th><th class="r">電池</th><th>タンク</th></tr></thead><tbody>`;
  for (const d of [...days].reverse()) {
    const ml = mlOf(d.pumpS);
    html += `<tr class="link" data-day="${d.key}"><td>${esc(dayLabel(d.key))}</td>
      <td class="r">${d.bins.length ? fmtN(d.peak) : '—'}</td><td class="r">${d.bins.length ? fmtN(d.sol) : '—'}</td>
      <td class="r">${d.nShots}</td><td class="r">${ml != null ? fmtN(ml) + ' mL' : (d.pumpS ? d.pumpS + ' 秒' : '—')}</td>
      <td class="r">${d.batMin ? fmtN(d.batMin, 2) : '—'}</td><td>${d.bins.length ? (d.refillLow ? '<span class="tag red">少</span>' : '<span class="tag">あり</span>') : ''}</td></tr>`;
  }
  html += '</tbody></table></div>';
  page.innerHTML = html;
  page.querySelectorAll('#seg-range button').forEach(b => b.onclick = () => { S.view.range = Number(b.dataset.v); render(); });
  page.querySelectorAll('#seg-metric button').forEach(b => b.onclick = () => { S.view.metric = b.dataset.v; render(); });
  page.querySelectorAll('tr[data-day]').forEach(tr => tr.onclick = () => { location.hash = `#today/${tr.dataset.day}`; });
}
// 電池の電圧の折れ線。1時間以上記録が途切れた所は線をつながない。急に上がった所（充電）に印を付ける
function batteryChart(fromTs, toTs) {
  const pts = binsBetween(fromTs, toTs).filter(r => r.bat_v).map(r => ({ ts: r.ts, v: r.bat_v }));
  if (pts.length < 2) return '<p class="muted">電池の記録がまだ足りません。</p>';
  const W = 400, H = 220, L = 34, R = 6, T = 12, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const a0 = Math.max(fromTs, pts[0].ts - 3600), a1 = Math.min(toTs, Math.max(nowTs(), pts[pts.length - 1].ts + 900));
  const vs = pts.map(p => p.v);
  const lo = Math.floor((Math.min(...vs) - 0.05) * 10) / 10, hi = Math.ceil((Math.max(...vs) + 0.05) * 10) / 10;
  const x = ts => L + ((ts - a0) / (a1 - a0)) * iw;
  const y = v => T + ih - ((v - lo) / (hi - lo)) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="電池の電圧の推移">`;
  const steps = Math.round((hi - lo) / 0.1);
  const every = steps > 8 ? Math.ceil(steps / 6) : 1;
  for (let i = 0; i <= steps; i += every) { const v = lo + i * 0.1; s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 3}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(1)}</text>`; }
  const days = (a1 - a0) / 86400;
  const stepD = days > 31 ? 14 : days > 14 ? 5 : days > 7 ? 2 : 1;
  for (let d = dayStart(dayKeyOf(a0)) + 86400, i = 0; d < a1; d += 86400, i++) {
    if (i % stepD) continue;
    const k = dayKeyOf(d + 3600);
    s += `<line class="grid" x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${T + ih}" opacity=".5"/><text x="${x(d)}" y="${H - 6}" text-anchor="middle">${Number(k.slice(5, 7))}/${Number(k.slice(8))}</text>`;
  }
  let path = '', charges = [];
  pts.forEach((p, i) => {
    const prev = pts[i - 1];
    const gap = !prev || p.ts - prev.ts > 3600;
    path += `${gap ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`;
    if (prev && p.v - prev.v >= 0.25) charges.push(p.ts);
  });
  s += `<path d="${path}" fill="none" stroke="var(--bar-strong)" stroke-width="1.8" stroke-linejoin="round"/>`;
  for (const c of charges) s += `<line class="nowline" x1="${x(c)}" x2="${x(c)}" y1="${T}" y2="${T + ih}" style="stroke:var(--green)"/><text x="${x(c) + 3}" y="${T + 10}" text-anchor="start" style="fill:var(--green)">充電</text>`;
  s += '</svg>';
  // 直近3日（前回の充電より後）の下がり方
  const lastCharge = charges.length ? charges[charges.length - 1] : -Infinity;
  const recent = pts.filter(p => p.ts >= Math.max(lastCharge, nowTs() - 3 * 86400));
  let note = `いまの電圧は <b class="num">${fmtN(pts[pts.length - 1].v, 2)}</b> V です。`;
  if (recent.length >= 8 && recent[recent.length - 1].ts - recent[0].ts >= 86400) {
    const n = recent.length, mx = recent.reduce((a, p) => a + p.ts, 0) / n, my = recent.reduce((a, p) => a + p.v, 0) / n;
    const slope = recent.reduce((a, p) => a + (p.ts - mx) * (p.v - my), 0) / recent.reduce((a, p) => a + (p.ts - mx) ** 2, 0);
    note += ` 直近の下がり方は1日あたり約 <b class="num">${fmtN(-slope * 86400, 3)}</b> V です。`;
  }
  if (charges.length) note += ` 前回の充電は ${esc(dayLabel(dayKeyOf(lastCharge)))} です。`;
  s += `<p class="hint">${note}この電池（リン酸鉄リチウム）は残量が変わっても電圧があまり変わらないので、「残り何%」の目安にはなりません。下がり方が急になってきたら充電どきです。</p>`;
  return s;
}
function historyChart(days, M) {
  const W = 700, H = 180, L = 40, R = 8, T = 10, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const vals = days.map(d => d.bins.length || M.unit === '回' ? M.get(d) : null);
  const nums = vals.filter(v => v != null);
  let lo = 0, hi = Math.max(1, ...nums);
  if (M.unit === 'V' && nums.length) { lo = Math.floor(Math.min(...nums) * 10) / 10 - 0.1; hi = Math.ceil(hi * 10) / 10 + 0.1; }
  const y = v => T + ih - ((v - lo) / (hi - lo)) * ih;
  const bw = iw / days.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(M.label)}の推移">`;
  for (let i = 0; i <= 3; i++) { const v = lo + ((hi - lo) / 3) * i; s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmtN(v, M.unit === 'V' ? 1 : 0)}</text>`; }
  days.forEach((d, i) => {
    const v = vals[i];
    const cx = L + i * bw;
    if (v != null) s += `<rect class="bar hi" x="${cx + bw * 0.15}" y="${y(v)}" width="${bw * 0.7}" height="${Math.max(0, T + ih - y(v))}"><title>${esc(dayLabel(d.key))} ${fmtN(v, M.unit === 'V' ? 2 : 0)} ${M.unit}</title></rect>`;
    const step = days.length > 31 ? 14 : days.length > 14 ? 5 : days.length > 7 ? 2 : 1;
    if (i % step === 0) s += `<text x="${cx + bw / 2}" y="${H - 6}" text-anchor="middle">${Number(d.key.slice(5, 7))}/${Number(d.key.slice(8))}</text>`;
  });
  return s + '</svg>';
}

// ---- プログラム一覧 --------------------------------------------------------
function viewPrograms() {
  const d = S.draft;
  if (!d) return '<p class="skeleton">読み込んでいます…</p>';
  const today = todayKey();
  const pf = programForDay(today);
  let html = `<h1 class="title">潅水プログラム</h1><p class="subtitle">給水の条件をプログラムとして保存し、月ごとに割り当てます。今日は「${esc(progName(pf?.id))}」です。</p>`;
  html += '<h2>プログラム</h2><div class="list">';
  for (const p of d.programs) {
    html += `<a class="row" href="#program/${encodeURIComponent(p.id)}"><div class="main"><div class="name">${esc(p.name)}</div><div class="desc">${esc(describeProgram(p))}</div></div><span class="chev">›</span></a>`;
  }
  html += '<div class="row add" id="add-prog"><div class="main">＋ 新しいプログラム</div></div></div>';

  const opts = sel => `<option value="stop" ${sel === 'stop' ? 'selected' : ''}>停止</option>` + d.programs.map(p => `<option value="${esc(p.id)}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  html += '<h2>月ごとの割り当て</h2><p class="hint">その月に使うプログラムを選びます。「停止」の月は自動で給水しません（手動ボタンは使えます）。</p><div>';
  (d.months || []).forEach((id, i) => {
    html += `<div class="field"><label for="m${i}">${MONTHS[i]}</label><div class="ctl"><select class="in w-full" id="m${i}" data-month="${i}">${opts(id)}</select></div></div>`;
  });
  html += '</div>';

  html += '<h2>期間の上書き（試験用）</h2><p class="hint">決めた期間だけ、月の割り当てより優先して使います。期間が終わると元に戻ります。</p>';
  const ovs = d.overrides || [];
  if (!ovs.length) html += '<p class="muted small">ありません。</p>';
  ovs.forEach((o, i) => {
    const past = o.end < today;
    html += `<div class="block"><div class="fixed-row">
      <input class="in w-time" type="date" data-ov="${i}" data-k="start" value="${esc(o.start)}" aria-label="開始日">
      <span class="unit">〜</span>
      <input class="in w-time" type="date" data-ov="${i}" data-k="end" value="${esc(o.end)}" aria-label="終了日">
      <button class="x" data-ovdel="${i}" aria-label="この上書きを消す">×</button></div>
      <div class="fixed-row"><select class="in w-full" data-ov="${i}" data-k="program">${opts(o.program)}</select></div>
      ${past ? '<p class="hint">この期間は終わっています。</p>' : ''}</div>`;
  });
  html += `<div class="btns"><button class="btn" id="add-ov">＋ 期間を追加</button></div>`;
  const errs = validateDraft(d);
  if (errs.length) html += callout('err', errs.map(esc).join('<br>'));
  return html;
}
function bindPrograms() {
  const d = S.draft;
  $('#add-prog').onclick = () => { const p = newProgram(); d.programs.push(p); location.hash = `#program/${encodeURIComponent(p.id)}`; };
  document.querySelectorAll('select[data-month]').forEach(el => el.onchange = () => { d.months[Number(el.dataset.month)] = el.value; rerenderSoft(); });
  document.querySelectorAll('[data-ov]').forEach(el => el.onchange = () => { d.overrides[Number(el.dataset.ov)][el.dataset.k] = el.value; rerenderSoft(); });
  document.querySelectorAll('[data-ovdel]').forEach(el => el.onclick = () => { d.overrides.splice(Number(el.dataset.ovdel), 1); rerenderSoft(); });
  $('#add-ov').onclick = () => {
    d.overrides = d.overrides || [];
    const t = todayKey();
    d.overrides.push({ start: t, end: addDays(t, 6), program: d.programs[0]?.id || 'stop' });
    rerenderSoft();
  };
}
function rerenderSoft() { const y = window.scrollY; render().then(() => window.scrollTo(0, y)); }

// ---- プログラムの編集 --------------------------------------------------------
function recentPeak() {
  const end = todayKey(); const vals = [];
  for (let i = 0; i < 14; i++) { const s = daySummary(addDays(end, -i)); if (s.bins.length) vals.push(s.peak); }
  return vals.length ? Math.max(...vals) : null;
}
function viewProgram(id) {
  const p = progById(id);
  if (!p) return `<div class="crumbs"><button onclick="location.hash='#programs'">‹ 潅水プログラム</button></div><h1 class="title">見つかりません</h1><p class="muted">削除されたか、まだ保存されていないプログラムです。</p>`;
  const d = S.draft;
  const usedMonths = (d.months || []).map((m, i) => m === p.id ? MONTHS[i] : null).filter(Boolean);
  const usedOv = (d.overrides || []).filter(o => o.program === p.id);
  const peak = recentPeak();
  let html = `<div class="crumbs"><button id="back">‹ 潅水プログラム</button></div>
    <input class="title" id="p-name" value="${esc(p.name)}" placeholder="名前" aria-label="プログラムの名前">
    <div class="props">
      ${prop('使っている月', usedMonths.length ? usedMonths.join('・') : '<span class="muted">なし</span>')}
      ${usedOv.length ? prop('期間の上書き', usedOv.map(o => `${esc(o.start)}〜${esc(o.end)}`).join('<br>')) : ''}
      ${prop('メモ', `<input class="in w-full" id="p-memo" value="${esc(p.memo || '')}" placeholder="なんのためのプログラムか">`)}
    </div>`;

  html += `<div class="block"><h3>固定時刻の給水</h3><p class="hint">毎日決まった時刻に給水します（最大${LIMITS.fixed}件）。起動が遅れて60分以上過ぎた分は飛ばします。</p>`;
  (p.fixed || []).forEach((f, i) => {
    html += `<div class="fixed-row"><input class="in w-time" type="time" data-fx="${i}" data-k="time" value="${esc(f.time)}" aria-label="時刻">
      <input class="in w-num" type="number" min="1" max="120" data-fx="${i}" data-k="sec" value="${f.sec}" aria-label="秒数"><span class="unit">秒</span>
      <button class="x" data-fxdel="${i}" aria-label="この時刻を消す">×</button></div>`;
  });
  if ((p.fixed || []).length < LIMITS.fixed) html += '<div class="btns"><button class="btn" id="add-fx">＋ 時刻を追加</button></div>';
  html += '</div>';

  const pr = p.prop;
  html += `<div class="block"><h3>日射比例の給水</h3>
    <label class="toggle"><input type="checkbox" id="pr-on" ${pr.on ? 'checked' : ''}> 日射の量に合わせて給水する</label>
    <p class="hint">日射の積算がしきい値を超えるたびに1回給水します。晴れた暑い日の「最大1時間の日射」をしきい値にすると、その日はおよそ1時間おきになります。${peak ? `直近2週間の最大は <b class="num">${fmtN(peak)}</b> V・秒です。` : ''}</p>
    <div ${pr.on ? '' : 'hidden'} id="pr-fields">
      <div class="field"><label for="pr-th">しきい値</label><div class="ctl"><input class="in w-num" type="number" min="1" step="10" id="pr-th" value="${pr.thresh_vs || ''}"><span class="unit">V・秒</span></div></div>
      <div class="field"><label for="pr-sec">1回の秒数</label><div class="ctl"><input class="in w-num" type="number" min="1" max="120" id="pr-sec" value="${pr.sec}"><span class="unit">秒</span></div></div>
      <div class="field"><label for="pr-iv">最短の間隔</label><div class="ctl"><input class="in w-num" type="number" min="10" id="pr-iv" value="${pr.interval_min}"><span class="unit">分（10分以上）</span></div></div>
      <div class="field"><label>時間帯</label><div class="ctl"><input class="in w-time" type="time" id="pr-start" value="${esc(pr.start)}"><span class="unit">〜</span><input class="in w-time" type="time" id="pr-end" value="${esc(pr.end)}"></div></div>
    </div></div>`;

  html += `<div class="block"><h3>給水しない時刻</h3>
    <div class="field"><label for="p-cut">この時刻以降</label><div class="ctl"><input class="in w-time" type="time" id="p-cut" value="${esc(p.cutoff)}"><span class="unit">は固定時刻も日射比例もしない</span></div></div></div>`;

  html += `<div class="block"><h3>1日の上限</h3>
    <div class="field"><label for="p-max">自動の給水</label><div class="ctl"><input class="in w-num" type="number" min="1" max="40" id="p-max" value="${p.max_day}"><span class="unit">回に達したら</span>
      <select class="in" id="p-maxact"><option value="notify" ${p.max_action !== 'stop' ? 'selected' : ''}>通知だけ</option><option value="stop" ${p.max_action === 'stop' ? 'selected' : ''}>止める</option></select></div></div>
    <p class="hint">手動ボタンの給水は数えません。設定にかかわらず、装置は1日40回で止まります。</p></div>`;

  html += `<div class="block"><h3>このプログラムの説明</h3><p>${esc(describeProgram(p))}</p></div>`;
  html += `<div class="btns"><button class="btn" id="dup">複製</button><button class="btn danger" id="del">削除</button></div>`;
  const errs = validateDraft(S.draft).filter(e => e.startsWith(p.name + '：') || e.startsWith('名前のない'));
  if (errs.length) html += callout('err', errs.map(esc).join('<br>'));
  return html;
}
function bindProgram(id) {
  const p = progById(id); if (!p) return;
  const d = S.draft;
  $('#back').onclick = () => { location.hash = '#programs'; };
  const soft = () => { updateSavebar(); };
  $('#p-name').oninput = e => { p.name = e.target.value; soft(); };
  $('#p-name').onchange = () => rerenderSoft();
  $('#p-memo').oninput = e => { p.memo = e.target.value; soft(); };
  document.querySelectorAll('[data-fx]').forEach(el => el.onchange = () => {
    const f = p.fixed[Number(el.dataset.fx)];
    f[el.dataset.k] = el.dataset.k === 'sec' ? clamp(Number(el.value) || 1, 1, 120) : el.value;
    p.fixed.sort((a, b) => toMin(a.time) - toMin(b.time)); rerenderSoft();
  });
  document.querySelectorAll('[data-fxdel]').forEach(el => el.onclick = () => { p.fixed.splice(Number(el.dataset.fxdel), 1); rerenderSoft(); });
  const af = $('#add-fx'); if (af) af.onclick = () => { p.fixed.push({ time: p.fixed.length ? '12:00' : '06:00', sec: 10 }); p.fixed.sort((a, b) => toMin(a.time) - toMin(b.time)); rerenderSoft(); };
  $('#pr-on').onchange = e => { p.prop.on = e.target.checked; rerenderSoft(); };
  const num = (sel, fn) => { const el = $(sel); if (el) el.onchange = () => { fn(Number(el.value)); rerenderSoft(); }; };
  num('#pr-th', v => { p.prop.thresh_vs = Math.max(0, v || 0); });
  num('#pr-sec', v => { p.prop.sec = clamp(v || 1, 1, 120); });
  num('#pr-iv', v => { p.prop.interval_min = Math.max(10, v || 10); });
  const t = (sel, fn) => { const el = $(sel); if (el) el.onchange = () => { if (el.value) fn(el.value); rerenderSoft(); }; };
  t('#pr-start', v => { p.prop.start = v; });
  t('#pr-end', v => { p.prop.end = v; });
  t('#p-cut', v => { p.cutoff = v; });
  num('#p-max', v => { p.max_day = clamp(v || 1, 1, 40); });
  $('#p-maxact').onchange = e => { p.max_action = e.target.value; rerenderSoft(); };
  $('#dup').onclick = () => {
    const c = clone(p); c.id = 'p' + Date.now().toString(36); c.name = p.name + '（コピー）';
    d.programs.splice(d.programs.indexOf(p) + 1, 0, c);
    location.hash = `#program/${encodeURIComponent(c.id)}`;
  };
  $('#del').onclick = () => {
    const inUse = d.months.includes(p.id) || (d.overrides || []).some(o => o.program === p.id);
    if (d.programs.length <= 1) { toast('プログラムは1つ以上必要です'); return; }
    if (!confirm(inUse ? `「${p.name}」は月の割り当てか期間の上書きで使われています。削除すると、その月・期間は「停止」になります。削除しますか？` : `「${p.name}」を削除しますか？`)) return;
    d.programs = d.programs.filter(x => x.id !== p.id);
    d.months = d.months.map(m => m === p.id ? 'stop' : m);
    d.overrides = (d.overrides || []).map(o => o.program === p.id ? { ...o, program: 'stop' } : o);
    location.hash = '#programs';
  };
}

// ---- 設定 --------------------------------------------------------------------
function viewSettings() {
  const st = S.settings;
  const d = S.draft;
  let html = `<h1 class="title">設定</h1>`;
  if (!st.token) {
    html += callout('info', `はじめに、GitHubの「鍵」を入れてください。記録を読んだり、潅水プログラムを保存したりするのに使います。鍵はこのスマホの中にだけ保存されます。<br><br>
      作り方：<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHubの鍵を作るページ</a>で、対象のリポジトリを <b>veranda-kansui</b> だけにし、権限の「Contents」を「Read and write」にして作ります。`);
  }
  html += `<h2>GitHubの鍵</h2>
    <div class="field"><label for="s-token">鍵</label><div class="ctl"><input class="in w-full" type="password" id="s-token" value="${esc(st.token)}" placeholder="github_pat_…" autocomplete="off"></div></div>
    <div class="field"><label for="s-repo">保存先</label><div class="ctl"><input class="in w-full" id="s-repo" value="${esc(st.repo)}"></div></div>
    <div class="btns"><button class="btn primary" id="s-save">鍵を保存して読み込む</button>${st.token ? '<button class="btn danger" id="s-clear">鍵を消す</button>' : ''}</div>`;
  if (S.error && S.error !== 'no-token' && S.error !== 'no-repo') html += callout('err', esc(S.error));
  if (S.error === 'no-repo') html += callout('err', '保存先が見つかりません。鍵の対象に veranda-kansui が入っているか確かめてください。');

  if (d) {
    const c = d.common;
    html += `<h2>共通の設定</h2><p class="hint">どのプログラムでも使う値です。変えたら画面下の「保存」を押してください。</p>
      <div class="field"><label for="c-ms">手動ボタン</label><div class="ctl"><input class="in w-num" type="number" min="1" max="120" id="c-ms" value="${c.manual_sec}"><span class="unit">秒（1回押したとき）</span></div></div>
      <div class="field"><label for="c-bw">電池の警告</label><div class="ctl"><input class="in w-num" type="number" step="0.1" id="c-bw" value="${c.bat_warn_v}"><span class="unit">V を下回ったら通知</span></div></div>
      <div class="field"><label for="c-bs">電池の停止</label><div class="ctl"><input class="in w-num" type="number" step="0.1" id="c-bs" value="${c.bat_stop_v}"><span class="unit">V を下回ったら給水を止める</span></div></div>
      <div class="field"><label for="c-flow">ポンプの流量</label><div class="ctl"><input class="in w-num" type="number" step="0.1" min="0" id="c-flow" value="${c.flow_ml_s || ''}"><span class="unit">mL/秒（給水量の計算に使う。0=未測定）</span></div></div>
      <p class="hint">流量の測り方：ボタンを押して10秒回し、3鉢から出た水を計量カップに受けて合計し、10で割ります。</p>`;
  }
  const st2 = S.status || {};
  html += `<h2>装置</h2><div class="props">
      ${prop('ファーム', esc(S.latest?.fw || st2.fw || '—'))}
      ${prop('設定の版', `装置 ${esc(S.latest?.cfg ?? st2.cfg_applied ?? '—')} ／ 最新 ${esc(S.programs?.version ?? '—')}`)}
      ${prop('記録の収集', esc(st2.collected ? st2.collected.replace('T', ' ').slice(0, 16) : '—'))}
      ${prop('アプリ', APP_VER)}
    </div>
    <div class="btns"><button class="btn" id="s-reload">読み直す</button></div>`;
  return html;
}
function bindSettings() {
  $('#s-save').onclick = async () => {
    S.settings.token = $('#s-token').value.trim();
    S.settings.repo = $('#s-repo').value.trim() || DEFAULT_REPO;
    saveSettings();
    S.draft = null;
    await loadCore();
    if (!S.error) { toast('読み込みました'); location.hash = '#today'; }
    render();
  };
  const cl = $('#s-clear'); if (cl) cl.onclick = () => { if (!confirm('このスマホから鍵を消しますか？')) return; S.settings.token = ''; saveSettings(); S.error = 'no-token'; render(); };
  const rl = $('#s-reload'); if (rl) rl.onclick = async () => { await loadCore(); toast(S.error ? '読み込めませんでした' : '読み直しました'); render(); };
  const c = S.draft?.common; if (!c) return;
  const bind = (sel, fn) => { const el = $(sel); if (el) el.onchange = () => { fn(Number(el.value)); updateSavebar(); }; };
  bind('#c-ms', v => { c.manual_sec = clamp(v || 1, 1, 120); });
  bind('#c-bw', v => { c.bat_warn_v = v; });
  bind('#c-bs', v => { c.bat_stop_v = v; });
  bind('#c-flow', v => { c.flow_ml_s = Math.max(0, v || 0); });
}

// ---- 起動 ------------------------------------------------------------------
$('#btn-save').onclick = saveDraft;
$('#btn-revert').onclick = () => { if (!confirm('保存していない変更を取り消しますか？')) return; S.draft = clone(S.programs); render(); };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  // 画面に戻ってきたら、今日の画面だけ最新にする（編集中は読み直さない）
  if (document.visibilityState === 'visible' && S.settings.token && !isDirty() && route().name === 'today') {
    await loadCore(); render();
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => { render(); await loadCore(); render(); })();
