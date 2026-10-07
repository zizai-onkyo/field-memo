'use strict';

/* ===== 設定 ===== */
const START_HOLD_MS = 800;     // スタートに必要な長押し時間
const STOP_SLIDE_RATIO = 0.9;  // 停止スライダーをこの割合以上動かすと停止
const FIX_WINDOW_MS = 1500;    // 区切った直後この時間内に別のボタン → 直前区間の判定を修正
const MIN_SEG_MS = 300;        // これより短い区間は作らない（二度押し対策）
const STORE_KEY = 'fieldmemo.v1';
const PREF_KEY = 'fieldmemo.prefs';

const RATING_TEXT = { ok: 'OK', ng: 'NG', none: '未判定' };
const rk = r => r || 'none';
const CYCLE = { none: 'ok', ok: 'ng', ng: null };

/* ===== 状態 =====
 * session = { id, name, startedAt(epoch ms), endedAt(epoch ms|null), segments: [{ end(ms), rating('ok'|'ng'|null), note }] }
 * 区間 i は segments[i-1].end（先頭は 0）から segments[i].end まで。
 * 記録中は「閉じた区間」だけが segments に入り、最後の区切り〜現在が記録中の区間。
 */
let db = loadDB();
let prefs = loadPrefs();
let detailId = null;
let sheetIndex = null;
let tickTimer = null;
let lastTlDraw = 0;
let wakeLock = null;
let wakeBusy = false;
let pendingHaptic = false;

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

/* ===== 保存 ===== */
function loadDB() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.sessions)) return d;
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
  try { return Object.assign({ tlMode: 'all' }, JSON.parse(localStorage.getItem(PREF_KEY))); }
  catch (_) { return { tlMode: 'all' }; }
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

function segmentsOf(s) {
  let prev = 0;
  return s.segments.map((g, i) => {
    const seg = { i, start: prev, end: g.end, rating: g.rating ?? null, note: g.note || '' };
    prev = g.end;
    return seg;
  });
}

function summarize(segs) {
  const sum = { ok: { n: 0, ms: 0 }, ng: { n: 0, ms: 0 }, none: { n: 0, ms: 0 } };
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

// 一覧用: 1:23.4 / 1:02:03.4
function fmt(ms) {
  const t = splitTime(ms);
  return t.h ? `${t.h}:${pad(t.m)}:${pad(t.s)}.${t.ds}` : `${t.m}:${pad(t.s)}.${t.ds}`;
}

// CSV用: 00:01:23.456
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

function fmtTick(ms, step) {
  if (ms === 0) return '0';
  const t = splitTime(ms);
  if (step < 60000) return `${t.h * 60 + t.m}:${pad(t.s)}`;
  if (t.h) return t.m ? `${t.h}h${pad(t.m)}` : `${t.h}h`;
  return `${t.m}m`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ===== タイムライン ===== */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].map(s => s * 1000);
const SPANS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240].map(m => m * 60000);

const tickStep = span => TICK_STEPS.find(s => span / s <= 5) || 3600000 * Math.ceil(span / 5 / 3600000);
// 記録中の「全体」表示は、目盛りが頻繁に変わらないようキリのいい長さで広げていく
const niceSpan = ms => SPANS.find(s => ms <= s * 0.97) || Math.ceil(ms / 0.97 / 3600000) * 3600000;

function barHTML(segs, a, b, opts = {}) {
  const pct = x => ((x - a) / (b - a)) * 100;
  let h = `<div class="tl-bar${opts.mini ? ' mini' : ''}">`;
  for (const g of segs) {
    if (g.end <= a || g.start >= b) continue;
    const l = Math.max(0, pct(g.start));
    const r = Math.min(100, pct(g.end));
    const cls = g.open ? 'r-open' : `r-${rk(g.rating)}`;
    const sel = opts.sel === g.i ? ' sel' : '';
    h += `<div class="tl-seg ${cls}${sel}" data-i="${g.i}" style="left:${l.toFixed(3)}%;width:${(r - l).toFixed(3)}%"></div>`;
  }
  return h + '</div>';
}

function timelineHTML(segs, a, b, opts = {}) {
  const pct = x => ((x - a) / (b - a)) * 100;
  let h = '<div class="tl-track">' + barHTML(segs, a, b, opts);
  if (opts.now != null) h += `<div class="tl-now" style="left:${pct(opts.now).toFixed(3)}%"></div>`;
  h += '</div><div class="tl-ticks">';
  const step = tickStep(b - a);
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
    h += `<span style="left:${pct(t).toFixed(3)}%">${fmtTick(t, step)}</span>`;
  }
  return h + '</div>';
}

function drawRecTimeline(s, el) {
  const segs = segmentsOf(s);
  segs.push({ i: -1, start: lastEnd(s), end: el, open: true });
  let a, b;
  if (prefs.tlMode === 'all') {
    a = 0;
    b = niceSpan(el);
  } else {
    const w = Number(prefs.tlMode);
    b = Math.max(w, el + w * 0.04);
    a = b - w;
  }
  $('#rec-timeline').innerHTML = timelineHTML(segs, a, b, { now: el });
}

function renderModeCtl() {
  for (const b of $$('#tl-mode button')) b.classList.toggle('on', b.dataset.m === String(prefs.tlMode));
}

/* ===== 画面切り替え ===== */
function show(name) {
  for (const v of ['home', 'rec', 'detail']) $('#view-' + v).hidden = v !== name;
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
      <div class="row2">${fmtDate(s.startedAt)} ${fmtClockTime(s.startedAt)} ・ ${segs.length} 区間 ・ <span class="ok">OK ${sum.ok.n}</span> ・ <span class="ng">NG ${sum.ng.n}</span></div>
      ${barHTML(segs, 0, Math.max(dur, 1), { mini: true })}
    </li>`;
  }).join('');
}

/* ===== 記録 ===== */
function startRecording(t0) {
  if (activeSession()) return;
  const s = { id: uid(), name: defaultName(t0), startedAt: t0, endedAt: null, segments: [] };
  db.sessions.unshift(s);
  db.activeId = s.id;
  saveDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  feedback('rec');
  enterRec();
  toast('記録スタート', 'rec');
}

function enterRec() {
  show('rec');
  resetUndo();
  renderRec();
  startTicker();
  acquireWake();
}

function addMark(type, t) {
  const s = activeSession();
  if (!s) return;
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
    renderRec();
    feedback(type);
    toast(`#${n} を「${RATING_TEXT[rk(rating)]}」に修正`, type);
    return;
  }
  if (at - prevEnd < MIN_SEG_MS) return;

  s.segments.push({ end: at, rating, note: '' });
  saveDB();
  renderRec();
  feedback(type);
  toast(`#${n + 1}  ${type === 'cut' ? '区切り' : RATING_TEXT[rating]}  ${fmt(at - prevEnd)}`, type);
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

function renderRec() {
  const s = activeSession();
  if (!s) return;
  $('#rec-name').textContent = s.name;
  const segs = segmentsOf(s);
  $('#seg-count').textContent = segs.length;
  let h = `<li class="seg live"><span class="no">#${segs.length + 1}</span><span class="range">${fmt(lastEnd(s))} 〜</span><span class="len" id="live-len"></span><span class="badge r-live">記録中</span></li>`;
  for (let k = segs.length - 1; k >= 0; k--) h += segRowHTML(segs[k]);
  $('#rec-list').innerHTML = h;
  $('#btn-undo').disabled = !segs.length;
  renderModeCtl();
  lastTlDraw = 0;
  tick();
}

function segRowHTML(g, opts = {}) {
  const k = rk(g.rating);
  return `<li class="seg${opts.sel ? ' sel' : ''}" data-i="${g.i}">
    <span class="no">#${g.i + 1}</span>
    <span class="range">${fmt(g.start)} – ${fmt(g.end)}</span>
    <span class="len">${fmt(g.end - g.start)}</span>
    <button class="badge r-${k}" data-i="${g.i}">${RATING_TEXT[k]}</button>
    ${g.note ? `<span class="note">${esc(g.note)}</span>` : ''}
  </li>`;
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
    drawRecTimeline(s, el);
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

/* ===== 詳細・編集 ===== */
function openDetail(id) {
  detailId = id;
  sheetIndex = null;
  show('detail');
  renderDetail();
  $('.detail-scroll').scrollTop = 0;
}

function renderDetail() {
  const s = getSession(detailId);
  if (!s) { goHome(); return; }
  const nameEl = $('#d-name');
  if (document.activeElement !== nameEl) nameEl.value = s.name;
  const dur = durationOf(s);
  const segs = segmentsOf(s);
  $('#d-meta').textContent = `${fmtDate(s.startedAt)} ${fmtClockTime(s.startedAt)} 開始 ・ 長さ ${fmt(dur)} ・ ${segs.length} 区間`;
  const sum = summarize(segs);
  $('#d-summary').innerHTML = ['ok', 'ng', 'none'].map(k =>
    `<div class="sum ${k}"><div class="k">${RATING_TEXT[k]}</div><div class="v">${fmt(sum[k].ms)}</div><div class="n">${sum[k].n} 区間</div></div>`
  ).join('');
  $('#d-timeline').innerHTML = timelineHTML(segs, 0, Math.max(dur, 1), { sel: sheetIndex });
  $('#d-list').innerHTML = segs.length
    ? segs.map(g => segRowHTML(g, { sel: g.i === sheetIndex })).join('')
    : '<li class="empty">区間がありません</li>';
}

function openSheet(i) {
  const s = getSession(detailId);
  if (!s || !s.segments[i]) return;
  sheetIndex = i;
  fillSheet();
  $('#sheet').hidden = false;
  renderDetail();
}

function fillSheet() {
  const s = getSession(detailId);
  const segs = segmentsOf(s);
  const g = segs[sheetIndex];
  $('#sh-title').textContent = `区間 #${g.i + 1}`;
  $('#sh-range').textContent = `${fmt(g.start)} – ${fmt(g.end)}（${fmt(g.end - g.start)}）`;
  for (const b of $$('#sh-rating button')) b.classList.toggle('on', (b.dataset.r || null) === g.rating);
  $('#sh-note').value = g.note;
  $('#sh-merge').disabled = sheetIndex >= segs.length - 1;
}

function closeSheet() {
  if (sheetIndex === null) return;
  sheetIndex = null;
  $('#sh-note').blur();
  $('#sheet').hidden = true;
  if (detailId) renderDetail();
}

function mergeWithNext() {
  const s = getSession(detailId);
  const i = sheetIndex;
  const a = s.segments[i];
  const b = s.segments[i + 1];
  if (!b) return;
  if (!confirm(`区間 #${i + 1} と #${i + 2} を1つにまとめますか？\n（#${i + 1} の判定が残ります）`)) return;
  a.end = b.end;
  if (b.note) a.note = a.note ? `${a.note} / ${b.note}` : b.note;
  s.segments.splice(i + 1, 1);
  saveDB();
  fillSheet();
  renderDetail();
  toast('結合しました');
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
const CSV_HEADER = ['記録名', '区間', '判定', '開始', '終了', '長さ', '開始(秒)', '終了(秒)', '長さ(秒)', '開始時刻', '終了時刻', 'メモ'];

function csvRows(s) {
  return segmentsOf(s).map(g => [
    s.name, g.i + 1, RATING_TEXT[rk(g.rating)],
    fmtTC(g.start), fmtTC(g.end), fmtTC(g.end - g.start),
    fmtSec(g.start), fmtSec(g.end), fmtSec(g.end - g.start),
    defaultName(s.startedAt + g.start), defaultName(s.startedAt + g.end),
    g.note,
  ]);
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

/* ===== 誤操作しにくいボタン ===== */
// 長押しで確定。時刻は「指が触れた瞬間」を使う（レコーダーと同時押しで揃うように）
function setupHold(btn, ms, onDone) {
  let timer = null;
  let t0 = 0;
  btn.style.setProperty('--hold-ms', `${ms}ms`);
  btn.addEventListener('pointerdown', e => {
    if (timer || (e.pointerType === 'mouse' && e.button !== 0)) return;
    t0 = Date.now();
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    btn.classList.add('holding');
    timer = setTimeout(() => {
      timer = null;
      btn.classList.remove('holding');
      onDone(t0);
    }, ms);
  });
  const cancel = e => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
    if (e.type === 'pointerup') toast('リングが一周するまで押し続けてください');
  };
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

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

/* ===== イベント ===== */
function bindEvents() {
  setupHold($('#btn-start'), START_HOLD_MS, startRecording);
  setupSlider($('#stop-slider'), stopRecording);

  // マークは指が触れた瞬間に記録（離すまで待たない）
  for (const btn of $$('.mark')) {
    const up = () => btn.classList.remove('pressed');
    btn.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      btn.classList.add('pressed');
      addMark(btn.dataset.type, Date.now());
    });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', e => { if (e.detail === 0) addMark(btn.dataset.type, Date.now()); }); // キーボード操作
  }

  $('#btn-undo').addEventListener('click', onUndo);

  // 記録中のリスト: 判定バッジをタップで OK → NG → 未判定 と切り替え
  $('#rec-list').addEventListener('click', e => {
    const b = e.target.closest('.badge[data-i]');
    const s = activeSession();
    if (!b || !s) return;
    const g = s.segments[Number(b.dataset.i)];
    if (!g) return;
    g.rating = CYCLE[rk(g.rating)];
    saveDB();
    renderRec();
  });

  $('#tl-mode').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.tlMode = b.dataset.m;
    savePrefs();
    renderModeCtl();
    lastTlDraw = 0;
    tick();
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
    const row = e.target.closest('[data-i]');
    if (row) openSheet(Number(row.dataset.i));
  });
  $('#d-timeline').addEventListener('click', e => {
    const seg = e.target.closest('.tl-seg[data-i]');
    if (seg) openSheet(Number(seg.dataset.i));
  });

  // 区間編集シート
  $('#sh-rating').addEventListener('click', e => {
    const b = e.target.closest('button');
    const s = getSession(detailId);
    if (!b || !s || sheetIndex === null) return;
    s.segments[sheetIndex].rating = b.dataset.r || null;
    saveDB();
    fillSheet();
    renderDetail();
  });
  $('#sh-note').addEventListener('input', e => {
    const s = getSession(detailId);
    if (!s || sheetIndex === null) return;
    s.segments[sheetIndex].note = e.target.value;
    saveDB();
    renderDetail();
  });
  $('#sh-note').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('#sh-merge').addEventListener('click', mergeWithNext);
  $('#sh-close').addEventListener('click', closeSheet);
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
