/* Read Along · Listen: paste any text (or open a file) and hear it read aloud with the
   phone's own voices, the sentence shaded and the word highlighted as it's spoken.
   Everything stays on this phone. Uses helpers from app.js ($, esc, toast, busy, pref,
   openSheet, closeSheet, put/get/del/all, newId, sentencesOf). */
'use strict';

const synth = window.speechSynthesis;
const L = {
  piece: null,      // { id, title, paras: [{ t, h }], words, added }
  sents: [],        // every sentence: { el, text }
  cur: 0,           // sentence being read
  from: 0,          // character in that sentence to start from (after pause / speed change)
  word: 0,          // character the voice is on
  playing: false,
  token: 0,         // ignores events from a voice that has been stopped
  sleepAt: 0,
  lastScroll: 0,
  wake: null,
};
const LSPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Deranged|Hysterical|Pipe Organ)\b/i;

/* ---------------------------------------------------------------- library tab */

function showTab(tab) {
  pref.set('tab', tab);
  $('#tabBooks').classList.toggle('on', tab === 'books');
  $('#tabListen').classList.toggle('on', tab === 'listen');
  $('#booksPane').classList.toggle('hidden', tab !== 'books');
  $('#listenPane').classList.toggle('hidden', tab !== 'listen');
  if (tab === 'listen') listPieces();
}
$('#tabBooks').onclick = () => showTab('books');
$('#tabListen').onclick = () => showTab('listen');
function listenLibrary() { showTab(pref.get('tab', 'books')); }
listenLibrary();

async function listPieces() {
  const list = (await all('pieces')).sort((a, b) => pref.get('lopened:' + b.id, b.added) - pref.get('lopened:' + a.id, a.added));
  const box = $('#pieces');
  if (!list.length) { box.innerHTML = `<div class="empty">Nothing here yet.<br>Tap <b>Paste text</b> or <b>Open a file</b>.</div>`; return; }
  box.innerHTML = list.map((p) => {
    const at = pref.get('lpos:' + p.id, 0), pct = p.sents ? Math.min(100, Math.round((at / p.sents) * 100)) : 0;
    const mins = Math.max(1, Math.round(p.words / 170));
    return `<button class="book piece" data-id="${p.id}"><div class="cover">${esc((p.title || '?')[0])}</div>
      <div class="meta"><b>${esc(p.title)}</b><span>${p.words.toLocaleString()} words · about ${mins} min</span>
      <div class="bar"><i style="width:${pct}%"></i></div></div></button>`;
  }).join('') + `<p class="note-small">Press and hold one to remove it.</p>`;
  box.querySelectorAll('.piece').forEach((el) => {
    el.onclick = () => openPiece(el.dataset.id);
    el.oncontextmenu = (e) => { e.preventDefault(); removePiece(el.dataset.id); };
  });
}
async function removePiece(id) {
  const p = await get('pieces', id);
  if (!p || !confirm(`Remove "${p.title}"?`)) return;
  await del('pieces', id);
  listPieces();
}

/* ---------------------------------------------------------------- adding text */

$('#pasteBtn').onclick = () => openSheet(`<h3>Paste text</h3>
  <input class="titlebox" id="pTitle" placeholder="Title (optional)">
  <textarea class="pastebox" id="pText" placeholder="Paste here"></textarea>
  <div class="sendbar" style="margin-top:10px"><button id="pClip">Paste from clipboard</button><button class="primary" id="pGo">Read it</button></div>`,
(s) => {
  s.querySelector('#pClip').onclick = async () => {
    try { s.querySelector('#pText').value = await navigator.clipboard.readText(); }
    catch { toast('Tap in the box, then tap Paste'); s.querySelector('#pText').focus(); }
  };
  s.querySelector('#pGo').onclick = async () => {
    const text = s.querySelector('#pText').value;
    if (!text.trim()) return toast('Paste some text first');
    closeSheet();
    await savePiece(s.querySelector('#pTitle').value.trim(), textToParas(text));
  };
});
$('#openBtn').onclick = () => $('#lfile').click();
$('#lfile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    busy('Reading the file…');
    const { title, paras } = await readFile(f);
    busy();
    if (!paras.length) throw new Error('No text found in that file (a scanned PDF is just pictures of pages).');
    await savePiece(title, paras);
  } catch (err) {
    busy();
    alert('Couldn\'t read that file: ' + ((err && err.message) || err));
  }
};

async function savePiece(title, paras) {
  paras = paras.map((p) => ({ t: p.t.replace(/\s+/g, ' ').trim(), h: !!p.h })).filter((p) => p.t);
  if (!paras.length) return toast('No text to read');
  const words = paras.reduce((n, p) => n + p.t.split(' ').length, 0);
  const sents = paras.reduce((n, p) => n + splitSentences(p.t).length, 0);
  const first = paras.find((p) => !p.h) || paras[0];
  title = title || first.t.split(/(?<=[.!?])\s/)[0].slice(0, 60);
  const piece = { id: newId(), title, paras, words, sents, added: Date.now() };
  await put('pieces', piece);
  openPiece(piece.id);
}

// Plain text: blank lines split paragraphs; with no blank lines, every line is one.
function textToParas(text) {
  text = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const blocks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split('\n');
  return blocks.map((b) => ({ t: b.replace(/-\n(?=[a-z])/g, '').replace(/\n/g, ' ') }));
}

/* ---------------------------------------------------------------- reading files */

async function readFile(f) {
  const name = f.name || 'Untitled', ext = (name.split('.').pop() || '').toLowerCase();
  const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  if (ext === 'pdf' || f.type === 'application/pdf') return { title, paras: await readPdf(f) };
  if (ext === 'docx') return { title, paras: await readDocx(await f.arrayBuffer()) };
  if (ext === 'epub') return readEpub(await f.arrayBuffer(), title);
  if (ext === 'html' || ext === 'htm') return { title, paras: htmlParas(new DOMParser().parseFromString(await f.text(), 'text/html')) };
  if (ext === 'gdoc' || ext === 'gsheet' || ext === 'gslides') throw new Error('Google Docs can\'t be opened from Files. In the Google Docs app: ⋯ → Share & export → Copy, then use Paste text here. (Or save it as Word first.)');
  if (ext === 'doc' || ext === 'pages') throw new Error('Save it as .docx (Word) or PDF first, or copy and paste the text.');
  return { title, paras: textToParas(await f.text()) };
}

// A small ZIP reader (Word and ePub files are ZIPs).
async function unzip(buf) {
  const dv = new DataView(buf), td = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('The file looks damaged.');
  const files = new Map();
  let o = dv.getUint32(e + 16, true);
  for (let k = dv.getUint16(e + 10, true); k > 0; k--) {
    const nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true);
    files.set(td.decode(new Uint8Array(buf, o + 46, nl)),
      { method: dv.getUint16(o + 10, true), size: dv.getUint32(o + 20, true), at: dv.getUint32(o + 42, true) });
    o += 46 + nl + xl + cl;
  }
  return async (name) => {
    const f = files.get(name) || files.get(decodeURIComponent(name));
    if (!f) return null;
    const start = f.at + 30 + dv.getUint16(f.at + 26, true) + dv.getUint16(f.at + 28, true);
    const data = new Uint8Array(buf, start, f.size);
    if (f.method === 0) return td.decode(data);
    if (typeof DecompressionStream === 'undefined') throw new Error('This phone needs iOS 16.4 or newer to open Word and ePub files.');
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
}
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');

async function readDocx(buf) {
  const doc = xml(await (await unzip(buf))('word/document.xml'));
  const out = [];
  for (const p of doc.getElementsByTagName('w:p')) {
    let t = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeName === 'w:t') t += c.textContent;
        else if (c.nodeName === 'w:tab' || c.nodeName === 'w:br') t += ' ';
        else if (c.nodeName !== 'w:pPr' && c.nodeName !== 'w:instrText' && c.nodeName !== 'w:delText') walk(c);
      }
    };
    walk(p);
    const st = p.getElementsByTagName('w:pStyle')[0], style = st ? st.getAttribute('w:val') || '' : '';
    out.push({ t, h: /^(Heading|Title)/i.test(style) });
  }
  return out;
}

// Paragraphs and headings from a web page or an ePub chapter.
function htmlParas(doc) {
  const sel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption';
  const body = doc.body || doc.documentElement;
  if (!body) return [];
  body.querySelectorAll('script,style,nav,noscript').forEach((n) => n.remove());
  const els = [...body.querySelectorAll(sel)].filter((el) => !el.parentElement.closest(sel));
  if (!els.length) return textToParas(body.textContent || '');
  return els.map((el) => ({ t: el.textContent, h: /^H[1-6]$/i.test(el.nodeName) }));
}

async function readEpub(buf, fallback) {
  const read = await unzip(buf);
  const container = xml(await read('META-INF/container.xml'));
  const opfPath = container.getElementsByTagName('rootfile')[0].getAttribute('full-path');
  const dir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
  const opf = xml(await read(opfPath));
  const tEl = opf.getElementsByTagName('dc:title')[0];
  const items = {};
  for (const it of opf.getElementsByTagName('item')) items[it.getAttribute('id')] = it.getAttribute('href');
  const paras = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const href = items[ref.getAttribute('idref')];
    if (!href) continue;
    const src = await read(dir + href.split('#')[0]);
    if (!src) continue;
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    paras.push(...htmlParas(doc));
  }
  return { title: (tEl && tEl.textContent.trim()) || fallback, paras };
}

// PDF: uses Mozilla's free PDF reader, fetched the first time a PDF is opened (needs internet).
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = base + 'pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    s.onerror = () => fail(new Error('Opening a PDF needs internet the first time.'));
    document.head.appendChild(s);
  });
}
async function readPdf(f) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
  const lines = [];   // { text, y, h, page }
  for (let n = 1; n <= pdf.numPages; n++) {
    busy(`Reading the file… page ${n} of ${pdf.numPages}`);
    const page = await pdf.getPage(n), tc = await page.getTextContent();
    let line = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5], h = Math.abs(it.transform[3]) || 10;
      if (!line || Math.abs(line.y - y) > h * 0.5) { if (line) lines.push(line); line = { text: '', y, h, page: n }; }
      line.text += it.str;
      if (it.hasEOL) { lines.push(line); line = null; }
    }
    if (line) lines.push(line);
  }
  // Drop page numbers, then join lines into paragraphs where the gap between lines is bigger than usual.
  const keep = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text && !/^\d{1,4}$/.test(l.text));
  const gaps = [];
  for (let k = 1; k < keep.length; k++) if (keep[k].page === keep[k - 1].page) gaps.push(keep[k - 1].y - keep[k].y);
  gaps.sort((a, b) => a - b);
  const usual = gaps.length ? gaps[Math.floor(gaps.length * 0.3)] : 14;   // the normal line spacing
  const paras = []; let cur = '';
  keep.forEach((l, k) => {
    const prev = keep[k - 1];
    const gap = prev && prev.page === l.page ? prev.y - l.y : usual;
    if (cur && (gap > usual * 1.45 || gap < 0)) { paras.push({ t: cur }); cur = ''; }
    cur = cur.endsWith('-') && /^[a-z]/.test(l.text) ? cur.slice(0, -1) + l.text : (cur ? cur + ' ' : '') + l.text;
  });
  if (cur) paras.push({ t: cur });
  return paras;
}

/* ---------------------------------------------------------------- the reader */

// Sentences, with very long ones split at a comma or semicolon (phone voices stop on long lines).
function splitSentences(text) {
  const out = [];
  for (const [a, b] of sentencesOf(text)) {
    let s = a;
    while (b - s > 260) {
      const cut = text.slice(s, s + 260).search(/[;:,—–](?=\s)(?!.*[;:,—–]\s)/);
      const at = cut > 60 ? s + cut + 1 : text.lastIndexOf(' ', s + 240) > s ? text.lastIndexOf(' ', s + 240) : s + 240;
      out.push([s, at]); s = at;
      while (text[s] === ' ') s++;
    }
    out.push([s, b]);
  }
  return out;
}

async function openPiece(id) {
  if (!audio.paused) audio.pause();
  const p = await get('pieces', id);
  if (!p) return listPieces();
  L.piece = p;
  pref.set('lopened:' + id, Date.now());
  pref.set('last', null);   // reopen the app at the list, not inside a book
  $('#lTitle').textContent = p.title;
  document.title = p.title;
  const box = $('#ltext');
  L.sents = [];
  box.innerHTML = p.paras.map((para) => {
    const parts = splitSentences(para.t).map(([a, b]) => {
      L.sents.push({ text: para.t.slice(a, b) });
      return `<span class="s" data-k="${L.sents.length - 1}">${esc(para.t.slice(a, b))}</span>`;
    }).join(' ');
    return para.h ? `<h2>${parts}</h2>` : `<p>${parts}</p>`;
  }).join('');
  box.querySelectorAll('.s').forEach((el) => (L.sents[+el.dataset.k].el = el));
  $('#library').classList.add('hidden');
  $('#reader').classList.add('hidden');
  $('#listen').classList.remove('hidden');
  L.cur = Math.min(pref.get('lpos:' + id, 0), L.sents.length - 1);
  L.from = 0;
  markSentence(true);
  updateLSpeed();
  updateTimes();
  scrollTo(0, 0);
  requestAnimationFrame(() => markSentence(true, true));
}

function markSentence(instant, force) {
  const old = $('#ltext .s.now');
  const s = L.sents[L.cur];
  if (old && (old !== (s && s.el) || force)) old.classList.remove('now');
  if (!s) return;
  s.el.classList.add('now');
  if (Date.now() - L.lastScroll > 6000 || force) {
    const r = s.el.getBoundingClientRect(), bottom = $('#lplayer').getBoundingClientRect().top;
    if (force || r.top < 70 || r.bottom > bottom - 30) s.el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
  }
}
function showWord(k, at) {
  L.word = at;
  if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  const s = L.sents[k], node = s && s.el.firstChild;
  if (!node) return;
  const m = /\S+/.exec(s.text.slice(at));
  const a = at + (m ? m.index : 0), b = Math.min(s.text.length, a + (m ? m[0].length : 0));
  const r = document.createRange();
  try { r.setStart(node, a); r.setEnd(node, b); CSS.highlights.set('lword', new Highlight(r)); } catch {}
}
function clearWord() { if (window.CSS && CSS.highlights) CSS.highlights.delete('lword'); }

/* ---------------------------------------------------------------- voices */

function voices() {
  return synth.getVoices().filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name));
}
const quality = (v) => (/premium/i.test(v.voiceURI + v.name) ? 2 : /enhanced/i.test(v.voiceURI + v.name) ? 1 : 0);
function chosenVoice() {
  const list = voices(), want = pref.get('lvoice', '');
  const v = list.find((x) => x.voiceURI === want);
  if (v) return v;
  // Best sounding voice, preferring Australian then British English.
  const rank = (x) => quality(x) * 10 + (/AU/i.test(x.lang) ? 3 : /GB/i.test(x.lang) ? 2 : /US/i.test(x.lang) ? 1 : 0) + (x.localService ? 0.5 : 0);
  return list.sort((a, b) => rank(b) - rank(a))[0] || null;
}
function voiceSheet() {
  const list = voices(), cur = chosenVoice();
  const label = (v) => `${esc(v.name.replace(/\s*\((Enhanced|Premium)\)/i, ''))}<small>${esc(v.lang)}${quality(v) === 2 ? ' · Premium' : quality(v) === 1 ? ' · Enhanced' : ''}</small>`;
  list.sort((a, b) => quality(b) - quality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  openSheet(`<h3>Voice</h3>
    ${list.length ? list.map((v) => `<button class="voice ${cur && v.voiceURI === cur.voiceURI ? 'on' : ''}" data-v="${esc(v.voiceURI)}">${label(v)}</button>`).join('') : '<p>No English voices found yet. Close this and try again in a moment.</p>'}
    <p class="tip"><b>Better voices, free:</b> on your iPhone open <b>Settings → Accessibility → Read & Speak (Spoken Content) → Voices → English</b>, pick a voice marked <b>Premium</b> or <b>Enhanced</b> and download it. Then close and reopen Read Along.</p>`,
  (s) => s.querySelectorAll('.voice').forEach((b) => (b.onclick = () => {
    pref.set('lvoice', b.dataset.v);
    s.querySelectorAll('.voice').forEach((x) => x.classList.toggle('on', x === b));
    if (L.playing) speakAt(L.cur, L.word);
    else sample();
  })));
}
function sample() {
  synth.cancel();
  const u = new SpeechSynthesisUtterance('Hello Joel. This is how I sound reading to you.');
  const v = chosenVoice(); if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = pref.get('lrate', 1);
  L.token++;
  synth.speak(u);
}
if (synth) synth.onvoiceschanged = () => {};   // iPhones load the voice list late; asking keeps it warm

/* ---------------------------------------------------------------- speaking */

function speakAt(k, from = 0) {
  if (!synth) return toast('This browser can\'t read aloud');
  const my = ++L.token;
  const wasBusy = synth.speaking || synth.pending;
  synth.cancel();
  if (k >= L.sents.length) { stopL(); L.cur = L.sents.length - 1; toast('The end'); return; }
  L.cur = k; L.from = from; L.word = from; L.playing = true;
  pref.set('lpos:' + L.piece.id, k);
  markSentence(false);
  updatePlayL(); updateTimes(); keepAwake(true);
  const s = L.sents[k];
  const text = s.text.slice(from);
  if (!/\w/.test(text)) return void setTimeout(() => my === L.token && speakAt(k + 1), 0);
  const u = new SpeechSynthesisUtterance(text);
  const v = chosenVoice(); if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = pref.get('lrate', 1);
  showWord(k, from);
  u.onboundary = (e) => { if (my === L.token && (!e.name || e.name === 'word')) showWord(k, from + e.charIndex); };
  u.onend = () => {
    if (my !== L.token) return;
    if (L.sleepAt && Date.now() >= L.sleepAt) { setLSleep(0); stopL(); L.cur = Math.min(k + 1, L.sents.length - 1); markSentence(false); toast('Sleep timer: stopped'); return; }
    speakAt(k + 1);
  };
  u.onerror = (e) => {
    if (my !== L.token || e.error === 'interrupted' || e.error === 'canceled') return;
    stopL(); toast('The voice stopped (' + e.error + '). Tap play to carry on.');
  };
  // iPhones sometimes drop a new line spoken the instant the old one was stopped.
  if (wasBusy) setTimeout(() => my === L.token && synth.speak(u), 120); else synth.speak(u);
}
function stopL() {
  L.token++; L.playing = false;
  if (synth) synth.cancel();
  updatePlayL(); keepAwake(false);
}
function pauseL() { const at = L.word; stopL(); L.from = at; }
function playL() { speakAt(L.cur, L.from); }
function updatePlayL() {
  $('#lPlayIcon').setAttribute('href', L.playing ? '#i-pause' : '#i-play');
  $('#lPlay').setAttribute('aria-label', L.playing ? 'Pause' : 'Play');
}
function updateTimes() {
  if (!L.piece) return;
  let left = 0;
  for (let k = L.cur; k < L.sents.length; k++) left += L.sents[k].text.split(' ').length;
  const mins = Math.round(left / (170 * pref.get('lrate', 1)));
  $('#lNow').textContent = `${Math.min(100, Math.floor((L.cur / Math.max(1, L.sents.length)) * 100))}% read`;
  $('#lLeft').textContent = mins < 1 ? 'under a minute left' : `about ${mins} min left`;
  $('#lSub').textContent = `${L.piece.words.toLocaleString()} words`;
}
// Keep the screen on while reading: a locked iPhone can stop the voice.
async function keepAwake(on) {
  try {
    if (on && !L.wake && navigator.wakeLock) { L.wake = await navigator.wakeLock.request('screen'); L.wake.addEventListener('release', () => (L.wake = null)); }
    if (!on && L.wake) { await L.wake.release(); L.wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && L.playing) keepAwake(true); });

/* ---------------------------------------------------------------- controls */

$('#lPlay').onclick = () => (L.playing ? pauseL() : playL());
$('#lPrev').onclick = () => {
  L.lastScroll = 0;
  // Well into a sentence: start it again. At its start: go to the one before.
  const k = L.playing && L.word - L.from > 12 ? L.cur : Math.max(0, L.cur - 1);
  if (L.playing) return speakAt(k);
  L.cur = k; L.from = 0; markSentence(false, true); updateTimes();
};
$('#lNext').onclick = () => { L.lastScroll = 0; if (L.playing) speakAt(L.cur + 1); else { L.cur = Math.min(L.sents.length - 1, L.cur + 1); L.from = 0; markSentence(false, true); updateTimes(); } };
$('#lBack').onclick = () => { stopL(); clearWord(); L.piece = null; pref.set('tab', 'listen'); showLibrary(); };
$('#lVoiceBtn').onclick = voiceSheet;
$('#ltext').addEventListener('click', (e) => {
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const el = e.target.closest('.s');
  if (el) { L.lastScroll = 0; speakAt(+el.dataset.k); }
});
const lHandScroll = () => { if (!$('#listen').classList.contains('hidden')) L.lastScroll = Date.now(); };
addEventListener('touchmove', lHandScroll, { passive: true });
addEventListener('wheel', lHandScroll, { passive: true });

function updateLSpeed() { $('#lSpeed').textContent = (Math.round(pref.get('lrate', 1) * 100) / 100) + '×'; }
$('#lSpeed').onclick = () => {
  const r = pref.get('lrate', 1);
  openSheet(`<h3>Speed</h3><div class="chips">${LSPEEDS.map((x) => `<button class="chip ${x === r ? 'on' : ''}" data-r="${x}">${x}×</button>`).join('')}</div>
    <p class="tip">Phone voices go up to about 2×. For faster listening, the audiobooks in the Books tab go up to 4.5×.</p>`,
  (s) => s.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
    pref.set('lrate', +b.dataset.r); updateLSpeed(); updateTimes(); closeSheet();
    if (L.playing) speakAt(L.cur, L.word);
  })));
};
function setLSleep(mins) {
  L.sleepAt = mins ? Date.now() + mins * 60000 : 0;
  $('#lSleep').classList.toggle('on', !!mins);
  $('#lSleep').innerHTML = `<svg class="icon"><use href="#i-moon"/></svg>` + (mins ? `<small>${mins}m</small>` : '');
}
$('#lSleep').onclick = () => openSheet(`<h3>Sleep timer</h3><div class="chips">${[0, 5, 10, 15, 30, 45, 60].map((m) =>
  `<button class="chip" data-m="${m}">${m ? m + ' min' : 'Off'}</button>`).join('')}</div>`,
  (s) => s.querySelectorAll('[data-m]').forEach((c) => (c.onclick = () => { setLSleep(+c.dataset.m); closeSheet(); toast(+c.dataset.m ? `Stopping in ${c.dataset.m} minutes` : 'Sleep timer off'); })));
$('#lSetBtn').onclick = function lset() {
  const th = pref.get('theme', 'auto');
  openSheet(`<h3>Text</h3>
    <div class="setrow"><span>Text size</span><div class="stepper"><button data-s="-1">A−</button><button data-s="1">A+</button></div></div>
    <div class="setrow"><span>Look</span></div>
    <div class="chips">${[['auto', 'Match phone'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']].map(([k, l]) =>
      `<button class="chip ${th === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>`,
  (s) => {
    s.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { pref.set('size', Math.max(14, Math.min(30, pref.get('size', 19) + +b.dataset.s))); applyLook(); }));
    s.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { pref.set('theme', b.dataset.t); applyLook(); lset(); }));
  });
};
// Starting an audiobook stops the reading voice.
audio.addEventListener('play', () => { if (L.playing) stopL(); });
