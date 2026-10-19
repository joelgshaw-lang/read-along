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
const wordBox = $('#wordbox');
let wordPara = -1, wordIdx = -1, wordRanges = [];

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
  for (let k = 0; k < (b.chunks || 0); k++) await del('audio', id + ':' + k);
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
    // Copy the audio into the phone's storage in pieces. Saving the picked file directly
    // only keeps a link to a temporary copy that iOS deletes once the app closes.
    const start = 15 + len, CHUNK = 8 * 1024 * 1024;
    meta.chunks = Math.ceil((file.size - start) / CHUNK);
    for (let k = 0; k < meta.chunks; k++) {
      busy(`Adding book… ${Math.round(k / meta.chunks * 100)}%`);
      const bytes = await file.slice(start + k * CHUNK, Math.min(file.size, start + (k + 1) * CHUNK)).arrayBuffer();
      await put('audio', new Blob([bytes]), meta.id + ':' + k);
    }
    const blob = await loadAudio(meta);
    meta.duration = (await audioDuration(blob)) || (meta.paras.length ? meta.paras[meta.paras.length - 1].s + 30 : 0);
    meta.added = Date.now();
    await del('audio', meta.id);   // an older copy saved the broken way
    await put('books', meta);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    busy();
    toast(`Added "${meta.title}"`);
    showLibrary();
  } catch (e) {
    busy();
    alert('Couldn\'t add that book: ' + ((e && e.message) || 'the phone may be out of space.'));
  }
}

async function loadAudio(b) {
  if (!b.chunks) return get('audio', b.id);   // added before the fix: may no longer play
  const parts = [];
  for (let k = 0; k < b.chunks; k++) parts.push(await get('audio', b.id + ':' + k));
  return parts.includes(undefined) ? null : new Blob(parts, { type: 'audio/mp4' });
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
  const blob = await loadAudio(book);
  if (audio.src) URL.revokeObjectURL(audio.src);
  if (blob) audio.src = URL.createObjectURL(blob); else audio.removeAttribute('src');
  if (!book.chunks) needsReAdd();
  audio.playbackRate = pref.get('speed', 1); audio.preservesPitch = true;
  pref.set('opened:' + id, Date.now());
  pref.set('last', id);
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
  setCurrent(findAt(book.paras, pos(), 's'), true);   // jump straight to where you were
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
  wordIdx = -1; wordPara = -1; updateWord();
}

function setCurrent(i, instant) {
  if (i === cur) return;
  hideWord();
  if (paraEls[cur]) paraEls[cur].classList.remove('now');
  cur = i;
  const el = paraEls[i];
  if (!el) return;
  el.classList.add('now');
  if (follow && !$('#reader').classList.contains('hidden')) {
    el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
  }
}

// Character positions of each word in a paragraph.
function wordSpans(text) {
  const out = []; const re = /\S+/g; let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}
// A Range over characters a..b of an element's text, across any <mark> tags.
function textRange(el, a, b) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange(); let n, at = 0, started = false;
  while ((n = walk.nextNode())) {
    const len = n.nodeValue.length;
    if (!started && a < at + len) { r.setStart(n, a - at); started = true; }
    if (started && b <= at + len) { r.setEnd(n, b - at); return r; }
    at += len;
  }
  return null;
}
// Index of the word being spoken in paragraph i at time t. Books without word timings
// spread the words evenly over the paragraph.
function wordIndexAt(i, t) {
  const p = book.paras[i];
  if (p.w) {
    const rel = (t - p.s) * 100;
    let lo = 0, hi = p.w.length - 1, k = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.w[mid] <= rel + 4) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return k;
  }
  const n = p.t.split(/\s+/).length, end = paraEnd(i);
  return Math.max(0, Math.min(n - 1, Math.floor(((t - p.s) / Math.max(0.1, end - p.s)) * n)));
}
// Time word k of paragraph i is spoken.
function wordTime(i, k) {
  const p = book.paras[i];
  if (p.w && p.w[k] !== undefined) return p.s + p.w[k] / 100;
  const n = p.t.split(/\s+/).length;
  return p.s + (paraEnd(i) - p.s) * (k / n);
}
const paraEnd = (i) => (i + 1 < book.paras.length ? book.paras[i + 1].s : (audio.duration || book.duration || book.paras[i].s + 20));

function hideWord() { wordIdx = -1; wordBox.classList.add('hidden'); }
function updateWord(force) {
  if (!book || cur < 0 || !paraEls[cur]) return;
  const p = book.paras[cur];
  if (!p.w) return hideWord();
  if (wordPara !== cur) { wordPara = cur; wordRanges = wordSpans(p.t); wordIdx = -1; }
  const k = wordIndexAt(cur, pos());
  if ((k === wordIdx && !force) || !wordRanges[k]) return;
  wordIdx = k;
  const r = textRange(paraEls[cur], wordRanges[k][0], wordRanges[k][1]);
  const box = r && r.getClientRects()[0];
  if (!box) return hideWord();
  const pad = 3;
  Object.assign(wordBox.style, {
    top: (box.top + scrollY - 1) + 'px', left: (box.left + scrollX - pad) + 'px',
    width: (box.width + pad * 2) + 'px', height: (box.height + 2) + 'px',
  });
  wordBox.classList.remove('hidden');
  // Long paragraphs: keep the spoken word on screen.
  if (follow && !$('#reader').classList.contains('hidden') && $('#rsvp').classList.contains('hidden')) {
    const playerTop = $('#player').getBoundingClientRect().top;
    if (box.bottom > playerTop - 40 || box.top < 80) {
      scrollBy({ top: box.top - (playerTop * 0.4), behavior: 'smooth' });
    }
  }
}
let ticking = false;
function tick() {
  if (audio.paused || !book) { ticking = false; return; }
  if (!document.hidden) { updateWord(); if (rsvpOn) rsvpFollow(); }
  requestAnimationFrame(tick);
}
function startTick() { if (!ticking) { ticking = true; requestAnimationFrame(tick); } }

let lastSave = 0, lastChapter = -1, lastT = 0;
function onTime(force) {
  if (!book) return;
  const t = pos();
  setCurrent(findAt(book.paras, t, 's'));
  updateWord(force);
  if (rsvpOn && !rsvpRunning) rsvpFollow();
  const ci = chapterAt(t);
  const start = book.chapters[ci].start, end = chapterEnd(ci);
  // Played (not jumped) into the next chapter: offer the quiz on the one just finished.
  if (lastChapter >= 0 && ci === lastChapter + 1 && !audio.paused && lastT >= start - 3 && t - lastT < 3) {
    quizAfterChapter(lastChapter);
  }
  lastT = t;
  if (ci !== lastChapter || force) {
    lastChapter = ci;
    $('#chapTitle').textContent = book.chapters[ci].title;
    $('#chapNum').textContent = `${ci + 1} of ${book.chapters.length}`;
    $('#chapName').textContent = book.chapters[ci].title;
    $('#rsvpChap').textContent = `${ci + 1} of ${book.chapters.length} · ${book.chapters[ci].title}`;
    updateMediaMeta();
  }
  const total = audio.duration || book.duration;
  $('#bookPct').textContent = total ? `${Math.min(100, Math.floor((t / total) * 100))}% of book` : '';
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

function togglePlay() {
  if (rsvpOn && pref.get('rsvpMode', 'voice') === 'silent') return rsvpRunning ? rsvpPause() : rsvpPlay();
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}
// The audio can't be read (saved by an older version of Read Along): ask for the book again.
let warned = null;
function needsReAdd() {
  if (!book || warned === book.id) return;
  warned = book.id;
  setTimeout(() => alert(`The audio for "${book.title}" needs adding again.\n\nGo back to your books, tap Add a book and choose the same .kbook file. Your highlights and place are kept.`), 300);
}
audio.addEventListener('error', () => { if (audio.getAttribute('src')) needsReAdd(); });
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
audio.addEventListener('play', () => {
  // Audio started (e.g. from AirPods) while silent speed reading: follow the voice instead.
  if (rsvpRunning) { rsvpPause(); pref.set('rsvpMode', 'voice'); rsvpOptions(); }
  updatePlayIcon(); startTick(); rsvpState(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayIcon(); savePos(); rsvpState(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });

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
  openSheet(`<h3>Highlights <button id="exportBtn">Share</button></h3>
    ${hls.length ? `<div class="sendbar"><button class="primary" id="nlmBtn">Send to NotebookLM</button></div>
    <p class="tip" style="margin:0 0 12px">Save it to <b>iCloud Drive › Read Along</b>. Your Mac adds it to NotebookLM within the hour.</p>` : ''}
    ${tags.length ? `<div class="chips"><button class="chip ${!tag ? 'on' : ''}" data-t="">All</button>${tags.map((t) =>
      `<button class="chip ${tag === t ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div>` : ''}
    ${shown.length ? shown.map(hlHTML).join('') : `<p class="tip">No highlights yet. Select text and tap <b>Highlight</b>, or double-press your AirPods while listening to keep what you just heard.</p>`}`,
  (s) => {
    wireHl(s);
    s.querySelectorAll('.chip').forEach((c) => (c.onclick = () => showHighlights(c.dataset.t)));
    s.querySelector('#exportBtn').onclick = () => exportHighlights(shown);
    const nlm = s.querySelector('#nlmBtn'); if (nlm) nlm.onclick = () => sendToNotebookLM(hls);
  });
}
function highlightsMarkdown(list) {
  let md = `# Highlights: ${book.title}\n${book.author ? '_' + book.author + '_\n' : ''}`;
  let chap = '';
  for (const h of list) {
    if (h.chapter !== chap) { chap = h.chapter; md += `\n## ${chap}\n`; }
    md += `\n> ${h.quote}\n`;
    if (h.note) md += `\nMy note: ${h.note}\n`;
  }
  return md;
}
// Saves a highlights file (to iCloud Drive > Read Along); the Mac adds it to NotebookLM.
function sendToNotebookLM(all) {
  if (!all.length) return toast('No highlights yet');
  const md = `<!-- readalong ${JSON.stringify({ id: book.id, title: book.title })} -->\n` + highlightsMarkdown(all);
  const base = book.title.split(/[:(]/)[0].trim().replace(/[\\/:*?"<>|]/g, '') + ' - highlights';
  let file = new File([md], base + '.md', { type: 'text/markdown' });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) file = new File([md], base + '.txt', { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).then(() => toast('Saved. Your Mac adds it to NotebookLM within the hour.'))
      .catch((e) => { if (e.name !== 'AbortError') download(file); });
  } else download(file);
}
function download(file) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
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
  openSheet(`<h3>Contents</h3>
    <div class="sendbar"><button id="quizNow">Quiz me on this chapter</button></div>${book.chapters.map((c, i) =>
    `<button class="item ${i === ci ? 'cur' : ''}" data-c="${i}">${esc(c.title)}<small>${fmt(c.start)}</small></button>`).join('')}`,
  (s) => {
    s.querySelectorAll('.item').forEach((b) => (b.onclick = () => { closeSheet(); seekTo(book.chapters[+b.dataset.c].start); }));
    s.querySelector('#quizNow').onclick = () => { audio.pause(); rsvpPause(); showQuiz(ci, 0, 0); };
    const c = s.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
  });
};
$('#hlBtn').onclick = () => showHighlights('');
$('#chapBar').onclick = () => $('#tocBtn').onclick();

function applyLook() {
  document.documentElement.style.setProperty('--text-size', pref.get('size', 19) + 'px');
  const th = pref.get('theme', 'auto');
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  requestAnimationFrame(() => updateWord(true));
}
addEventListener('resize', () => { sizePanels(); updateWord(true); });
$('#setBtn').onclick = function settings() {
  const th = pref.get('theme', 'auto');
  openSheet(`<h3>Text</h3>
    <div class="setrow"><span>Text size</span><div class="stepper"><button data-s="-1">A−</button><button data-s="1">A+</button></div></div>
    <div class="setrow"><span>Look</span></div>
    <div class="chips">${[['auto', 'Match phone'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']].map(([k, l]) =>
      `<button class="chip ${th === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="setrow"><span>Quiz after each chapter</span><div class="seg"><button data-q="1" class="${pref.get('quiz', true) ? 'on' : ''}">On</button><button data-q="0" class="${pref.get('quiz', true) ? '' : 'on'}">Off</button></div></div>
    <p class="tip"><b>AirPods:</b> press once to play or pause. <b>Double-press</b> to keep what you just heard as a highlight. <b>Triple-press</b> to go back 15 seconds.</p>`,
  (s) => {
    s.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      pref.set('size', Math.max(14, Math.min(30, pref.get('size', 19) + +b.dataset.s))); applyLook();
    }));
    s.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { pref.set('theme', b.dataset.t); applyLook(); settings(); }));
    s.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { pref.set('quiz', b.dataset.q === '1'); settings(); }));
  });
};

/* ---------------------------------------------------------------- speed reader */

// Shows 1-3 words at a time with the focus letter in colour, centred so the eye stays still.
// "With voice" follows the audio; "Silent" runs on its own at a words-per-minute speed.
let rsvpOn = false, rsvpRunning = false, rsvpTimer = null, rsvpKey = '';
let rsvpNext = { i: 0, k: 0 }, rsvpShownAt = { i: 0, k: 0 }, rsvpSteps = 0;
let wordsI = -1, wordsW = [];
function wordsOf(i) {
  if (i !== wordsI) { wordsI = i; wordsW = book.paras[i].t.split(/\s+/).filter(Boolean); }
  return wordsW;
}
// The letter the eye should rest on: a little left of the middle of the word.
function focusLetter(w) {
  const lead = (w.match(/^[^\p{L}\p{N}]*/u) || [''])[0].length;
  const core = w.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '').length;
  return Math.min(w.length - 1, lead + (core <= 1 ? 0 : core <= 5 ? 1 : core <= 9 ? 2 : core <= 13 ? 3 : 4));
}
function showChunk(i, k) {
  const n = pref.get('rsvpN', 1), ws = wordsOf(i), s = Math.floor(k / n) * n;
  rsvpShownAt = { i, k: s };
  const key = `${i}:${s}:${n}`;
  if (key === rsvpKey) return;
  rsvpKey = key;
  const chunk = ws.slice(s, s + n);
  if (!chunk.length) return;
  const mid = Math.floor((chunk.length - 1) / 2), w = chunk[mid], at = focusLetter(w);
  const [l, p, r] = $('#rsvpWord').children;
  l.textContent = chunk.slice(0, mid).map((x) => x + ' ').join('') + w.slice(0, at);
  p.textContent = w[at] || '';
  r.textContent = w.slice(at + 1) + chunk.slice(mid + 1).map((x) => ' ' + x).join('');
  // Shrink long words so both halves fit either side of the centre.
  const longest = Math.max(3, l.textContent.length, r.textContent.length);
  const half = Math.min(innerWidth - 32, 600) / 2;
  $('#rsvpWord').style.setProperty('--rsvp-size', Math.max(20, Math.min(48, half / (longest * 0.56))) + 'px');
}
function rsvpFollow() {
  if (!rsvpOn || rsvpRunning || !book) return;
  const t = pos(), i = findAt(book.paras, t, 's');
  showChunk(i, wordIndexAt(i, t));
  rsvpState();
}
function rsvpState() {
  if (!rsvpOn) return;
  const silent = pref.get('rsvpMode', 'voice') === 'silent';
  const playing = silent ? rsvpRunning : !audio.paused;
  $('#rsvpState').textContent = playing
    ? (silent ? `${pref.get('rsvpWpm', 350)} words a minute · tap to pause` : `With the voice at ${audio.playbackRate}× · tap to pause`)
    : (silent ? 'Tap the word to start reading' : 'Tap the word to play');
  // While paused, show the paragraph so you can get your bearings.
  $('#rsvpContext').textContent = playing ? '' : book.paras[rsvpShownAt.i].t;
}
function rsvpStep() {
  const n = pref.get('rsvpN', 1), wpm = pref.get('rsvpWpm', 350);
  const { i, k } = rsvpNext;
  showChunk(i, k);
  const ws = wordsOf(i), s = Math.floor(k / n) * n, chunk = ws.slice(s, s + n), last = chunk[chunk.length - 1] || '';
  let delay = (60000 / wpm) * Math.max(1, chunk.length);
  if (/[.!?]["'”’)]*$/.test(last)) delay *= 1.8;
  else if (/[,;:—–]["'”’)]*$/.test(last)) delay *= 1.3;
  if (chunk.some((w) => w.length > 9)) delay *= 1.2;
  let ni = i, nk = s + n;
  if (nk >= ws.length) { ni = i + 1; nk = 0; delay *= 1.6; }
  // Keep the listening position in step (now and then; seeking audio is slow on phones).
  if (ni !== i || ++rsvpSteps % 12 === 0) { setPos(wordTime(i, s)); onTime(false); }
  if (ni >= book.paras.length) { rsvpTimer = setTimeout(rsvpPause, delay); return; }
  const ci = chapterAt(book.paras[i].s);
  if (ni !== i && chapterAt(book.paras[ni].s) !== ci && pref.get('quiz', true) && buildQuiz(ci).length) {
    rsvpNext = { i: ni, k: 0 };
    rsvpTimer = setTimeout(() => { rsvpPause(); setPos(book.paras[ni].s); onTime(true); quizAfterChapter(ci); }, delay);
    return;
  }
  rsvpNext = { i: ni, k: nk };
  rsvpTimer = setTimeout(rsvpStep, delay);
}
function rsvpPlay() {
  if (rsvpRunning) return;
  audio.pause();
  const t = pos(), i = findAt(book.paras, t, 's');
  rsvpNext = { i, k: wordIndexAt(i, t) };
  rsvpRunning = true; rsvpKey = '';
  rsvpStep(); rsvpState();
}
function rsvpPause() {
  if (!rsvpRunning) return;
  rsvpRunning = false; clearTimeout(rsvpTimer);
  setPos(wordTime(rsvpShownAt.i, rsvpShownAt.k)); onTime(true); savePos();
  rsvpState();
}
function rsvpOptions() {
  const mode = pref.get('rsvpMode', 'voice'), n = pref.get('rsvpN', 1), wpm = pref.get('rsvpWpm', 350);
  $('#rsvpOpts').innerHTML = `
    <div class="seg"><button data-mode="voice" class="${mode === 'voice' ? 'on' : ''}">With voice</button><button data-mode="silent" class="${mode === 'silent' ? 'on' : ''}">Silent</button></div>
    <div class="seg"><span>Words</span>${[1, 2, 3].map((v) => `<button data-n="${v}" class="${n === v ? 'on' : ''}">${v}</button>`).join('')}</div>
    ${mode === 'silent' ? `<div class="seg"><button data-w="-25" aria-label="Slower">−</button><span class="wpm">${wpm} wpm</span><button data-w="25" aria-label="Faster">+</button></div>` : ''}
    <div class="seg"><button id="rsvpDone">Done</button></div>`;
  const o = $('#rsvpOpts');
  o.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    pref.set('rsvpMode', b.dataset.mode);
    if (b.dataset.mode === 'silent') audio.pause(); else rsvpPause();
    rsvpOptions(); rsvpFollow(); rsvpState();
  }));
  o.querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => { pref.set('rsvpN', +b.dataset.n); rsvpKey = ''; rsvpOptions(); rsvpRunning ? showChunk(rsvpShownAt.i, rsvpShownAt.k) : rsvpFollow(); }));
  o.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => {
    pref.set('rsvpWpm', Math.max(100, Math.min(1000, wpm + +b.dataset.w))); rsvpOptions(); rsvpState();
  }));
  $('#rsvpDone').onclick = closeRsvp;
}
function sizePanels() { document.documentElement.style.setProperty('--player-h', $('#player').offsetHeight + 'px'); }
function openRsvp() {
  rsvpOn = true; rsvpKey = '';
  sizePanels();
  $('#rsvp').classList.remove('hidden'); $('#rsvpBtn').classList.add('on');
  hideWord(); rsvpOptions(); rsvpFollow(); onTime(true);
}
function closeRsvp() {
  rsvpPause(); rsvpOn = false;
  $('#rsvp').classList.add('hidden'); $('#rsvpBtn').classList.remove('on');
  follow = true; $('#followBtn').classList.add('hidden');
  const el = paraEls[cur]; if (el) el.scrollIntoView({ block: 'center' });
  updateWord(true);
}
$('#rsvpBtn').onclick = () => (rsvpOn ? closeRsvp() : openRsvp());
$('#rsvpStage').onclick = () => { unlockChime(); togglePlay(); };

/* ---------------------------------------------------------------- ask AI */

const ASK_IDEAS = ['Explain this simply', 'How could I apply this?', 'How does this fit the whole book?', 'Give me 3 discussion questions'];
function currentPassage() {
  let i = Math.max(0, cur);
  if (book.paras[i].h && book.paras[i + 1]) i += 1;
  return book.paras[i].t;
}
function askText(passage, q) {
  const chap = book.chapters[chapterAt(pos())].title;
  return `I'm reading "${book.title}"${book.author ? ` by ${book.author}` : ''}, chapter "${chap}".\n\n` +
    `Passage:\n"${passage.slice(0, 2500)}"\n\n${q || 'Explain this passage and how it fits the main ideas of the book.'}`;
}
function askSheet(passage) {
  passage = (passage || currentPassage()).trim();
  const nb = book.notebook;
  openSheet(`<h3>Ask about this</h3>
    <div class="passage">${esc(passage)}</div>
    <div class="chips">${ASK_IDEAS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <textarea class="askq" id="askQ" placeholder="Your question (optional)"></textarea>
    <div class="askbtns">
      <button class="primary" id="askNlm">Ask NotebookLM<small>Knows the whole book${nb ? ` (${esc(nb.title)} notebook)` : ''}. Your question is copied: paste it into the chat.</small></button>
      <button id="askClaude">Ask Claude<small>Opens Claude with this passage and your question filled in.</small></button>
    </div>
    <p class="tip">Needs internet. Nothing is sent until you tap one of these.</p>`,
  (s) => {
    const q = s.querySelector('#askQ');
    s.querySelectorAll('[data-q]').forEach((c) => (c.onclick = () => { q.value = c.dataset.q; }));
    s.querySelector('#askNlm').onclick = () => {
      const text = askText(passage, q.value.trim());
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      window.open(nb && nb.id ? `https://notebooklm.google.com/notebook/${nb.id}` : 'https://notebooklm.google.com/', '_blank');
      toast('Question copied. Paste it into NotebookLM.');
    };
    s.querySelector('#askClaude').onclick = () => {
      window.open('https://claude.ai/new?q=' + encodeURIComponent(askText(passage, q.value.trim())), '_blank');
    };
  });
}
$('#askBtn').onclick = () => { audio.pause(); rsvpPause(); askSheet(); };
$('#selAsk').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const quote = selInfo ? selInfo.quote : '';
  getSelection().removeAllRanges(); $('#selbar').classList.add('hidden');
  audio.pause(); askSheet(quote);
});

/* ---------------------------------------------------------------- chapter quiz */

// Made on the phone from the book's own text: the chapter's key words are the ones it
// uses often but the rest of the book rarely does. Each becomes a fill-in-the-blank question.
const STOP = new Set(('a about above after again against all almost also although always am among an and another any anyone ' +
  'anything are around as at away back be became because become been before being below between both but by came can ' +
  'cannot come could did do does doing done down during each either else even ever every everyone everything few find ' +
  'first for found from further get gets getting give given go goes going gone good got great had has have having he her ' +
  'here hers herself him himself his how however i if in into is it its itself just keep know known last least less let ' +
  'like little long look made make makes making many may me might more most much must my myself need never new next no ' +
  'none nor not nothing now of off often old on once one only or other others our ours ourselves out over own part people ' +
  'perhaps place put quite rather really right said same saw say says see seem seemed seems seen several shall she should ' +
  'show since so some someone something sometimes still such take taken than that the their theirs them themselves then ' +
  'there therefore these they thing things think this those though thought three through thus time times to today together ' +
  'too took toward towards two under until up upon us use used using very want wanted was way ways we well went were what ' +
  'whatever when where whether which while who whole whom whose why will with within without would year years yet you your ' +
  'yours yourself yourselves chapter book chapters page pages copyright rights reserved permission publication isbn ' +
  'press edition printed thou thee thy thine wilt hath doth unto ' +
  'zero four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred ' +
  'hundreds thousand thousands million millions billion').split(' '));
let quizIndex = null, quizBook = null;
function termsOf(text) {
  const out = [];
  // Two-word terms only within a phrase, never across punctuation.
  for (const phrase of text.toLowerCase().split(/[.,;:!?()\[\]"“”—–]+/)) {
    const toks = (phrase.match(/\p{L}[\p{L}'’-]*\p{L}/gu) || []).map((t) => t.replace(/['’]s$/, ''));
    for (let j = 0; j < toks.length; j++) {
      const a = toks[j], b = toks[j + 1];
      if (STOP.has(a)) continue;
      if (a.length >= 4) out.push(a);
      if (b && !STOP.has(b) && a.length >= 3 && b.length >= 3) out.push(a + ' ' + b);
    }
  }
  return out;
}
// How a term is written in the chapter ("Wesley", "class meeting"), and whether it's a name.
function surfaceOf(term, ci) {
  const [a, b] = chapterParas(ci), re = new RegExp(`\\b${reEsc(term).replace(/ /g, '\\s+')}\\b`, 'gi');
  let caps = 0, low = 0, form = term;
  for (let i = a; i < b; i++) {
    for (const m of book.paras[i].t.matchAll(re)) {
      const before = book.paras[i].t.slice(0, m.index).trimEnd();
      if (!before || /[.!?:"“]$/.test(before)) continue;          // sentence starts don't tell us
      if (/^\p{Lu}/u.test(m[0])) { caps++; form = m[0].replace(/\s+/g, ' '); } else low++;
    }
  }
  return caps > low ? { form, name: true } : { form: term, name: false };
}
function chapterParas(ci) {
  const at = (c) => (c.para !== undefined ? c.para : findAt(book.paras, c.start, 's'));
  return [at(book.chapters[ci]), ci + 1 < book.chapters.length ? at(book.chapters[ci + 1]) : book.paras.length];
}
function buildQuizIndex() {
  const ch = book.chapters.map((c, ci) => {
    const [a, b] = chapterParas(ci), tf = new Map();
    let words = 0;
    for (let i = a; i < b; i++) {
      if (book.paras[i].h) continue;
      words += book.paras[i].t.split(/\s+/).length;
      for (const t of termsOf(book.paras[i].t)) tf.set(t, (tf.get(t) || 0) + 1);
    }
    return { a, b, tf, words };
  });
  const df = new Map();
  ch.forEach((c) => c.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  quizIndex = { ch, df, cache: {} }; quizBook = book.id;
}
function keyTerms(ci, max) {
  const { ch, df } = quizIndex, N = ch.length, scored = [];
  ch[ci].tf.forEach((n, t) => {
    if (n < 2) return;
    scored.push([t, n * Math.log(1 + N / df.get(t)) * (t.includes(' ') ? 1.6 : 1)]);
  });
  scored.sort((x, y) => y[1] - x[1]);
  const picked = [];
  for (const [t] of scored) {
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue;   // "church" vs "churches", "class" vs "class meeting"
    picked.push(t);
    if (picked.length >= max) break;
  }
  return picked;
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function buildQuiz(ci) {
  if (!quizIndex || quizBook !== book.id) buildQuizIndex();
  if (quizIndex.cache[ci]) return quizIndex.cache[ci];
  const c = quizIndex.ch[ci];
  if (!c || c.words < 250) return (quizIndex.cache[ci] = []);
  const terms = keyTerms(ci, 12), qs = [], used = new Set();
  for (const term of terms) {
    const re = new RegExp(`\\b(${reEsc(term).replace(/ /g, '\\s+')})(?:['’]s)?\\b`, 'i');
    let best = null;
    for (let i = c.a; i < c.b; i++) {
      if (book.paras[i].h) continue;
      for (const raw of book.paras[i].t.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g) || []) {
        const s = raw.trim().replace(/^\d+\s+/, ''), m = s.match(re);   // drop a footnote number at the start
        if (!m || s.length < 50 || s.length > 260 || used.has(s)) continue;
        let score = -Math.abs(s.length - 140) / 60;
        if (/\b(is|are|was|were|means|meant|called|refers)\b/i.test(s)) score += 1;
        if (!best || score > best.score) best = { s, m, i, score };
      }
    }
    if (!best) continue;
    used.add(best.s);
    const at = best.m.index, word = best.m[1];
    qs.push({ term: word, para: best.i, before: best.s.slice(0, at), after: best.s.slice(at + word.length) });
    if (qs.length >= 5) break;
  }
  // Wrong answers: other key words from this chapter, then from the full chapters either side,
  // of the same kind as the right answer (a name for a name, one word for one word).
  const pool = terms.map((t) => [t, ci]);
  for (const d of [1, -1, 2, -2, 3, -3]) {
    const o = quizIndex.ch[ci + d];
    if (o && o.words >= 250) pool.push(...keyTerms(ci + d, 6).map((t) => [t, ci + d]));
  }
  const kinds = pool.map(([t, c]) => ({ t, ...surfaceOf(t, c) }));
  for (const q of qs) {
    const t = q.term.toLowerCase().replace(/\s+/g, ' '), me = surfaceOf(t, ci);
    const ok = kinds.filter((k) => !k.t.includes(t) && !t.includes(k.t));
    const alike = ok.filter((k) => k.name === me.name && k.t.includes(' ') === t.includes(' '));
    const wrong = [];
    for (const k of [...shuffle(alike), ...shuffle(ok)]) if (!wrong.includes(k.form) && wrong.length < 3) wrong.push(k.form);
    q.answer = me.form;
    q.choices = shuffle([me.form, ...wrong]);
  }
  return (quizIndex.cache[ci] = qs.filter((q) => q.choices.length >= 3));
}
function quizAfterChapter(ci) {
  if (!pref.get('quiz', true) || !buildQuiz(ci).length) return;
  audio.pause();
  showQuiz(ci, 0, 0);
}
function showQuiz(ci, n, score) {
  const qs = buildQuiz(ci), title = esc(book.chapters[ci].title);
  if (!qs.length) return toast('This chapter is too short for a quiz');
  if (n >= qs.length) {
    return openSheet(`<h3>Chapter check <small>${score} of ${qs.length}</small></h3>
      <p class="tip" style="margin-top:0">${title}</p>
      <p>Key words in this chapter:</p>
      <div class="chips">${qs.map((q) => `<span class="chip">${esc(q.answer)}</span>`).join('')}</div>
      <div class="sendbar"><button id="qAgain">Try again</button><button class="primary" id="qGo">Keep listening</button></div>`,
    (s) => {
      s.querySelector('#qAgain').onclick = () => { quizIndex.cache[ci] = null; showQuiz(ci, 0, 0); };
      s.querySelector('#qGo').onclick = () => { closeSheet(); if (!rsvpOn || pref.get('rsvpMode', 'voice') === 'voice') audio.play().catch(() => {}); else rsvpPlay(); };
    });
  }
  const q = qs[n];
  openSheet(`<h3>Chapter check <small>${n + 1} of ${qs.length}</small></h3>
    <p class="tip" style="margin-top:0">${title}</p>
    <p class="quizq">${esc(q.before)}<b class="blank">${' '.repeat(3)}</b>${esc(q.after)}</p>
    <div class="choices">${q.choices.map((c) => `<button class="choice" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="sendbar hidden" id="qFoot"><button id="qListen">Listen to this part</button><button class="primary" id="qNext">${n + 1 < qs.length ? 'Next' : 'See score'}</button></div>`,
  (s) => {
    let right = false;
    s.querySelectorAll('.choice').forEach((b) => (b.onclick = () => {
      if (!s.querySelector('#qFoot').classList.contains('hidden')) return;
      right = b.dataset.c === q.answer;
      s.querySelectorAll('.choice').forEach((x) => x.classList.add(x.dataset.c === q.answer ? 'right' : x === b ? 'wrong' : 'off'));
      s.querySelector('.blank').textContent = q.term;
      s.querySelector('#qFoot').classList.remove('hidden');
    }));
    s.querySelector('#qListen').onclick = () => { closeSheet(); seekTo(book.paras[q.para].s, true); };
    s.querySelector('#qNext').onclick = () => showQuiz(ci, n + 1, score + (right ? 1 : 0));
  });
}
audio.addEventListener('ended', () => quizAfterChapter(book.chapters.length - 1));

/* ---------------------------------------------------------------- start */

$('#backBtn').onclick = () => { pref.set('last', null); showLibrary(); };
$('#addBtn').onclick = () => $('#file').click();
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
applyLook();
(async () => {
  // Open straight back into the book you were reading.
  const last = pref.get('last', null);
  if (last && await get('books', last).catch(() => null)) openBook(last); else showLibrary();
})();
window.addEventListener('pagehide', savePos);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
