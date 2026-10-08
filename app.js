'use strict';

/* ===== 設定 ===== */
const STOP_SLIDE_RATIO = 0.9;  // 停止スライダーをこの割合以上動かすと停止
const FIX_WINDOW_MS = 1500;    // 区切った直後この時間内に別のボタン → 直前区間の判定を修正
const MIN_SEG_MS = 300;        // これより短い区間は作らない（二度押し対策）
const MIN_PIN_GAP_MS = 300;    // ピンの二度押し対策
const STORE_KEY = 'fieldmemo.v1';
const PREF_KEY = 'fieldmemo.prefs';

const RATING_KEYS = ['star', 'ok', 'ng', 'none'];
const RATING_TEXT = { star: 'OK★', ok: 'OK', ng: 'NG', none: '未判定' };
const CYCLE = { none: 'ok', ok: 'star', star: 'ng', ng: null };
const rk = r => r || 'none';

/* ===== 状態 =====
 * session = {
 *   id, name, startedAt(epoch ms), endedAt(epoch ms|null),
 *   segments: [{ end(ms), rating('star'|'ok'|'ng'|null), note }],
 *   pins: [{ id, t(ms), text }]   // 時刻順
 * }
 * 区間 i は segments[i-1].end（先頭は 0）から segments[i].end まで。
 * 記録中は「閉じた区間」だけが segments に入り、最後の区切り〜現在が記録中の区間。
 * 時刻はすべてミリ秒で保存し、画面表示だけ 0.1 秒単位にしている。
 */
let db = loadDB();
let prefs = loadPrefs();
let detailId = null;
let recSel = null;     // 記録中に選択中の項目キー（'s3' / 'p<id>' / 'live'）
let detSel = null;     // 詳細画面で選択中の項目キー
let sheet = null;      // { sid, kind: 'seg'|'pin', ref }
let tickTimer = null;
let lastTlDraw = 0;
let wakeLock = null;
let wakeBusy = false;
let pendingHaptic = false;
let recTL = null;
let detTL = null;

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

/* ===== 保存 ===== */
function loadDB() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.sessions)) {
      for (const s of d.sessions) if (!Array.isArray(s.pins)) s.pins = [];
      return d;
    }
  } catch (_) {}
  return { sessions: [], activeId: null };
}

function saveDB() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (_) {
    toast('保存できませんでした（容量不足またはプライベートモード）', 'warn', 4000);
  }
}

function loadPrefs() {
  const p = { rec: 'all', detail: 'all' };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    if (saved.rec) p.rec = saved.rec;
    if (saved.detail) p.detail = saved.detail;
  } catch (_) {}
  return p;
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {}
}

/* ===== セッション ===== */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const getSession = id => db.sessions.find(s => s.id === id) || null;
const activeSession = () => (db.activeId && getSession(db.activeId)) || null;
const lastEnd = s => (s.segments.length ? s.segments[s.segments.length - 1].end : 0);
const durationOf = s => (s.endedAt ?? Date.now()) - s.startedAt;
const defaultName = t => `${fmtDate(t)} ${fmtClockTime(t)}`;
const sortPins = s => s.pins.sort((a, b) => a.t - b.t);

function segmentsOf(s) {
  let prev = 0;
  return s.segments.map((g, i) => {
    const seg = { i, key: 's' + i, start: prev, end: g.end, rating: g.rating ?? null, note: g.note || '' };
    prev = g.end;
    return seg;
  });
}

// 表示用のピン（番号付き）
const pinsOf = s => s.pins.map((p, i) => ({ ...p, n: i + 1, key: 'p' + p.id }));

function summarize(segs) {
  const sum = {};
  for (const k of RATING_KEYS) sum[k] = { n: 0, ms: 0 };
  for (const g of segs) {
    const k = rk(g.rating);
    sum[k].n++;
    sum[k].ms += g.end - g.start;
  }
  return sum;
}

/* ===== 時間の表示 ===== */
const pad = (n, w = 2) => String(n).padStart(w, '0');

function splitTime(ms) {
  ms = Math.max(0, Math.floor(ms));
  const s = Math.floor(ms / 1000);
  return { h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60, s: s % 60, ds: Math.floor(ms / 100) % 10, ms: ms % 1000 };
}

// 画面表示用（0.1秒単位）: 1:23.4 / 1:02:03.4
function fmt(ms) {
  const t = splitTime(ms);
  return t.h ? `${t.h}:${pad(t.m)}:${pad(t.s)}.${t.ds}` : `${t.m}:${pad(t.s)}.${t.ds}`;
}

// CSV用（ミリ秒）: 00:01:23.456
function fmtTC(ms) {
  const t = splitTime(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}.${pad(t.ms, 3)}`;
}

const fmtSec = ms => (Math.max(0, ms) / 1000).toFixed(3);

function fmtDate(epoch) {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtClockTime(epoch) {
  const d = new Date(epoch);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 2026-10-08 14:23:05.123
const fmtDateTimeMs = epoch => `${fmtDate(epoch)} ${fmtClockTime(epoch)}.${pad(new Date(epoch).getMilliseconds(), 3)}`;

function fmtTick(ms, step) {
  if (ms === 0) return '0';
  const t = splitTime(ms);
  if (step < 60000) return `${t.h * 60 + t.m}:${pad(t.s)}`;
  if (t.h) return t.m ? `${t.h}h${pad(t.m)}` : `${t.h}h`;
  return `${t.m}m`;
}

// "1:23.4" / "83.4" / "1:02:03.5" → ミリ秒（不正なら null）
function parseTime(str) {
  const parts = str.trim().split(':');
  if (parts.length > 3 || parts.some(p => !/^\d+(\.\d*)?$/.test(p))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return Math.round(sec * 1000);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ===== タイムライン ===== */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].map(s => s * 1000);
const SPANS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240].map(m => m * 60000);
const TL_PAD = 14; // .tl-content の左右 padding

const tickStep = span => TICK_STEPS.find(s => span / s <= 5) || 3600000 * Math.ceil(span / 5 / 3600000);
// 記録中の「全体」表示は、目盛りが頻繁に変わらないようキリのいい長さで広げていく
const niceSpan = ms => SPANS.find(s => ms <= s * 0.97) || Math.ceil(ms / 0.97 / 3600000) * 3600000;

/*
 * 横スクロールできるタイムライン。
 * 「全体」は画面幅に収め、「5分」「1分」は画面幅＝その時間の縮尺で横に伸びる。
 * 記録中は最新位置に自動で追従し、指で過去へスクロールすると追従を止める。
 */
class Timeline {
  constructor(root, prefKey, onPick) {
    this.prefKey = prefKey;
    this.follow = true;
    this.touching = false;
    this.segSig = '';
    this.tickSig = '';
    this.ppm = 0;
    this.data = null;
    root.innerHTML = `
      <div class="tl-scroll"><div class="tl-content">
        <div class="tl-pins"></div>
        <div class="tl-track">
          <div class="tl-bar"><div class="tl-segs"></div><div class="tl-seg r-open" data-k="live" hidden></div><div class="tl-lines"></div></div>
          <div class="tl-now" hidden></div>
        </div>
        <div class="tl-ticks"></div>
      </div></div>
      <button class="tl-follow" hidden>現在へ ›</button>`;
    const q = s => root.querySelector(s);
    this.scroll = q('.tl-scroll');
    this.content = q('.tl-content');
    this.segsEl = q('.tl-segs');
    this.linesEl = q('.tl-lines');
    this.pinsEl = q('.tl-pins');
    this.openEl = q('.r-open');
    this.nowEl = q('.tl-now');
    this.ticksEl = q('.tl-ticks');
    this.followBtn = q('.tl-follow');

    this.scroll.addEventListener('click', e => {
      const el = e.target.closest('[data-k]');
      if (el) onPick(el.dataset.k);
    });
    this.scroll.addEventListener('scroll', () => {
      if (!this.data || !this.data.live || this.mode === 'all') return;
      const sc = this.scroll;
      this.follow = sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 6;
      this.followBtn.hidden = this.follow;
    }, { passive: true });
    const down = () => { this.touching = true; };
    const up = () => { this.touching = false; };
    this.scroll.addEventListener('touchstart', down, { passive: true });
    this.scroll.addEventListener('touchend', up);
    this.scroll.addEventListener('touchcancel', up);
    this.scroll.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    this.followBtn.addEventListener('click', () => {
      this.follow = true;
      this.followBtn.hidden = true;
      this.redraw();
    });

    const ctl = document.querySelector(`.seg-ctl[data-for="${prefKey}"]`);
    this.ctl = ctl;
    ctl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      prefs[prefKey] = b.dataset.m;
      savePrefs();
      this.follow = true;
      this.redraw();
    });
  }

  get mode() { return prefs[this.prefKey]; }

  redraw() {
    this.segSig = '';
    this.tickSig = '';
    if (this.data) this.update(this.data);
  }

  // d = { segs, pins, total, live, openStart, sel }
  update(d) {
    this.data = d;
    for (const b of this.ctl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === this.mode);
    const cw = this.scroll.clientWidth - TL_PAD * 2;
    if (cw <= 0) return; // 非表示中
    let ppm;
    let contentW;
    if (this.mode === 'all') {
      ppm = cw / (d.live ? niceSpan(d.total) : Math.max(d.total, 1));
      contentW = cw;
    } else {
      const w = Number(this.mode);
      ppm = cw / w;
      contentW = Math.max(cw, Math.ceil((d.total + (d.live ? w * 0.04 : 0)) * ppm));
    }
    this.ppm = ppm;
    this.content.style.width = `${contentW}px`;
    const px = ms => `${(ms * ppm).toFixed(1)}px`;

    // 区間とピン（変化した時だけ作り直す。タップを取りこぼさないため）
    const segSig = [ppm, d.sel, d.segs.map(g => g.end + rk(g.rating)).join(), d.pins.map(p => p.id + p.t).join()].join('|');
    if (segSig !== this.segSig) {
      this.segSig = segSig;
      this.segsEl.innerHTML = d.segs.map(g =>
        `<div class="tl-seg r-${rk(g.rating)}${d.sel === g.key ? ' sel' : ''}" data-k="${g.key}" style="left:${px(g.start)};width:${px(g.end - g.start)}"></div>`
      ).join('');
      this.linesEl.innerHTML = d.pins.map(p => `<div class="tl-pinline" style="left:${px(p.t)}"></div>`).join('');
      this.pinsEl.innerHTML = d.pins.map(p =>
        `<div class="tl-pin${d.sel === p.key ? ' sel' : ''}" data-k="${p.key}" style="left:${px(p.t)}"></div>`
      ).join('');
      this.openEl.classList.toggle('sel', d.sel === 'live');
    }

    // 目盛り
    const step = tickStep(cw / ppm);
    const nTicks = Math.floor(contentW / ppm / step);
    const tickSig = `${ppm}|${step}|${nTicks}`;
    if (tickSig !== this.tickSig) {
      this.tickSig = tickSig;
      let h = '';
      for (let k = 0; k <= nTicks; k++) h += `<span style="left:${px(k * step)}">${fmtTick(k * step, step)}</span>`;
      this.ticksEl.innerHTML = h;
    }

    // 記録中の区間と現在位置
    this.openEl.hidden = !d.live;
    this.nowEl.hidden = !d.live;
    if (d.live) {
      this.openEl.style.left = px(d.openStart);
      this.openEl.style.width = px(d.total - d.openStart);
      this.nowEl.style.left = px(d.total);
    }

    const scrollable = this.mode !== 'all';
    if (d.live && scrollable && this.follow && !this.touching) {
      this.scroll.scrollLeft = this.scroll.scrollWidth;
    }
    this.followBtn.hidden = !(d.live && scrollable && !this.follow);
  }

  // 指定範囲が見えるようにスクロール
  reveal(start, end) {
    if (this.mode === 'all' || !this.ppm) return;
    const sc = this.scroll;
    const a = start * this.ppm;
    const b = end * this.ppm + TL_PAD * 2;
    if (a >= sc.scrollLeft && b <= sc.scrollLeft + sc.clientWidth) return;
    if (this.data && this.data.live) {
      this.follow = false;
      this.followBtn.hidden = false;
    }
    sc.scrollTo({ left: Math.max(0, a - sc.clientWidth * 0.2), behavior: 'smooth' });
  }
}

function miniBarHTML(segs, total) {
  const pct = x => ((x / total) * 100).toFixed(3);
  return '<div class="mini-bar">' + segs.map(g =>
    `<div class="tl-seg r-${rk(g.rating)}" style="left:${pct(g.start)}%;width:${pct(g.end - g.start)}%"></div>`
  ).join('') + '</div>';
}

/* ===== リスト ===== */
function segRowHTML(g, sel) {
  const k = rk(g.rating);
  return `<li class="seg${sel === g.key ? ' sel' : ''}" data-k="${g.key}">
    <span class="no">#${g.i + 1}</span>
    <span class="range">${fmt(g.start)} – ${fmt(g.end)}</span>
    <span class="len">${fmt(g.end - g.start)}</span>
    <button class="badge r-${k}" data-k="${g.key}">${RATING_TEXT[k]}</button>
    ${g.note ? `<span class="note">${esc(g.note)}</span>` : ''}
  </li>`;
}

function pinRowHTML(p, sel) {
  const text = p.text
    ? `<span class="text">${esc(p.text)}</span>`
    : '<span class="text empty-text">タップしてコメントを入力</span>';
  return `<li class="pin-row${sel === p.key ? ' sel' : ''}" data-k="${p.key}">
    <span class="pin-no">▼${p.n}</span><span class="time">${fmt(p.t)}</span>${text}
  </li>`;
}

// 区間の下に、その区間内のピンをぶら下げて並べる
function groupedRows(segs, pins) {
  return segs.map((g, k) => ({
    seg: g,
    pins: pins.filter(p => p.t >= g.start && (k === segs.length - 1 || p.t < g.end)),
  }));
}

function scrollRowIntoView(listSel, key) {
  const row = document.querySelector(`${listSel} [data-k="${key}"]`);
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ===== 画面切り替え ===== */
function show(name) {
  for (const v of ['home', 'rec', 'detail']) $('#view-' + v).hidden = v !== name;
}

function refresh() {
  if (!$('#view-rec').hidden) renderRec();
  if (!$('#view-detail').hidden) renderDetail();
}

/* ===== ホーム ===== */
function goHome() {
  closeSheet();
  detailId = null;
  show('home');
  renderHome();
}

function renderHome() {
  const list = $('#session-list');
  $('#btn-export-all').disabled = !db.sessions.length;
  if (!db.sessions.length) {
    list.innerHTML = '<li class="empty">まだ記録がありません</li>';
    return;
  }
  list.innerHTML = db.sessions.map(s => {
    const segs = segmentsOf(s);
    const dur = durationOf(s);
    const sum = summarize(segs);
    return `<li class="session-item" data-id="${s.id}" role="button" tabindex="0">
      <div class="row1"><span class="name">${esc(s.name)}</span><span class="dur">${fmt(dur)}</span></div>
      <div class="row2">${fmtDate(s.startedAt)} ${fmtClockTime(s.startedAt)} ・ ${segs.length} 区間 ・ <span class="star">★${sum.star.n}</span> <span class="ok">OK ${sum.ok.n}</span> <span class="ng">NG ${sum.ng.n}</span> ・ <span class="pin">▼${s.pins.length}</span></div>
      ${miniBarHTML(segs, Math.max(dur, 1))}
    </li>`;
  }).join('');
}

/* ===== 記録 ===== */
function startRecording(t0) {
  if (activeSession()) return;
  const s = { id: uid(), name: defaultName(t0), startedAt: t0, endedAt: null, segments: [], pins: [] };
  db.sessions.unshift(s);
  db.activeId = s.id;
  saveDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  feedback('rec');
  enterRec();
  toast('記録スタート', 'rec');
}

function enterRec() {
  recSel = null;
  recTL.follow = true;
  show('rec');
  resetUndo();
  renderRec({ toBottom: true });
  startTicker();
  acquireWake();
}

function addMark(type, t) {
  const s = activeSession();
  if (!s) return;
  if (type === 'pin') { addPin(s, t); return; }
  const rating = type === 'cut' ? null : type;
  const at = t - s.startedAt;
  const prevEnd = lastEnd(s);
  const n = s.segments.length;

  // 区切った直後に別のボタン → 押し間違いとみなして直前区間の判定だけ変える
  if (n && at - prevEnd < FIX_WINDOW_MS) {
    const last = s.segments[n - 1];
    if ((last.rating ?? null) === rating) return;
    last.rating = rating;
    saveDB();
    renderRec({ toBottom: true });
    feedback(type);
    toast(`#${n} を「${RATING_TEXT[rk(rating)]}」に修正`, type);
    return;
  }
  if (at - prevEnd < MIN_SEG_MS) return;

  s.segments.push({ end: at, rating, note: '' });
  saveDB();
  renderRec({ toBottom: true });
  feedback(type);
  toast(`#${n + 1}  ${type === 'cut' ? '区切り' : RATING_TEXT[rating]}  ${fmt(at - prevEnd)}`, type);
}

function addPin(s, t) {
  const at = t - s.startedAt;
  const last = s.pins[s.pins.length - 1];
  if (last && Math.abs(at - last.t) < MIN_PIN_GAP_MS) return;
  s.pins.push({ id: uid(), t: at, text: '' });
  sortPins(s);
  saveDB();
  renderRec({ toBottom: true });
  feedback('pin');
  toast(`▼ピン ${s.pins.length}  ${fmt(at)}（リストをタップでコメント）`, 'pin', 2200);
}

let undoTimer = null;
function onUndo() {
  const s = activeSession();
  if (!s || !s.segments.length) return;
  const btn = $('#btn-undo');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'もう一度タップで取消';
    clearTimeout(undoTimer);
    undoTimer = setTimeout(resetUndo, 3000);
    return;
  }
  resetUndo();
  const n = s.segments.length;
  s.segments.pop();
  saveDB();
  renderRec();
  toast(`#${n} の区切りを取り消しました`);
}

function resetUndo() {
  clearTimeout(undoTimer);
  const btn = $('#btn-undo');
  btn.classList.remove('armed');
  btn.textContent = '直前の区切りを取消';
}

function stopRecording(t) {
  const s = activeSession();
  if (!s) return;
  closeSheet();
  const prevEnd = lastEnd(s);
  const at = Math.max(t - s.startedAt, prevEnd);
  if (at - prevEnd >= MIN_SEG_MS) s.segments.push({ end: at, rating: null, note: '' });
  s.endedAt = s.startedAt + at;
  db.activeId = null;
  saveDB();
  stopTicker();
  releaseWake();
  resetUndo();
  feedback('rec');
  openDetail(s.id);
  toast('記録を停止しました');
}

function renderRec({ toBottom = false } = {}) {
  const s = activeSession();
  if (!s) return;
  $('#rec-name').textContent = s.name;
  const segs = segmentsOf(s);
  const pins = pinsOf(s);
  const le = lastEnd(s);
  $('#seg-count').textContent = segs.length;
  $('#pin-count').textContent = pins.length;

  // 上から下へ時刻順：閉じた区間（それぞれの下にピン）→ 記録中の区間
  const list = $('#rec-list');
  const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  let h = '';
  for (const row of groupedRows(segs, pins.filter(p => p.t < le))) {
    h += segRowHTML(row.seg, recSel) + row.pins.map(p => pinRowHTML(p, recSel)).join('');
  }
  h += `<li class="seg live${recSel === 'live' ? ' sel' : ''}" data-k="live"><span class="no">#${segs.length + 1}</span><span class="range">${fmt(le)} 〜</span><span class="len" id="live-len"></span><span class="badge r-live">記録中</span></li>`;
  h += pins.filter(p => p.t >= le).map(p => pinRowHTML(p, recSel)).join('');
  list.innerHTML = h;
  // 最新（いちばん下）を見ていた時や新しく区切った時は、いちばん下までスクロール
  if (toBottom || wasAtBottom) list.scrollTop = list.scrollHeight;
  $('#btn-undo').disabled = !segs.length;
  lastTlDraw = 0;
  tick();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function tick() {
  const s = activeSession();
  if (!s) { stopTicker(); return; }
  const now = Date.now();
  const el = now - s.startedAt;
  const t = splitTime(el);
  setText('el-hms', `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`);
  setText('el-ds', `.${t.ds}`);
  const cur = fmt(el - lastEnd(s));
  setText('seg-elapsed', cur);
  setText('live-len', cur);
  if (now - lastTlDraw >= 100) {
    lastTlDraw = now;
    recTL.update({ segs: segmentsOf(s), pins: pinsOf(s), total: el, live: true, openStart: lastEnd(s), sel: recSel });
  }
}

function startTicker() {
  stopTicker();
  tickTimer = setInterval(tick, 50);
}

function stopTicker() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// 項目キーから時間範囲を得る
function rangeOfKey(s, key) {
  if (key === 'live') return [lastEnd(s), durationOf(s)];
  if (key[0] === 's') {
    const g = segmentsOf(s)[Number(key.slice(1))];
    return g ? [g.start, g.end] : null;
  }
  const p = s.pins.find(x => 'p' + x.id === key);
  return p ? [p.t, p.t] : null;
}

const pinByKey = (s, key) => s.pins.find(p => 'p' + p.id === key) || null;

/* ===== 詳細・編集 ===== */
function openDetail(id) {
  detailId = id;
  detSel = null;
  show('detail');
  renderDetail();
  $('.detail-scroll').scrollTop = 0;
  detTL.scroll.scrollLeft = 0;
}

function renderDetail() {
  const s = getSession(detailId);
  if (!s) { goHome(); return; }
  const nameEl = $('#d-name');
  if (document.activeElement !== nameEl) nameEl.value = s.name;
  const dur = durationOf(s);
  const segs = segmentsOf(s);
  const pins = pinsOf(s);
  $('#d-meta').textContent = `開始 ${fmtDateTimeMs(s.startedAt)} ・ 長さ ${fmt(dur)} ・ ${segs.length} 区間 ・ ピン ${pins.length}`;
  const sum = summarize(segs);
  $('#d-summary').innerHTML = RATING_KEYS.map(k =>
    `<div class="sum ${k}"><div class="k">${RATING_TEXT[k]}</div><div class="v">${fmt(sum[k].ms)}</div><div class="n">${sum[k].n} 区間</div></div>`
  ).join('');
  detTL.update({ segs, pins, total: Math.max(dur, 1), live: false, sel: detSel });

  let h = '';
  if (segs.length) {
    for (const row of groupedRows(segs, pins)) {
      h += segRowHTML(row.seg, detSel) + row.pins.map(p => pinRowHTML(p, detSel)).join('');
    }
  } else {
    h = pins.map(p => pinRowHTML(p, detSel)).join('') || '<li class="empty">区間がありません</li>';
  }
  $('#d-list').innerHTML = h;
}

function selectDetail(key, { open = false, scrollList = true } = {}) {
  const s = getSession(detailId);
  if (!s) return;
  detSel = key;
  renderDetail();
  const r = rangeOfKey(s, key);
  if (r) detTL.reveal(r[0], r[1]);
  if (scrollList) scrollRowIntoView('#d-list', key);
  if (open) {
    if (key[0] === 's') openSegSheet(s, Number(key.slice(1)));
    else openPinSheet(s, pinByKey(s, key));
  }
}

function selectRec(key, { scrollList = true } = {}) {
  const s = activeSession();
  if (!s) return;
  recSel = key;
  renderRec();
  const r = rangeOfKey(s, key);
  if (r) recTL.reveal(r[0], r[1]);
  if (scrollList) scrollRowIntoView('#rec-list', key);
}

function addPinInDetail() {
  const s = getSession(detailId);
  if (!s) return;
  const r = detSel ? rangeOfKey(s, detSel) : null;
  let t = r ? r[0] : 0;
  if (detSel && detSel[0] === 'p') t += 1000;
  t = Math.min(t, durationOf(s));
  const p = { id: uid(), t, text: '' };
  s.pins.push(p);
  sortPins(s);
  saveDB();
  selectDetail('p' + p.id, { open: true });
  toast('ピンを追加しました。時間とコメントを入力してください', 'pin', 2500);
}

/* ===== 編集シート ===== */
function openSegSheet(s, i) {
  if (!s.segments[i]) return;
  sheet = { sid: s.id, kind: 'seg', ref: s.segments[i] };
  showSheet(s);
}

function openPinSheet(s, pin) {
  if (!pin) return;
  sheet = { sid: s.id, kind: 'pin', ref: pin };
  showSheet(s);
  if (!pin.text) $('#sh-pin-text').focus(); // タップ操作の中で呼ぶとiPhoneでもキーボードが出る
}

function showSheet(s) {
  fillSheet();
  const el = $('#sheet');
  el.classList.toggle('floating', !s.endedAt); // 記録中はマークボタンを押せるよう上部に表示
  el.hidden = false;
}

function fillSheet() {
  const s = sheet && getSession(sheet.sid);
  if (!s) { closeSheet({ apply: false }); return; }
  const isSeg = sheet.kind === 'seg';
  $('.sh-seg').hidden = !isSeg;
  $('.sh-pin').hidden = isSeg;
  if (isSeg) {
    const i = s.segments.indexOf(sheet.ref);
    if (i < 0) { closeSheet({ apply: false }); return; }
    const g = segmentsOf(s)[i];
    $('#sh-title').textContent = `区間 #${i + 1}`;
    $('#sh-range').textContent = `${fmt(g.start)} – ${fmt(g.end)}（${fmt(g.end - g.start)}）`;
    for (const b of $$('#sh-rating button')) b.classList.toggle('on', (b.dataset.r || null) === g.rating);
    $('#sh-note').value = g.note;
    $('#sh-merge').disabled = i >= s.segments.length - 1;
  } else {
    const n = s.pins.indexOf(sheet.ref) + 1;
    if (!n) { closeSheet({ apply: false }); return; }
    $('#sh-title').textContent = `▼ ピン ${n}`;
    $('#sh-range').textContent = fmt(sheet.ref.t);
    if (document.activeElement !== $('#sh-pin-text')) $('#sh-pin-text').value = sheet.ref.text;
    if (document.activeElement !== $('#sh-pin-time')) $('#sh-pin-time').value = fmt(sheet.ref.t);
  }
}

function closeSheet({ apply = true } = {}) {
  if (!sheet) return;
  if (apply && sheet.kind === 'pin') applyPinTime(); // 入力途中の時間も反映してから閉じる
  sheet = null;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $('#sheet').hidden = true;
  refresh();
}

function sheetSession() {
  return sheet ? getSession(sheet.sid) : null;
}

function applyPinTime() {
  const s = sheetSession();
  if (!s || sheet.kind !== 'pin') return;
  const input = $('#sh-pin-time');
  const ms = parseTime(input.value);
  if (ms === null) {
    toast('時間は 1:23.4 のように入力してください', 'warn');
    input.value = fmt(sheet.ref.t);
    return;
  }
  if (input.value.trim() === fmt(sheet.ref.t)) return; // 変更なし（ミリ秒を保つ）
  sheet.ref.t = Math.min(Math.max(0, ms), durationOf(s));
  sortPins(s);
  saveDB();
  input.value = fmt(sheet.ref.t);
  fillSheet();
  refresh();
}

function mergeWithNext() {
  const s = sheetSession();
  if (!s || sheet.kind !== 'seg') return;
  const i = s.segments.indexOf(sheet.ref);
  const a = s.segments[i];
  const b = s.segments[i + 1];
  if (!b) return;
  if (!confirm(`区間 #${i + 1} と #${i + 2} を1つにまとめますか？\n（#${i + 1} の判定が残ります）`)) return;
  a.end = b.end;
  if (b.note) a.note = a.note ? `${a.note} / ${b.note}` : b.note;
  s.segments.splice(i + 1, 1);
  saveDB();
  fillSheet();
  refresh();
  toast('結合しました');
}

function deletePin() {
  const s = sheetSession();
  if (!s || sheet.kind !== 'pin') return;
  const n = s.pins.indexOf(sheet.ref) + 1;
  if (!confirm(`ピン ${n} を削除しますか？`)) return;
  s.pins = s.pins.filter(p => p !== sheet.ref);
  saveDB();
  closeSheet({ apply: false });
  toast('ピンを削除しました');
}

function deleteSession() {
  const s = getSession(detailId);
  if (!s) return;
  if (!confirm(`「${s.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
  db.sessions = db.sessions.filter(x => x.id !== s.id);
  saveDB();
  goHome();
  toast('削除しました');
}

/* ===== CSV ===== */
const CSV_HEADER = ['記録名', '記録開始時刻', '種別', 'No', '判定', '開始', '終了', '長さ', '開始(秒)', '終了(秒)', '長さ(秒)', '開始時刻', '終了時刻', 'コメント'];

// 区間とピンを時刻順に並べる（時刻はすべてミリ秒）
function csvRows(s) {
  const base = [s.name, fmtDateTimeMs(s.startedAt)];
  const at = ms => fmtDateTimeMs(s.startedAt + ms);
  const rows = segmentsOf(s).map(g => ({
    t: g.start, ord: 0,
    cells: [...base, '区間', g.i + 1, RATING_TEXT[rk(g.rating)],
      fmtTC(g.start), fmtTC(g.end), fmtTC(g.end - g.start),
      fmtSec(g.start), fmtSec(g.end), fmtSec(g.end - g.start),
      at(g.start), at(g.end), g.note],
  }));
  s.pins.forEach((p, i) => rows.push({
    t: p.t, ord: 1,
    cells: [...base, 'ピン', i + 1, '', fmtTC(p.t), '', '', fmtSec(p.t), '', '', at(p.t), '', p.text],
  }));
  return rows.sort((a, b) => a.t - b.t || a.ord - b.ord).map(r => r.cells);
}

function toCSV(rows) {
  const cell = v => {
    const t = String(v ?? '');
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  // 先頭の BOM で Excel でも文字化けしない
  return '﻿' + [CSV_HEADER, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const safeName = n => n.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'record';

const csvOf = s => ({ name: `fieldmemo_${safeName(s.name)}.csv`, text: toCSV(csvRows(s)) });

const csvOfAll = () => ({
  name: `fieldmemo_all_${fmtDate(Date.now()).replace(/-/g, '')}.csv`,
  text: toCSV([...db.sessions].reverse().flatMap(csvRows)),
});

function download({ name, text }) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const canShareFiles = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.csv', { type: 'text/csv' })] })); }
  catch (_) { return false; }
})();
const isTouch = matchMedia('(pointer: coarse)').matches;

async function share(file) {
  if (!canShareFiles) { download(file); return; }
  try {
    await navigator.share({ files: [new File([file.text], file.name, { type: 'text/csv' })] });
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast('共有できなかったのでダウンロードします', 'warn');
      download(file);
    }
  }
}

/* ===== 画面ON維持（Wake Lock） ===== */
async function acquireWake() {
  if (!('wakeLock' in navigator)) { setWakeUI(false); return; }
  if (wakeLock || wakeBusy || document.visibilityState !== 'visible' || !activeSession()) return;
  wakeBusy = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      setWakeUI(false);
    });
    wakeLock = lock;
    if (activeSession()) setWakeUI(true);
    else releaseWake();
  } catch (_) {
    setWakeUI(false);
  } finally {
    wakeBusy = false;
  }
}

function releaseWake() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

function setWakeUI(on) {
  const el = $('#wake-status');
  el.dataset.state = on ? 'on' : 'off';
  el.textContent = on ? '画面ON維持中' : '自動ロック注意';
}

/* ===== フィードバック ===== */
let toastTimer = null;
function toast(msg, cls = '', ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function flash(type) {
  const f = $('#flash');
  f.className = `flash ${type}`;
  void f.offsetWidth;
  f.classList.add('go');
}

function feedback(type) {
  flash(type);
  pendingHaptic = true; // 振動は指を離した時（ユーザー操作として扱われるタイミング）に出す
}

// iPhone は navigator.vibrate 非対応のため、iOS 18 以降の switch 型チェックボックスの触覚を利用
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(25); return; }
    const label = document.createElement('label');
    label.ariaHidden = 'true';
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch (_) {}
}

/* ===== 停止スライダー（誤操作防止） ===== */
// 右端までスライドで確定。時刻はつまみに触れた瞬間
function setupSlider(root, onDone) {
  const track = root.querySelector('.stop-track');
  const thumb = root.querySelector('.stop-thumb');
  const label = root.querySelector('.stop-label');
  let drag = null;

  const reset = () => {
    root.classList.add('returning');
    thumb.style.transform = '';
    label.style.opacity = '';
  };

  thumb.addEventListener('pointerdown', e => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    root.classList.remove('returning');
    drag = { id: e.pointerId, x0: e.clientX, t0: Date.now(), max: track.clientWidth - thumb.offsetWidth - 8, dx: 0 };
    try { thumb.setPointerCapture(e.pointerId); } catch (_) {}
  });
  thumb.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = Math.min(drag.max, Math.max(0, e.clientX - drag.x0));
    thumb.style.transform = `translateX(${drag.dx}px)`;
    label.style.opacity = String(1 - drag.dx / drag.max);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx, max, t0 } = drag;
    drag = null;
    if (e.type === 'pointerup' && dx >= max * STOP_SLIDE_RATIO) {
      onDone(t0);
    } else if (e.type === 'pointerup' && dx < 8) {
      toast('右端までスライドすると停止します');
    }
    reset();
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  track.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  thumb.addEventListener('contextmenu', e => e.preventDefault());
}

// 指が触れた瞬間に反応するボタン（離すまで待たない）
function onTouchDown(btn, fn) {
  btn.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    btn.classList.add('pressed');
    fn(Date.now());
  });
  const up = () => btn.classList.remove('pressed');
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('click', e => { if (e.detail === 0) fn(Date.now()); }); // キーボード操作
}

/* ===== イベント ===== */
function bindEvents() {
  recTL = new Timeline($('#rec-timeline'), 'rec', key => selectRec(key));
  detTL = new Timeline($('#d-timeline'), 'detail', key => selectDetail(key));

  onTouchDown($('#btn-start'), startRecording);
  setupSlider($('#stop-slider'), stopRecording);
  for (const btn of $$('.mark')) onTouchDown(btn, t => addMark(btn.dataset.type, t));

  $('#btn-undo').addEventListener('click', onUndo);

  // 記録中のリスト：バッジで判定を切り替え／ピンはコメント入力／区間は選択
  $('#rec-list').addEventListener('click', e => {
    const s = activeSession();
    const item = e.target.closest('[data-k]');
    if (!s || !item) return;
    const key = item.dataset.k;
    if (e.target.closest('.badge') && key[0] === 's') {
      const g = s.segments[Number(key.slice(1))];
      if (!g) return;
      g.rating = CYCLE[rk(g.rating)];
      saveDB();
      selectRec(key, { scrollList: false });
      return;
    }
    selectRec(key, { scrollList: false });
    if (key[0] === 'p') openPinSheet(s, pinByKey(s, key));
  });

  $('#wake-status').addEventListener('click', () => {
    if (wakeLock) toast('記録中は画面が消えないようにしています');
    else toast('画面が消えても時間は正しく記録されます。自動ロックを「なし」にすると安心です', 'warn', 4500);
  });

  // ホーム
  $('#session-list').addEventListener('click', e => {
    const it = e.target.closest('.session-item');
    if (it) openDetail(it.dataset.id);
  });
  $('#btn-export-all').addEventListener('click', () => {
    if (!db.sessions.length) return;
    const file = csvOfAll();
    if (isTouch) share(file);
    else download(file);
  });

  // 詳細
  $('#btn-back').addEventListener('click', goHome);
  $('#btn-delete').addEventListener('click', deleteSession);
  $('#btn-csv').addEventListener('click', () => { const s = getSession(detailId); if (s) download(csvOf(s)); });
  $('#btn-share').hidden = !canShareFiles;
  $('#btn-share').addEventListener('click', () => { const s = getSession(detailId); if (s) share(csvOf(s)); });
  $('#btn-add-pin').addEventListener('click', addPinInDetail);

  const nameEl = $('#d-name');
  nameEl.addEventListener('input', () => {
    const s = getSession(detailId);
    if (!s) return;
    s.name = nameEl.value;
    saveDB();
  });
  nameEl.addEventListener('blur', () => {
    const s = getSession(detailId);
    if (s && !s.name.trim()) {
      s.name = defaultName(s.startedAt);
      saveDB();
      renderDetail();
    }
  });
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') nameEl.blur(); });

  $('#d-list').addEventListener('click', e => {
    const row = e.target.closest('[data-k]');
    if (row) selectDetail(row.dataset.k, { open: true, scrollList: false });
  });

  // 編集シート
  $('#sh-rating').addEventListener('click', e => {
    const b = e.target.closest('button');
    const s = sheetSession();
    if (!b || !s || sheet.kind !== 'seg') return;
    sheet.ref.rating = b.dataset.r || null;
    saveDB();
    fillSheet();
    refresh();
  });
  $('#sh-note').addEventListener('input', e => {
    if (!sheetSession() || sheet.kind !== 'seg') return;
    sheet.ref.note = e.target.value;
    saveDB();
    refresh();
  });
  $('#sh-pin-text').addEventListener('input', e => {
    if (!sheetSession() || sheet.kind !== 'pin') return;
    sheet.ref.text = e.target.value;
    saveDB();
    refresh();
  });
  $('#sh-pin-time').addEventListener('change', applyPinTime);
  for (const id of ['#sh-note', '#sh-pin-text', '#sh-pin-time']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  }
  $('#sh-merge').addEventListener('click', mergeWithNext);
  $('#sh-pin-delete').addEventListener('click', deletePin);
  for (const b of $$('.sh-close')) b.addEventListener('click', closeSheet);
  $('.sheet-backdrop').addEventListener('click', closeSheet);

  // 指を離した時に触覚フィードバック／画面ON維持の再取得
  document.addEventListener('pointerup', () => {
    if (pendingHaptic) {
      pendingHaptic = false;
      haptic();
    }
    if (activeSession() && !wakeLock) acquireWake();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeSession()) {
      acquireWake();
      tick();
    }
  });

  window.addEventListener('resize', () => {
    recTL.redraw();
    detTL.redraw();
  });
}

function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return; // 開発中はキャッシュしない
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function init() {
  bindEvents();
  if (activeSession()) {
    // ページが再読み込みされても、開始時刻から計算し直して記録を続ける
    enterRec();
    toast('記録中のセッションに復帰しました', 'rec', 2500);
  } else {
    if (db.activeId) {
      db.activeId = null;
      saveDB();
    }
    goHome();
  }
  registerSW();
}

init();
