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
$('#verNum').textContent = VERSION;

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
    unlockSpeech();   // must happen during the tap, or the iPhone keeps the voice silent
    closeSheet();
    savePiece(s.querySelector('#pTitle').value.trim(), textToParas(text), true);
  };
});
$('#openBtn').onclick = () => { unlockSpeech(); $('#lfile').click(); };
$('#lfile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    busy('Reading the file…');
    const { title, paras } = await readFile(f);
    busy();
    if (!paras.length) throw new Error('No text found in that file (a scanned PDF is just pictures of pages).');
    savePiece(title, paras, false);
    toast('Tap play to start');
  } catch (err) {
    busy();
    alert('Couldn\'t read that file: ' + ((err && err.message) || err));
  }
};

function savePiece(title, paras, autoplay) {
  paras = paras.map((p) => ({ t: p.t.replace(/\s+/g, ' ').trim(), h: !!p.h })).filter((p) => p.t);
  if (!paras.length) return toast('No text to read');
  const words = paras.reduce((n, p) => n + p.t.split(' ').length, 0);
  const sents = paras.reduce((n, p) => n + splitSentences(p.t).length, 0);
  const first = paras.find((p) => !p.h) || paras[0];
  title = title || first.t.split(/(?<=[.!?])\s/)[0].slice(0, 60);
  const piece = { id: newId(), title, paras, words, sents, added: Date.now() };
  showPiece(piece);
  if (autoplay) speakAt(0);   // start reading straight away, while the tap is still happening
  put('pieces', piece).catch(() => toast('Couldn\'t save this one on the phone'));
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
  const p = await get('pieces', id);
  if (!p) return listPieces();
  showPiece(p);
}
function showPiece(p) {
  const id = p.id;
  if (!audio.paused) audio.pause();
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
  setupListenMedia();
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
  const list = voices(), cur = studioOn() ? null : chosenVoice(), kv = pref.get('lkvoice', 'bm_george');
  const label = (v) => `${esc(v.name.replace(/\s*\((Enhanced|Premium)\)/i, ''))}<small>${esc(v.lang)}${quality(v) === 2 ? ' · Premium' : quality(v) === 1 ? ' · Enhanced' : ''}</small>`;
  list.sort((a, b) => quality(b) - quality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  openSheet(`<h3>Voice</h3>
    <p class="vhead">Studio voices <small>the same voices as your audiobooks</small></p>
    ${IOS ? `<p class="tip" style="margin-top:0">Studio voices are too big to run inside an iPhone's browser (they made the app crash), so they're switched off on this phone for now.</p>` : `<div id="kStat"></div>
    ${STUDIO.map(([id, name, kind]) => `<button class="voice kv ${studioOn() && kv === id ? 'on' : ''}" data-k="${id}">${name}<small>${kind}</small></button>`).join('')}`}
    <p class="vhead" style="margin-top:18px">Phone voices <small>instant, no download</small></p>
    ${list.length ? list.map((v) => `<button class="voice ${cur && v.voiceURI === cur.voiceURI ? 'on' : ''}" data-v="${esc(v.voiceURI)}">${label(v)}</button>`).join('') : '<p>No English voices found yet. Close this and try again in a moment.</p>'}
    <p class="tip"><b>Better voices, free:</b> on your iPhone open <b>Settings → Accessibility → Read & Speak (Spoken Content) → Voices → English</b>, pick a voice marked <b>Premium</b> or <b>Enhanced</b> and download it. Then close and reopen Read Along.</p>
    <div class="sendbar"><button id="vrCopy2">Copy voice check</button></div>`,
  (s) => {
    s.querySelector('#vrCopy2').onclick = () => navigator.clipboard.writeText(voiceReport()).then(() => toast('Copied: paste it to Claude'), () => toast('Couldn\'t copy'));
    kStatus();
    s.querySelectorAll('.voice').forEach((b) => (b.onclick = () => {
      const studio = !!b.dataset.k;
      unlockSpeech(); kUnlockAudio();
      if (studio && K.state !== 'ready') { kLoad().catch(() => {}); if (K.state !== 'ready') return toast('Download the studio voices first'); }
      const wasPlaying = L.playing, at = L.word;
      if (wasPlaying) stopL();
      pref.set('lengine', studio ? 'studio' : 'phone');
      if (studio) pref.set('lkvoice', b.dataset.k); else { pref.set('lvoice', b.dataset.v); L.plainVoice = false; }
      s.querySelectorAll('.voice').forEach((x) => x.classList.toggle('on', x === b));
      updateLSpeed();
      if (wasPlaying) speakAt(L.cur, at);
      else if (studio) kSample(); else sample();
    }));
  });
}
function sample() {
  unlockSpeech();
  if (synth.speaking || synth.pending) synth.cancel();
  const u = new SpeechSynthesisUtterance('Hello Joel. This is how I sound reading to you.');
  const v = chosenVoice(); if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = pref.get('lrate', 1);
  L.token++;
  synth.speak(u);
}
if (synth) synth.onvoiceschanged = () => {};   // iPhones load the voice list late; asking keeps it warm

// iPhones only let a page speak if its first words start during a tap. Speaking nothing
// during the first tap "unlocks" the voice for the rest of the visit. Also ask for the
// media sound channel, so the Ring/Silent switch doesn't mute it (iOS 17+).
function unlockSpeech() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (!synth || L.unlocked) return;
  L.unlocked = true;
  vlog('tap');
}

// Voice check: what happened the last few times it tried to speak.
const vlogLines = [];
function vlog(msg) { vlogLines.push(new Date().toLocaleTimeString() + ' ' + msg); if (vlogLines.length > 60) vlogLines.shift(); }
function voiceReport() {
  const v = chosenVoice(), all = synth ? synth.getVoices() : [];
  return `Read Along ${VERSION} · Listen\n${navigator.userAgent}\nVoices: ${all.length} (${voices().length} English) · chosen: ${v ? v.name + ' ' + v.lang + (v.localService ? ' on-phone' : ' online') : 'phone default'}\nSound channel: ${navigator.audioSession ? navigator.audioSession.type : 'n/a'}\n` + vlogLines.join('\n');
}
// Nothing heard: say what to check.
function noSoundHelp(hadVoice) {
  openSheet(`<h3>No sound?</h3>
    <p>The phone didn't start speaking. Check these:</p>
    <p>1. <b>Ring/Silent switch</b> on the side of the iPhone: switch it to Ring (no orange showing). Spoken text follows that switch.</p>
    <p>2. <b>Volume up</b> while it's trying to read.</p>
    <p>3. Tap the <b>microphone</b> button (top right) and choose a different voice.</p>
    <p>4. Close Read Along fully (swipe it away) and open it again.</p>
    <div class="sendbar"><button id="vrCopy">Copy voice check</button><button class="primary" id="vrTry">Try again</button></div>`,
  (s) => {
    s.querySelector('#vrCopy').onclick = () => navigator.clipboard.writeText(voiceReport()).then(() => toast('Copied: paste it to Claude'), () => toast('Couldn\'t copy'));
    // Second try uses the phone's own default voice (the chosen one may not be downloaded).
    s.querySelector('#vrTry').onclick = () => { if (hadVoice) L.plainVoice = true; closeSheet(); unlockSpeech(); speakAt(L.cur, L.from); };
  });
}

/* ---------------------------------------------------------------- speaking */

function speakAt(k, from = 0) {
  if (studioOn()) return studioSpeak(k, from);
  return phoneSpeak(k, from);
}
function phoneSpeak(k, from = 0) {
  if (!synth) return toast('This browser can\'t read aloud');
  const my = ++L.token;
  const wasBusy = synth.speaking || synth.pending;
  if (wasBusy) synth.cancel();   // Safari can drop a line spoken straight after an unneeded cancel
  if (k >= L.sents.length) { stopL(); L.cur = L.sents.length - 1; toast('The end'); return; }
  L.cur = k; L.from = from; L.word = from; L.playing = true;
  pref.set('lpos:' + L.piece.id, k);
  markSentence(false);
  updatePlayL(); updateTimes(); keepAwake(true);
  const s = L.sents[k];
  const text = s.text.slice(from);
  if (!/\w/.test(text)) return void setTimeout(() => my === L.token && speakAt(k + 1), 0);
  const u = new SpeechSynthesisUtterance(text);
  const v = L.plainVoice ? null : chosenVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-AU';
  u.rate = pref.get('lrate', 1);
  showWord(k, from);
  let started = false;
  u.onstart = () => { started = true; if (!L.heard) { L.heard = true; vlog(`speaking with ${v ? v.name : 'phone default'}`); } };
  // Watchdog: if the phone hasn't started within 3 seconds, try its default voice, then ask.
  setTimeout(() => {
    if (started || my !== L.token || !L.playing) return;
    vlog(`no start after 3s (voice ${v ? v.name : 'default'}, speaking=${synth.speaking}, pending=${synth.pending})`);
    stopL(); L.from = from; noSoundHelp(!!v);
  }, 3000);
  u.onboundary = (e) => { started = true; if (my === L.token && (!e.name || e.name === 'word')) showWord(k, from + e.charIndex); };
  u.onend = () => {
    if (my !== L.token) return;
    if (L.sleepAt && Date.now() >= L.sleepAt) { setLSleep(0); stopL(); L.cur = Math.min(k + 1, L.sents.length - 1); markSentence(false); toast('Sleep timer: stopped'); return; }
    speakAt(k + 1);
  };
  u.onerror = (e) => {
    if (my !== L.token || e.error === 'interrupted' || e.error === 'canceled') return;
    vlog('error: ' + e.error);
    stopL(); toast('The voice stopped (' + e.error + '). Tap play to carry on.');
  };
  // iPhones sometimes drop a new line spoken the instant the old one was stopped.
  // Speak straight away, never after a delay: an iPhone only allows it while the tap is happening.
  synth.speak(u);
  vlog(`speak #${k}${wasBusy ? ' (after stop)' : ''}${v ? ' ' + v.name : ''}`);
}
function stopL() {
  L.token++; L.playing = false;
  if (synth && (synth.speaking || synth.pending)) synth.cancel();
  K.audio.pause();
  updatePlayL(); keepAwake(false);
}
function pauseL() { const at = L.word; stopL(); L.from = at; }
function playL() {
  // Studio voice paused part-way through a line: carry on from the same spot.
  if (studioOn() && K.cur && K.cur.k === L.cur && K.audio.currentTime > 0 && !K.audio.ended && K.audio.getAttribute('src')) {
    L.playing = true; K.cur.my = ++L.token;
    K.audio.play().catch((e) => vlog('play failed: ' + e.message));
    updatePlayL(); keepAwake(true); kTick();
    return;
  }
  speakAt(L.cur, L.from);
}
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

$('#lPlay').onclick = () => { unlockSpeech(); L.playing ? pauseL() : playL(); };
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
  if (el) { unlockSpeech(); L.lastScroll = 0; speakAt(+el.dataset.k); }
});
const lHandScroll = () => { if (!$('#listen').classList.contains('hidden')) L.lastScroll = Date.now(); };
addEventListener('touchmove', lHandScroll, { passive: true });
addEventListener('wheel', lHandScroll, { passive: true });

function updateLSpeed() { $('#lSpeed').textContent = (Math.round(pref.get('lrate', 1) * 100) / 100) + '×'; }
$('#lSpeed').onclick = () => {
  const r = pref.get('lrate', 1), speeds = studioOn() ? [...LSPEEDS, 2.5, 3] : LSPEEDS;
  openSheet(`<h3>Speed</h3><div class="chips">${speeds.map((x) => `<button class="chip ${x === r ? 'on' : ''}" data-r="${x}">${x}×</button>`).join('')}</div>
    <p class="tip">${studioOn() ? 'Studio voices go up to 3×.' : 'Phone voices go up to about 2×. Studio voices (microphone button) go up to 3×.'}</p>`,
  (s) => s.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
    pref.set('lrate', +b.dataset.r); updateLSpeed(); updateTimes(); closeSheet();
    if (studioOn()) K.audio.playbackRate = +b.dataset.r;
    else if (L.playing) speakAt(L.cur, L.word);
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

/* ---------------------------------------------------------------- studio voices */

// The Kokoro voices from the audiobooks, made on the phone a sentence or two ahead of
// where it's reading and played like an audiobook (so the lock screen and AirPods work).
const STUDIO = [['bm_george', 'George', 'British man'], ['bf_emma', 'Emma', 'British woman'], ['bm_lewis', 'Lewis', 'British man'],
  ['bf_isabella', 'Isabella', 'British woman'], ['bm_daniel', 'Daniel', 'British man'], ['af_heart', 'Heart', 'American woman'], ['am_michael', 'Michael', 'American man']];
const AHEAD = 4;   // sentences made ahead of the voice
const K = {
  audio: $('#laudio'), worker: null, ready: null, state: pref.get('kHave', false) ? 'cached' : 'off',
  pct: 0, device: null, err: '', clips: new Map(), queue: [], busy: false, seq: 0, waiters: new Map(), cur: null, raf: 0, unlocked: false,
};
// iPhones and iPads: the studio voice model is too big for their browser (it crashes the
// page), so they use phone voices. Macs and computers can still use studio voices.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// If the last attempt to load studio voices never finished, the page crashed: don't try again.
if (pref.get('kTrying', 0)) { pref.set('kTrying', 0); pref.set('lengine', 'phone'); pref.set('kCrashed', true); }
if (IOS && pref.get('lengine', 'phone') === 'studio') pref.set('lengine', 'phone');
function studioOn() { return !IOS && pref.get('lengine', 'phone') === 'studio'; }
const kVoice = () => pref.get('lkvoice', 'bm_george');

async function kDevice() {
  try { if (navigator.gpu && await navigator.gpu.requestAdapter()) return 'webgpu'; } catch {}
  return 'wasm';
}
const kSize = (d) => (d === 'webgpu' ? 325 : 92);

function kLoad() {
  if (K.ready) return K.ready;
  K.ready = (async () => {
    K.device = await kDevice();
    K.state = 'loading'; K.pct = 0; kStatus();
    pref.set('kTrying', Date.now());
    vlog(`studio: loading (${K.device})`);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    return new Promise((ok, fail) => {
      const bad = (msg) => { pref.set('kTrying', 0); K.state = 'error'; K.err = msg; K.ready = null; vlog('studio error: ' + msg); kStatus(); fail(new Error(msg)); };
      try { K.worker = new Worker('kokoro-worker.js?v=13', { type: 'module' }); } catch (e) { return bad('this phone can\'t run studio voices (' + e.message + ')'); }
      K.worker.onerror = (e) => bad(e.message || 'the voice didn\'t start');
      K.worker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'progress') { K.pct = Math.min(99, Math.round((d.loaded / d.total) * 100)); kStatus(); }
        else if (d.type === 'ready') { K.state = 'ready'; pref.set('kHave', true); pref.set('kTrying', 0); vlog(`studio: ready in ${Math.round(d.ms / 1000)}s`); kStatus(); ok(); }
        else if (d.type === 'audio' || d.type === 'error') {
          if (d.type === 'error' && d.of === 'load') return bad(d.error);
          const w = K.waiters.get(d.id); K.waiters.delete(d.id); K.busy = false;
          if (w) d.type === 'audio' ? w.ok(d) : w.fail(new Error(d.error));
          kPump();
        }
      };
      K.worker.postMessage({ type: 'load', device: K.device });
    });
  })();
  return K.ready;
}

// Show download / loading state in the voice sheet, and in the player while waiting.
function kStatus() {
  const el = document.getElementById('kStat');
  if (el) {
    const size = K.device ? kSize(K.device) : null;
    el.innerHTML =
      K.state === 'ready' ? `<p class="tip" style="margin:0 0 4px">Ready on this phone. Tap a voice to hear it.</p>`
      : K.state === 'loading' ? `<p class="tip" style="margin:0 0 6px">${K.pct ? `Downloading… ${K.pct}%` : 'Getting the voices ready…'} Keep this open. It's only slow the first time.</p><div class="bar"><i style="width:${K.pct}%"></i></div>`
      : K.state === 'error' ? `<p class="tip" style="margin:0 0 6px;color:#b2463c">Couldn't start the studio voices: ${esc(K.err)}</p><div class="sendbar"><button class="primary" id="kGo">Try again</button></div>`
      : K.state === 'cached' ? `<div class="sendbar"><button class="primary" id="kGo">Turn on studio voices</button></div>`
      : `<p class="tip" style="margin:0 0 6px">One-time download${size ? ` of about ${size} MB` : ''}, then they work offline. Use Wi-Fi.</p><div class="sendbar"><button class="primary" id="kGo">Download studio voices</button></div>`;
    const go = el.querySelector('#kGo');
    if (go) go.onclick = () => { kUnlockAudio(); kLoad().catch(() => {}); };
    if (!K.device && K.state !== 'ready') kDevice().then((d) => { if (!K.device) { K.device = d; kStatus(); } });
  }
  if (L.playing && studioOn() && K.state === 'loading' && L.piece) $('#lLeft').textContent = K.pct ? `voice downloading ${K.pct}%` : 'getting the voice ready…';
}

// Ask the background voice maker for one sentence. One at a time, in order.
function kMake(text, voice, key) {
  return new Promise((ok, fail) => {
    const id = ++K.seq;
    K.waiters.set(id, { ok, fail });
    K.queue.push({ id, text, voice, key });
    kPump();
  });
}
function kPump() {
  if (K.busy || !K.queue.length || K.state !== 'ready') return;
  const job = K.queue.shift();
  K.busy = true;
  K.worker.postMessage({ type: 'speak', id: job.id, text: job.text, voice: job.voice, device: K.device });
}

// The audio for sentence k (made once, kept while the piece is open).
function kClip(k) {
  const key = kVoice() + '|' + k;
  if (!K.clips.has(key)) {
    const text = L.sents[k].text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const p = kLoad().then(() => kMake(text, kVoice(), key)).then((d) => {
      vlog(`made #${k}: ${d.secs.toFixed(1)}s of voice in ${(d.ms / 1000).toFixed(1)}s`);
      return { url: URL.createObjectURL(new Blob([d.wav], { type: 'audio/wav' })), secs: d.secs };
    });
    p.catch(() => { if (K.clips.get(key) === p) K.clips.delete(key); });
    K.clips.set(key, p);
  }
  return K.clips.get(key);
}
function kAhead(k) {
  for (let j = k; j < Math.min(L.sents.length, k + 1 + AHEAD); j++) if (/\w/.test(L.sents[j].text)) kClip(j);
  // Let go of lines well behind the voice.
  for (const [key, p] of K.clips) {
    const j = +key.split('|')[1];
    if (j < k - 3 || j > k + AHEAD + 6 || !key.startsWith(kVoice() + '|')) {
      // Not started yet: drop it from the queue too.
      K.clips.delete(key);
      p.then((c) => URL.revokeObjectURL(c.url)).catch(() => {});
    }
  }
}
function kClearQueue() {
  for (const job of K.queue) {
    if (job.key) K.clips.delete(job.key);   // now, so the new spot asks for it afresh
    const w = K.waiters.get(job.id); K.waiters.delete(job.id); if (w) w.fail(new Error('skipped'));
  }
  K.queue = [];
}

// iPhones only let a page play sound that starts during a tap: play a moment of silence
// on the first tap, and the same player can then carry on by itself.
function kUnlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (K.unlocked) return;
  K.unlocked = true;
  const sr = 8000, n = 800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  K.audio.src = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  K.audio.play().then(() => vlog('player unlocked'), (e) => vlog('player unlock failed: ' + e.message));
}

// Where the voice is in a line: words weighted by length, with pauses at punctuation.
function kWeights(text) {
  const out = [], re = /\S+/g; let m, total = 0;
  while ((m = re.exec(text))) {
    const w = m[0].length + 2 + (/[.!?]["'”’)]*$/.test(m[0]) ? 8 : /[,;:—–]$/.test(m[0]) ? 4 : 0);
    out.push({ at: m.index, from: total }); total += w;
  }
  out.forEach((x) => (x.from /= total || 1));
  return out;
}
function kCharAt(k, frac) {
  const ws = kWeights(L.sents[k].text);
  let at = 0;
  for (const x of ws) { if (x.from <= frac) at = x.at; else break; }
  return at;
}
function kFracAt(k, ch) {
  const ws = kWeights(L.sents[k].text);
  let f = 0;
  for (const x of ws) { if (x.at <= ch) f = x.from; else break; }
  return f;
}
function kTick() {
  cancelAnimationFrame(K.raf);
  const step = () => {
    if (!L.playing || !studioOn() || !K.cur || K.audio.paused) return;
    const d = K.audio.duration || K.cur.secs;
    if (d) showWord(K.cur.k, kCharAt(K.cur.k, K.audio.currentTime / d));
    K.raf = requestAnimationFrame(step);
  };
  K.raf = requestAnimationFrame(step);
}

function studioSpeak(k, from = 0) {
  const my = ++L.token;
  if (synth && (synth.speaking || synth.pending)) synth.cancel();
  K.audio.pause();
  kUnlockAudio();
  if (k >= L.sents.length) { stopL(); L.cur = L.sents.length - 1; toast('The end'); return; }
  L.cur = k; L.from = from; L.word = from; L.playing = true;
  pref.set('lpos:' + L.piece.id, k);
  markSentence(false);
  updatePlayL(); updateTimes(); keepAwake(true);
  if (!/\w/.test(L.sents[k].text)) return void setTimeout(() => my === L.token && studioSpeak(k + 1), 0);
  showWord(k, from);
  if (K.cur && Math.abs(K.cur.k - k) > 1) kClearQueue();   // jumped: forget lines queued for the old spot
  kAhead(k);
  const waitMsg = setTimeout(() => { if (my === L.token) $('#lLeft').textContent = K.state === 'ready' ? 'making the voice…' : 'getting the voice ready…'; }, 500);
  kClip(k).then((c) => {
    clearTimeout(waitMsg);
    if (my !== L.token) return;
    K.cur = { k, secs: c.secs, my };
    K.audio.src = c.url;
    K.audio.playbackRate = pref.get('lrate', 1);
    K.audio.preservesPitch = true;
    const start = from ? kFracAt(k, from) * c.secs : 0;
    const go = () => {
      if (my !== L.token) return;
      if (start) try { K.audio.currentTime = start; } catch {}
      K.audio.play().then(() => { updateTimes(); kTick(); }, (e) => {
        vlog('play blocked: ' + e.message);
        stopL(); toast('Tap play to start the voice');
      });
    };
    if (K.audio.readyState >= 1) go(); else K.audio.addEventListener('loadedmetadata', go, { once: true });
  }, (e) => {
    clearTimeout(waitMsg);
    if (my !== L.token || e.message === 'skipped') return;
    stopL(); updateTimes();
    toast('Studio voice problem: ' + e.message);
  });
}
K.audio.addEventListener('ended', () => {
  if (!K.cur || K.cur.my !== L.token || !L.playing || !studioOn()) return;
  const k = K.cur.k;
  if (L.sleepAt && Date.now() >= L.sleepAt) { setLSleep(0); stopL(); L.cur = Math.min(k + 1, L.sents.length - 1); markSentence(false); toast('Sleep timer: stopped'); return; }
  studioSpeak(k + 1);
});
K.audio.addEventListener('pause', () => cancelAnimationFrame(K.raf));

// "Hello" in the chosen studio voice.
function kSample() {
  const my = ++L.token;
  kUnlockAudio();
  kLoad().then(() => kMake('Hello Joel. This is how I sound reading to you.', kVoice())).then((d) => {
    if (my !== L.token) return;
    K.cur = null;
    K.audio.src = URL.createObjectURL(new Blob([d.wav], { type: 'audio/wav' }));
    K.audio.playbackRate = 1;
    K.audio.play().catch(() => {});
  }, () => {});
}

// Lock screen and AirPods: play/pause, and next/previous for a sentence (studio voices).
function setupListenMedia() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession, set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => playL());
  set('pause', () => pauseL());
  set('nexttrack', () => $('#lNext').onclick());
  set('previoustrack', () => $('#lPrev').onclick());
  set('seekto', null); set('seekforward', null); set('seekbackward', null);
  try { ms.metadata = new MediaMetadata({ title: L.piece.title, artist: 'Read Along · Listen' }); } catch {}
}
