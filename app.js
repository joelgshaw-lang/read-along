/* Read Along: an offline read-and-listen reader for .kbook files.
   Books, audio, highlights and reading positions are stored on the device only. */
'use strict';

const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4];
const SLEEP = [['Off', 0], ['10 min', 10], ['15 min', 15], ['30 min', 30], ['45 min', 45], ['60 min', 60], ['End of chapter', -1]];

let book = null;          // current book's text + timings
let paraEls = [];         // paragraph elements, same order as book.paras
let cur = -1;             // paragraph being read
let follow = true;        // keep the reading paragraph in view
let sleep = { mode: 0, at: 0, chapterEnd: 0 };
let pending = null;       // position to jump to once the audio has loaded (iPhones load on first play)

/* ---------------------------------------------------------------- storage */

const db = new Promise((ok, fail) => {
  const req = indexedDB.open('readalong', 1);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore('books', { keyPath: 'id' });
    d.createObjectStore('audio');
    const h = d.createObjectStore('highlights', { keyPath: 'id' });
    h.createIndex('book', 'book');
  };
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fail(req.error);
});

async function tx(store, mode, fn) {
  const d = await db;
  return new Promise((ok, fail) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined);
    t.onerror = () => fail(t.error);
  });
}
const put = (store, val, key) => tx(store, 'readwrite', (s) => s.put(val, key));
const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const byBook = (id) => tx('highlights', 'readonly', (s) => s.index('book').getAll(id));

const pref = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------------------------------------------------------------- helpers */

const pos = () => (pending !== null ? pending : audio.currentTime);
function setPos(t) {
  if (audio.readyState >= 1) { audio.currentTime = t; pending = null; } else pending = t;
}
audio.addEventListener('loadedmetadata', () => {
  if (pending !== null) { audio.currentTime = pending; pending = null; }
  if (book) onTime(true);
});

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
function busy(msg) { const b = $('#busy'); b.textContent = msg || ''; b.classList.toggle('hidden', !msg); }

// Index of the last item whose start time is <= t.
function findAt(list, t, key) {
  let lo = 0, hi = list.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][key] <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
const chapterAt = (t) => findAt(book.chapters, t, 'start');
const chapterEnd = (ci) => (ci + 1 < book.chapters.length ? book.chapters[ci + 1].start : audio.duration || Infinity);

/* ---------------------------------------------------------------- library */

async function showLibrary() {
  closeSheet();
  if (book) { savePos(); audio.pause(); }
  $('#reader').classList.add('hidden');
  $('#library').classList.remove('hidden');
  document.title = 'Read Along';
  const books = (await all('books')).sort((a, b) => (pref.get('opened:' + b.id, 0) - pref.get('opened:' + a.id, 0)));
  const list = $('#books');
  if (!books.length) {
    list.innerHTML = `<div class="empty">No books yet.<br>Tap <b>Add a book</b> and choose a <b>.kbook</b> file from Files.</div>`;
  } else {
    list.innerHTML = books.map((b) => {
      const pos = pref.get('pos:' + b.id, 0), pct = b.duration ? Math.min(100, Math.round(pos / b.duration * 100)) : 0;
      return `<button class="book" data-id="${b.id}">
        <div class="cover">${esc((b.title || '?')[0])}</div>
        <div class="meta"><b>${esc(b.title)}</b><span>${esc(b.author || '')}${b.duration ? ' · ' + fmt(b.duration) : ''}</span>
        <div class="bar"><i style="width:${pct}%"></i></div></div></button>`;
    }).join('');
  }
  list.querySelectorAll('.book').forEach((el) => {
    el.onclick = () => openBook(el.dataset.id);
    el.oncontextmenu = (e) => { e.preventDefault(); removeBook(el.dataset.id); };
  });
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0 } = await navigator.storage.estimate();
    $('#storage').textContent = books.length ? `Using ${(usage / 1e6).toFixed(0)} MB on this phone. Press and hold a book to remove it.` : '';
  }
}

async function removeBook(id) {
  const b = await get('books', id);
  if (!b || !confirm(`Remove "${b.title}" from this phone? Your highlights for it will be removed too.`)) return;
  await del('books', id); await del('audio', id);
  for (const h of await byBook(id)) await del('highlights', h.id);
  showLibrary();
}

async function importFile(file) {
  try {
    busy('Adding book…');
    const head = new DataView(await file.slice(0, 15).arrayBuffer());
    const magic = new TextDecoder().decode(new Uint8Array(head.buffer, 0, 7));
    if (magic !== 'KBOOK1\n') throw new Error('That isn\'t a .kbook file.');
    const len = Number(head.getBigUint64(7));
    const meta = JSON.parse(await file.slice(15, 15 + len).text());
    const blob = file.slice(15 + len, file.size, 'audio/mp4');
    meta.duration = (await audioDuration(blob)) || (meta.paras.length ? meta.paras[meta.paras.length - 1].s + 30 : 0);
    meta.added = Date.now();
    await put('audio', blob, meta.id);
    await put('books', meta);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    busy();
    toast(`Added "${meta.title}"`);
    showLibrary();
  } catch (e) {
    busy();
    alert('Couldn\'t add that book: ' + e.message);
  }
}

function audioDuration(blob) {
  return new Promise((ok) => {
    const a = new Audio(); const url = URL.createObjectURL(blob);
    a.preload = 'metadata'; a.src = url;
    a.onloadedmetadata = () => { ok(a.duration); URL.revokeObjectURL(url); };
    a.onerror = () => ok(0);
    setTimeout(() => ok(0), 4000);   // iPhones may not load audio until play is pressed
  });
}

/* ---------------------------------------------------------------- reader */

async function openBook(id) {
  busy('Opening…');
  book = await get('books', id);
  const blob = await get('audio', id);
  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = URL.createObjectURL(blob);
  audio.playbackRate = pref.get('speed', 1); audio.preservesPitch = true;
  pref.set('opened:' + id, Date.now());
  $('#bookTitle').textContent = book.title;
  document.title = book.title;
  renderText();
  await renderMarks();
  $('#library').classList.add('hidden');
  $('#reader').classList.remove('hidden');
  updateSpeed();
  pending = null;
  setPos(pref.get('pos:' + id, 0));
  follow = true;
  onTime(true);
  busy();
  setupMediaSession();
}

function renderText() {
  const text = $('#text');
  text.innerHTML = book.paras.map((p, i) =>
    p.h ? `<h2 data-i="${i}">${esc(p.t)}</h2>` : `<p data-i="${i}">${esc(p.t)}</p>`).join('');
  paraEls = [...text.children];
  cur = -1;
}

async function renderMarks() {
  const hls = await byBook(book.id);
  const byPara = {};
  hls.forEach((h) => (byPara[h.para] = byPara[h.para] || []).push(h));
  paraEls.forEach((el, i) => {
    const list = byPara[i];
    let html = esc(book.paras[i].t);
    if (list) {
      for (const h of list) {
        const q = esc(h.quote);
        const at = html.indexOf(q);
        if (at >= 0) html = html.slice(0, at) + `<mark data-h="${h.id}" class="${h.note ? 'note' : ''}">${q}</mark>` + html.slice(at + q.length);
      }
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  });
}

function setCurrent(i) {
  if (i === cur) return;
  if (paraEls[cur]) paraEls[cur].classList.remove('now');
  cur = i;
  const el = paraEls[i];
  if (!el) return;
  el.classList.add('now');
  if (follow && !$('#reader').classList.contains('hidden')) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

let lastSave = 0, lastChapter = -1;
function onTime(force) {
  if (!book) return;
  const t = pos();
  setCurrent(findAt(book.paras, t, 's'));
  const ci = chapterAt(t);
  const start = book.chapters[ci].start, end = chapterEnd(ci);
  if (ci !== lastChapter || force) {
    lastChapter = ci;
    $('#chapTitle').textContent = book.chapters[ci].title;
    updateMediaMeta();
  }
  if (!seeking) $('#seek').value = Math.round(((t - start) / Math.max(1, end - start)) * 1000);
  $('#tNow').textContent = fmt(t - start);
  $('#tLeft').textContent = `-${fmt((end - t) / audio.playbackRate)} in chapter`;
  if (Date.now() - lastSave > 4000 || force) savePos();
  checkSleep(t);
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && audio.duration) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(t, audio.duration), playbackRate: audio.playbackRate }); } catch {}
  }
}
function savePos() { if (book && (audio.readyState >= 1 || pending !== null)) { pref.set('pos:' + book.id, pos()); lastSave = Date.now(); } }

function seekTo(t, play) {
  setPos(Math.max(0, Math.min(t, (audio.duration || book.duration || t) - 0.1)));
  follow = true; $('#followBtn').classList.add('hidden');
  onTime(true);
  if (play) audio.play();
}

/* ---------------------------------------------------------------- player controls */

function togglePlay() { audio.paused ? audio.play() : audio.pause(); }
function updatePlayIcon() {
  $('#playIcon').setAttribute('href', audio.paused ? '#i-play' : '#i-pause');
  $('#playBtn').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
}
function updateSpeed() { $('#speedBtn').textContent = audio.playbackRate + '×'; }

let seeking = false;
$('#seek').addEventListener('input', () => {
  seeking = true;
  const ci = chapterAt(pos()), start = book.chapters[ci].start, end = chapterEnd(ci);
  $('#tNow').textContent = fmt(($('#seek').value / 1000) * (end - start));
});
$('#seek').addEventListener('change', () => {
  const ci = chapterAt(pos()), start = book.chapters[ci].start, end = chapterEnd(ci);
  seeking = false;
  seekTo(start + ($('#seek').value / 1000) * (end - start));
});

$('#playBtn').onclick = () => { unlockChime(); togglePlay(); };
$('#b15').onclick = () => seekTo(pos() - 15);
$('#f15').onclick = () => seekTo(pos() + 15);
function setSpeed(r) {
  r = Math.round(Math.max(0.5, Math.min(4, r)) * 100) / 100;
  audio.playbackRate = r; audio.preservesPitch = true; audio.webkitPreservesPitch = true;
  pref.set('speed', r); updateSpeed(); onTime(true);
}
$('#speedBtn').onclick = function speedSheet() {
  const r = audio.playbackRate;
  openSheet(`<h3>Speed <span style="font-variant-numeric:tabular-nums">${r}×</span></h3>
    <div class="setrow"><span>Fine tune</span><div class="stepper"><button data-d="-0.1">−0.1</button><button data-d="0.1">+0.1</button></div></div>
    <div class="chips" style="margin-top:14px">${SPEEDS.map((v) => `<button class="chip ${v === r ? 'on' : ''}" data-v="${v}">${v}×</button>`).join('')}</div>`,
  (s) => {
    s.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { setSpeed(+b.dataset.v); closeSheet(); }));
    s.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { setSpeed(audio.playbackRate + +b.dataset.d); speedSheet(); }));
  });
};
audio.addEventListener('timeupdate', () => onTime(false));
audio.addEventListener('play', () => { updatePlayIcon(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayIcon(); savePos(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });

// Tap a paragraph to listen from there (but not while selecting text).
$('#text').addEventListener('click', (e) => {
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const mark = e.target.closest('mark');
  if (mark) return showHighlight(mark.dataset.h);
  const el = e.target.closest('[data-i]');
  if (el) seekTo(book.paras[+el.dataset.i].s, true);
});

// Scrolling by hand (finger or trackpad) stops the page following the voice until you ask.
function handScroll() {
  if ($('#reader').classList.contains('hidden') || !follow) return;
  follow = false;
  $('#followBtn').classList.remove('hidden');
}
window.addEventListener('touchmove', handScroll, { passive: true });
window.addEventListener('wheel', handScroll, { passive: true });
$('#followBtn').onclick = () => {
  follow = true; $('#followBtn').classList.add('hidden');
  const el = paraEls[cur]; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
};

/* ---------------------------------------------------------------- sleep timer */

function setSleep(mins) {
  sleep.mode = mins;
  sleep.at = mins > 0 ? Date.now() + mins * 60000 : 0;
  sleep.chapterEnd = mins === -1 ? chapterEnd(chapterAt(pos())) : 0;
  $('#sleepBtn').classList.toggle('on', mins !== 0);
  $('#sleepBtn').innerHTML = `<svg class="icon"><use href="#i-moon"/></svg>` + (mins ? `<small>${mins === -1 ? 'ch.' : mins + 'm'}</small>` : '');
  toast(mins === 0 ? 'Sleep timer off' : mins === -1 ? 'Stopping at the end of this chapter' : `Stopping in ${mins} minutes`);
}
function checkSleep(t) {
  if (!sleep.mode || audio.paused) return;
  if ((sleep.at && Date.now() >= sleep.at) || (sleep.chapterEnd && t >= sleep.chapterEnd - 0.4)) {
    audio.pause(); setSleep(0); toast('Sleep timer: paused');
  }
}
setInterval(() => book && checkSleep(pos()), 1000);
$('#sleepBtn').onclick = () => openSheet(`<h3>Sleep timer</h3><div class="chips">${SLEEP.map(([l, m]) =>
  `<button class="chip ${sleep.mode === m ? 'on' : ''}" data-m="${m}">${l}</button>`).join('')}</div>
  <p class="tip">Backup for long nights: in the Clock app, set a Timer and choose <b>When Timer Ends → Stop Playing</b>.</p>`,
  (s) => s.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { setSleep(+c.dataset.m); closeSheet(); })));

/* ---------------------------------------------------------------- highlights */

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function addHighlight(para, quote, note, source) {
  const h = { id: newId(), book: book.id, para, quote: quote.trim(), note: note || '', time: book.paras[para].s,
              chapter: book.chapters[chapterAt(book.paras[para].s)].title, created: Date.now(), source };
  await put('highlights', h);
  await renderMarks();
  return h;
}

// AirPods double-press: keep the paragraph you were just listening to.
async function captureHeard() {
  if (!book) return;
  const t = pos();
  let i = findAt(book.paras, t, 's');
  if (t - book.paras[i].s < 4 && i > 0) i -= 1;   // only just started this one? keep the last
  if (book.paras[i].h && i + 1 < book.paras.length) i += 1;
  const existing = (await byBook(book.id)).find((h) => h.para === i && h.quote === book.paras[i].t.trim());
  if (!existing) await addHighlight(i, book.paras[i].t, '', 'airpods');
  chime();
  toast('Highlight saved');
}

// Selection toolbar
let selInfo = null;
document.addEventListener('selectionchange', () => {
  const sel = getSelection(), bar = $('#selbar');
  if (!book || !sel || sel.isCollapsed || !sel.rangeCount) { bar.classList.add('hidden'); selInfo = null; return; }
  const range = sel.getRangeAt(0);
  const el = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('[data-i]');
  if (!el || !$('#text').contains(el)) { bar.classList.add('hidden'); return; }
  selInfo = { para: +el.dataset.i, quote: sel.toString() };
  const r = range.getBoundingClientRect();
  bar.classList.remove('hidden');
  const top = r.bottom + 12 + 52 < innerHeight - 160 ? r.bottom + 12 : Math.max(70, r.top - 60);
  bar.style.top = top + 'px';
  bar.style.left = Math.max(10, Math.min(innerWidth - bar.offsetWidth - 10, r.left + r.width / 2 - bar.offsetWidth / 2)) + 'px';
});
async function saveSelection(withNote) {
  if (!selInfo) return;
  const { para } = selInfo;
  // Highlights stay within one paragraph so they can be found again.
  const quote = book.paras[para].t.includes(selInfo.quote.trim()) ? selInfo.quote : book.paras[para].t;
  const note = withNote ? prompt('Note (add #tags if you like)') : '';
  if (withNote && note === null) return;
  getSelection().removeAllRanges();
  $('#selbar').classList.add('hidden');
  await addHighlight(para, quote, note, 'select');
  toast(withNote ? 'Note saved' : 'Highlighted');
}
$('#selHl').addEventListener('pointerdown', (e) => { e.preventDefault(); saveSelection(false); });
$('#selNote').addEventListener('pointerdown', (e) => { e.preventDefault(); saveSelection(true); });

function hlHTML(h) {
  return `<div class="hl" data-h="${h.id}"><q>${esc(h.quote)}</q>
    ${h.note ? `<div class="n">${esc(h.note)}</div>` : ''}
    <div class="when">${esc(h.chapter || '')} · ${fmt(h.time)}${h.source === 'airpods' ? ' · from AirPods' : ''}</div>
    <div class="acts"><button data-a="go">Listen</button><button data-a="note">${h.note ? 'Edit note' : 'Add note'}</button><button data-a="del" class="del">Delete</button></div></div>`;
}
function wireHl(root) {
  root.querySelectorAll('.hl').forEach((el) => {
    el.querySelectorAll('button').forEach((b) => (b.onclick = async () => {
      const h = await get('highlights', el.dataset.h);
      if (b.dataset.a === 'go') { closeSheet(); seekTo(h.time, true); }
      if (b.dataset.a === 'note') {
        const n = prompt('Note (add #tags if you like)', h.note || '');
        if (n !== null) { h.note = n; await put('highlights', h); await renderMarks(); reopen(); }
      }
      if (b.dataset.a === 'del' && confirm('Delete this highlight?')) { await del('highlights', h.id); await renderMarks(); reopen(); }
    }));
  });
}
let reopen = () => {};
async function showHighlight(id) {
  const h = await get('highlights', id);
  reopen = () => closeSheet();
  openSheet(`<h3>Highlight</h3>${hlHTML(h)}`, wireHl);
}
async function showHighlights(tag) {
  const hls = (await byBook(book.id)).sort((a, b) => a.time - b.time);
  const tags = [...new Set(hls.flatMap((h) => (h.note.match(/#[\w-]+/g) || []).map((t) => t.toLowerCase())))];
  const shown = tag ? hls.filter((h) => h.note.toLowerCase().includes(tag)) : hls;
  reopen = () => showHighlights(tag);
  openSheet(`<h3>Highlights <button id="exportBtn">Export</button></h3>
    ${tags.length ? `<div class="chips"><button class="chip ${!tag ? 'on' : ''}" data-t="">All</button>${tags.map((t) =>
      `<button class="chip ${tag === t ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div>` : ''}
    ${shown.length ? shown.map(hlHTML).join('') : `<p class="tip">No highlights yet. Select text and tap <b>Highlight</b>, or double-press your AirPods while listening to keep what you just heard.</p>`}`,
  (s) => {
    wireHl(s);
    s.querySelectorAll('.chip').forEach((c) => (c.onclick = () => showHighlights(c.dataset.t)));
    s.querySelector('#exportBtn').onclick = () => exportHighlights(shown);
  });
}
async function exportHighlights(list) {
  if (!list.length) return toast('No highlights to export');
  let md = `# ${book.title}\n${book.author ? '_' + book.author + '_\n' : ''}\nHighlights\n`;
  let chap = '';
  for (const h of list) {
    if (h.chapter !== chap) { chap = h.chapter; md += `\n## ${chap}\n`; }
    md += `\n> ${h.quote}\n`;
    if (h.note) md += `\n${h.note}\n`;
  }
  try {
    if (navigator.share) await navigator.share({ title: `${book.title}: highlights`, text: md });
    else { await navigator.clipboard.writeText(md); toast('Copied to clipboard'); }
  } catch (e) { if (e.name !== 'AbortError') { await navigator.clipboard.writeText(md); toast('Copied to clipboard'); } }
}

// A soft two-note chime so you know an AirPods highlight was kept.
let actx = null;
function unlockChime() {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
}
function chime() {
  try {
    unlockChime();
    const now = actx.currentTime;
    [880, 1320].forEach((f, k) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0, now + k * 0.12);
      g.gain.linearRampToValueAtTime(0.18, now + k * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + k * 0.12 + 0.35);
      o.connect(g).connect(actx.destination); o.start(now + k * 0.12); o.stop(now + k * 0.12 + 0.4);
    });
  } catch {}
}

/* ---------------------------------------------------------------- lock screen + AirPods */

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => audio.play());
  set('pause', () => audio.pause());
  set('nexttrack', () => captureHeard());                          // AirPods double-press
  set('previoustrack', () => seekTo(pos() - 15));       // AirPods triple-press
  set('seekforward', null);   // keep next/previous (not skip buttons) so the AirPods presses reach us
  set('seekbackward', null);
  set('seekto', (d) => seekTo(d.seekTime));
  updateMediaMeta();
}
function updateMediaMeta() {
  if (!('mediaSession' in navigator) || !book) return;
  const ci = chapterAt(pos());
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.chapters[ci].title, artist: book.title, album: book.author || 'Read Along',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}

/* ---------------------------------------------------------------- sheets: contents + settings */

function openSheet(html, wire) {
  const s = $('#sheet');
  s.innerHTML = `<div class="grab"></div>` + html;
  s.classList.remove('hidden'); $('#scrim').classList.remove('hidden');
  if (wire) wire(s);
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#scrim').classList.add('hidden'); }
$('#scrim').onclick = closeSheet;

$('#tocBtn').onclick = () => {
  const ci = chapterAt(pos());
  openSheet(`<h3>Contents</h3>${book.chapters.map((c, i) =>
    `<button class="item ${i === ci ? 'cur' : ''}" data-c="${i}">${esc(c.title)}<small>${fmt(c.start)}</small></button>`).join('')}`,
  (s) => {
    s.querySelectorAll('.item').forEach((b) => (b.onclick = () => { closeSheet(); seekTo(book.chapters[+b.dataset.c].start); }));
    const c = s.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
  });
};
$('#hlBtn').onclick = () => showHighlights('');

function applyLook() {
  document.documentElement.style.setProperty('--text-size', pref.get('size', 19) + 'px');
  const th = pref.get('theme', 'auto');
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
}
$('#setBtn').onclick = function settings() {
  const th = pref.get('theme', 'auto');
  openSheet(`<h3>Text</h3>
    <div class="setrow"><span>Text size</span><div class="stepper"><button data-s="-1">A−</button><button data-s="1">A+</button></div></div>
    <div class="setrow"><span>Look</span></div>
    <div class="chips">${[['auto', 'Match phone'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']].map(([k, l]) =>
      `<button class="chip ${th === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <p class="tip"><b>AirPods:</b> press once to play or pause. <b>Double-press</b> to keep what you just heard as a highlight. <b>Triple-press</b> to go back 15 seconds.</p>`,
  (s) => {
    s.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      pref.set('size', Math.max(14, Math.min(30, pref.get('size', 19) + +b.dataset.s))); applyLook();
    }));
    s.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { pref.set('theme', b.dataset.t); applyLook(); settings(); }));
  });
};

/* ---------------------------------------------------------------- start */

$('#backBtn').onclick = showLibrary;
$('#addBtn').onclick = () => $('#file').click();
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
applyLook();
showLibrary();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
