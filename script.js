// AS-IS Discovery frontend — build v4 (run lock, drive delete, evidence pipeline)
const WEBHOOK_URL = "https://dtsolutions.app.n8n.cloud/webhook/683536ba-dc5c-4796-89e0-b497f8fa92a4";
// ── Server session endpoints (build these in n8n — see BACKEND-CHANGES.md) ──
// SESSIONS_URL  : GET  → [{ sessionId, title, updatedAt, departments }]  (list for the sidebar)
// LOAD_URL      : POST { sessionId } → { sessionId, title, companyName, departments, received, transcript:[{role,text,time,files}] }
// DELETE_URL    : POST { sessionId } → { ok:true }   (optional; if absent, delete is local-only)
// Leave a URL empty ('') to disable that server call and fall back to the browser cache.
const SESSIONS_URL = "https://dtsolutions.app.n8n.cloud/webhook/as-is-sessions";
const LOAD_URL = "https://dtsolutions.app.n8n.cloud/webhook/as-is-load";
const DELETE_URL = "https://dtsolutions.app.n8n.cloud/webhook/as-is-delete";
// STOP_URL    : POST { sessionId, text, kind, since } → { stopped:true, note } | { stopped:false, reason:'finished'|'none' }
const STOP_URL = "https://dtsolutions.app.n8n.cloud/webhook/as-is-stop";
const STORAGE_KEY = 'as_is_discovery_sessions';   // cache only — the server is the source of truth
const MAX_FILE_SIZE = 8 * 1024 * 1024;

let serverIndex = {};   // sessionId -> { sessionId, title, updatedAt, departments }  from SESSIONS_URL
let serverUp = false;   // did the last sidebar refresh reach the server?

let sessionId = generateSessionId();
let isLoading = false;
let currentMessages = [];
let attachedFiles = [];
let receivedDepartments = [];
let departments = [];           // [{name, folderName, received, assessed, automation, awaitingAnswers}]
let companyName = '';
let runningDept = null;         // department key currently being assessed (UI only)
let prevState = {};             // folderName -> state, to animate changes
let enterprise = null;          // normalised enterprise state from the server (see normEnt)
let entRun = null;              // { step } while an enterprise run is in flight (UI only)
let recoverToken = 0;           // cancels a background "did it finish?" check when a new message is sent
let recovering = 0;             // >0 while checking whether a run finished on the server
let bgWatch = null;             // { sid, token } while an enterprise run started elsewhere is still going on the server
let activeRun = null;           // { controller, sid, text, kind, since, startMs, stopping } while a request is in flight

// Cross Department is permanent but optional: while it has no documents it never blocks anything.
const isCross = d => /^\s*cross[\s_-]*department\s*$/i.test(String((d && d.name) || ''));
const countable = d => !(isCross(d) && !d.received);
const busy = () => !!(activeRun || isLoading || recovering || bgWatch || entRun);

const $ = id => document.getElementById(id);
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Init ──
renderEmpty();
renderSidebar();
renderBoard();
updateSessionLabel();
setupDragDrop();
refreshSidebarFromServer();   // pull the authoritative session list; falls back to cache on failure

// ── Storage ──
function loadAllChats() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
function saveChat(id, data) { const all = loadAllChats(); all[id] = data; localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
function deleteChat(id) { const all = loadAllChats(); delete all[id]; localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
function saveCurrentConversation() {
  if (!currentMessages.length) return;
  const existing = loadAllChats()[sessionId] || {};
  saveChat(sessionId, {
    sessionId, title: companyName || existing.title || deriveTitle(), messages: currentMessages,
    received: receivedDepartments, departments, enterprise, companyName, updatedAt: Date.now()
  });
  renderSidebar();
}
function deriveTitle() {
  const first = currentMessages.find(m => m.role === 'user');
  if (!first) return 'Untitled session';
  return first.text.length > 40 ? first.text.slice(0, 40) + '…' : first.text;
}

// ── Server session index (authoritative) with cache fallback ──
async function refreshSidebarFromServer() {
  if (!SESSIONS_URL) { serverUp = false; renderSidebar(); return; }
  try {
    const res = await fetch(SESSIONS_URL, { method: 'GET' });
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    const list = Array.isArray(rows) ? rows : (rows.sessions || []);
    serverIndex = {};
    list.forEach(r => { if (r && r.sessionId) serverIndex[r.sessionId] = r; });
    serverUp = true;
  } catch { serverUp = false; }   // server unreachable → sidebar shows the local cache
  renderSidebar();
}
// Merge the server index with the local cache. Server rows win; cache-only rows are shown too so a
// session started while the endpoint was down is not hidden. Everything is keyed by sessionId.
function mergedSessions() {
  const cache = loadAllChats();
  const out = {};
  Object.values(cache).forEach(e => { if (e && e.sessionId) out[e.sessionId] = { ...e, _src: 'cache' }; });
  Object.values(serverIndex).forEach(r => {
    const prev = out[r.sessionId] || {};
    out[r.sessionId] = { ...prev, ...r, updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : prev.updatedAt || Date.now(), _src: 'server' };
  });
  return Object.values(out);
}

// ── Sidebar ──
function renderSidebar() {
  const list = $('sidebar-list');
  const entries = mergedSessions().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!entries.length) { list.innerHTML = '<div class="session-empty">Sessions you start will be listed here so you can come back to a company later.</div>'; return; }
  const day = 86400000, now = Date.now();
  const groups = [['Today', entries.filter(e => now - e.updatedAt < day)], ['Earlier', entries.filter(e => now - e.updatedAt >= day)]];
  list.innerHTML = groups.filter(g => g[1].length).map(([label, items]) =>
    `<div class="session-group">${label}</div>` + items.map(e => {
      const depts = (e.departments || []).filter(countable), assessed = depts.filter(d => d.assessed).length, docs = depts.filter(d => d.received).length;
      const meta = depts.length ? `<b>${assessed}/${depts.length}</b> assessed` : 'no company yet';
      return `<div class="session ${e.sessionId === sessionId ? 'active' : ''}" onclick="loadConversation('${e.sessionId}')">
        <div class="session-title">${esc(e.title)}</div>
        <div class="session-meta"><span>${relTime(e.updatedAt)}</span><span>${meta}</span></div>
        <button class="session-del" onclick="event.stopPropagation(); confirmDelete('${e.sessionId}')" title="Delete session">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button></div>`;
    }).join('')).join('');
}
function relTime(ts) { const d = Date.now() - ts; if (d < 6e4) return 'just now'; if (d < 36e5) return Math.floor(d / 6e4) + 'm ago'; if (d < 864e5) return Math.floor(d / 36e5) + 'h ago'; return Math.floor(d / 864e5) + 'd ago'; }

async function loadConversation(id) {
  saveCurrentConversation();
  // Prefer the server (survives a hard browser reset / a different device); fall back to the cache.
  let entry = null, fromServer = false;
  if (LOAD_URL) {
    try {
      const res = await fetch(LOAD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
      if (res.ok) { const d = await res.json(); if (d && (d.transcript || d.departments)) { entry = { sessionId: id, messages: d.transcript || [], received: d.received || [], departments: d.departments || [], enterprise: d.enterprise || null, companyName: d.companyName || d.title || '', enterpriseRunning: !!d.enterpriseRunning }; fromServer = true; } }
    } catch { /* fall through to cache */ }
  }
  if (!entry) entry = loadAllChats()[id];
  if (!entry) { addNote('error', "Couldn't load that session from the server, and it isn't cached in this browser."); return; }

  sessionId = id; currentMessages = entry.messages || []; receivedDepartments = entry.received || [];
  departments = entry.departments || []; companyName = entry.companyName || ''; runningDept = null; prevState = {};
  recoverToken++; entRun = null; bgWatch = null; enterprise = resolveEnterprise(entry.enterprise);
  $('messages').innerHTML = '';
  addNote('info', `Session resumed — ${currentMessages.length} messages${fromServer ? '' : ' (from this browser)'}`);
  currentMessages.forEach(m => renderMessage(m.role, m.text, m.time, m.files));
  departments.forEach(d => prevState[d.folderName] = stateOf(d));
  saveCurrentConversation();   // refresh the local cache from what we just loaded
  updateSessionLabel(); renderBoard(); renderSidebar(); scrollBottom();
  if (entry.enterpriseRunning) watchBackgroundRun(id);
}
function newConversation() {
  saveCurrentConversation();
  sessionId = generateSessionId(); currentMessages = []; receivedDepartments = []; departments = []; companyName = ''; runningDept = null; prevState = {}; isLoading = false;
  enterprise = null; entRun = null; recoverToken++; bgWatch = null;
  attachedFiles = []; renderAttachments();
  $('user-input').value = ''; $('send-btn').disabled = true; $('status-dot').className = 'conn';
  renderEmpty(); updateSessionLabel(); renderBoard(); renderSidebar();
}
function confirmDelete(id) {
  const msg = DELETE_URL ? "Delete this session and move its company folder in Google Drive to the trash?\n\nDrive keeps trashed folders for 30 days, so it can be restored. If another session uses the same folder, the folder is kept."
                         : 'Delete this session from this browser? The server copy (if any) is kept. Files in Drive are not affected.';
  if (!confirm(msg)) return;
  deleteChat(id);
  if (DELETE_URL) { fetch(DELETE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) })
    .then(r => r.ok ? r.json() : null).then(r => { delete serverIndex[id]; renderSidebar(); if (r && r.reason && !r.folderTrashed && !/no Drive folder/.test(r.reason)) alert(r.reason); })
    .catch(() => alert("The session was removed here, but the server couldn't be reached — its Drive folder was not trashed.")); }
  id === sessionId ? newConversation() : renderSidebar();
}

// ── Messagess ──
function renderEmpty() {
  $('messages').innerHTML = `<div class="empty" id="empty-state">
    <h2>Which company are we assessing?</h2>
    <p>Tell me the company and its departments. I'll set up the Drive folders, file every document you attach into the right department, and run each department's assessment when you say so.</p>
    <div class="chips">
      <button class="chip" onclick="useChip(this)">Assessment for ABC Ltd — Legal, Finance, HR</button>
      <button class="chip" onclick="useChip(this)">What do you need from each department?</button>
    </div></div>`;
}
function renderMessage(role, text, time, files) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const filesHtml = files && files.length ? `<div class="files-sent">${files.map(f => `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>${esc(f)}</span>`).join('')}</div>` : '';
  el.innerHTML = `<div class="avatar">${role === 'user' ? 'You' : 'AI'}</div><div><div class="bubble">${role === 'agent' ? md(text) : (esc(text) || '')}${filesHtml}</div><div class="stamp">${time || ''}</div></div>`;
  $('messages').appendChild(el);
}
function addMessage(role, text, files) {
  const es = $('empty-state'); if (es) es.remove();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  renderMessage(role, text, time, files);
  currentMessages.push({ role, text, time, files });
  scrollBottom();
}
function addNote(type, html, id) {
  const el = document.createElement('div');
  el.className = 'note' + (type === 'error' ? ' error' : type === 'working' ? ' working' : '');
  if (id) el.id = id;
  el.innerHTML = html;
  $('messages').appendChild(el); scrollBottom(); return el;
}
function showTyping() {
  const es = $('empty-state'); if (es) es.remove();
  const el = document.createElement('div'); el.className = 'typing'; el.id = 'typing';
  el.innerHTML = `<div class="avatar" style="background:var(--docs-soft);color:var(--docs)">AI</div><div class="bubble"><i></i><i></i><i></i></div>`;
  $('messages').appendChild(el); scrollBottom();
}
function removeTyping() { const t = $('typing'); if (t) t.remove(); }

// Markdown-lite for agent replies: **bold**, `code`, bullet lines. Escaped first, so it is safe.
function md(text) {
  const lines = esc(text || '').split('<br>');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const m = line.match(/^\s*(?:•|-|\*|\d+\.)\s+(.*)$/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (line.trim()) html += `<p>${line}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}

// ── Attachments ──
function onFilesSelected(fileList) { addFiles(Array.from(fileList)); $('file-input').value = ''; }
function addFiles(files) {
  const rejected = [];
  Promise.all(files.map(file => {
    if (file.size > MAX_FILE_SIZE) { rejected.push(`${file.name} (over 8 MB)`); return null; }
    return new Promise(res => { const r = new FileReader(); r.onload = () => res({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: r.result.split(',')[1] }); r.onerror = () => { rejected.push(file.name); res(null); }; r.readAsDataURL(file); });
  })).then(results => {
    results.filter(Boolean).forEach(f => attachedFiles.push(f));
    if (rejected.length) addNote('error', 'Skipped: ' + rejected.map(esc).join(', '));
    renderAttachments(); syncSend();
  });
}
function removeAttachedFile(i) { attachedFiles.splice(i, 1); renderAttachments(); syncSend(); }
function renderAttachments() {
  $('file-preview-row').innerHTML = attachedFiles.map((f, i) => `<div class="file-chip"><span title="${esc(f.name)}">${esc(f.name.length > 28 ? f.name.slice(0, 25) + '…' : f.name)}</span><small>${fmtSize(f.size)}</small><button onclick="removeAttachedFile(${i})" title="Remove">✕</button></div>`).join('');
}
function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
function setupDragDrop() {
  const chat = $('chat'), veil = $('drop-veil'); let depth = 0;
  chat.addEventListener('dragenter', e => { e.preventDefault(); depth++; veil.classList.add('on'); });
  chat.addEventListener('dragover', e => e.preventDefault());
  chat.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; veil.classList.remove('on'); } });
  chat.addEventListener('drop', e => { e.preventDefault(); depth = 0; veil.classList.remove('on'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files)); });
}

// ── Send ──
const RUN_STEPS = ['Reading the Input folder', 'Extracting text from documents', 'Building the AS-IS registers', 'Checking for gaps', 'Scoring automation', 'Identifying requirements', 'Writing the Excel workbooks', 'Saving to 02 - Outputs'];
async function sendMessage() {
  const input = $('user-input'), text = input.value.trim();
  if ((!text && !attachedFiles.length) || isLoading) return;
  isLoading = true; input.value = ''; input.style.height = 'auto'; $('send-btn').disabled = true;
  const files = attachedFiles; attachedFiles = []; renderAttachments();

  const chatInput = text || `Please file these documents: ${files.map(f => f.name).join(', ')}.`;
  addMessage('user', text, files.map(f => f.name));
  showTyping();
  $('status-dot').className = 'conn busy';

  // Enterprise run: same trigger phrases the backend routes on (Prepare Input → enterpriseIntent).
  const entRunNow = ENTERPRISE_RE.test(text) && !files.length && departments.length > 0;
  // Assessment run: show which department and cycle through the pipeline stages while we wait.
  const assess = !entRunNow && /^\s*(start|run|assess|evaluate|begin|launch)\b/i.test(text) && !files.length;
  const answering = !entRunNow && departments.some(d => d.awaitingAnswers) && !assess && !files.length;
  const sentAt = Date.now(), sentSid = sessionId, myToken = ++recoverToken;
  const controller = new AbortController();
  activeRun = { controller, sid: sessionId, text: chatInput, kind: entRunNow ? 'enterprise' : (assess || answering) ? 'assess' : 'other',
                since: new Date(sentAt).toISOString(), startMs: sentAt, stopping: false };
  setSendMode(true);
  let stepTimer = null;
  if (entRunNow) {
    entRun = { step: 0 }; renderBoard();
    const note = addNote('working', `<i></i><span class="step">${ENT_STEPS[0]}…</span><span>this takes a few minutes — keep this tab open</span>`, 'working-note');
    stepTimer = setInterval(() => {
      if (!entRun) return;
      entRun.step = Math.min(entRun.step + 1, ENT_STEPS.length - 1);
      note.querySelector('.step').textContent = ENT_STEPS[entRun.step] + '…'; renderEnterprise();
    }, 18000);
  } else if (assess || answering) {
    const target = departments.find(d => text.toLowerCase().includes(d.name.toLowerCase())) || departments.find(d => d.awaitingAnswers);
    if (target) { runningDept = target.folderName; renderBoard(); }
    let i = answering ? 3 : 0;
    const note = addNote('working', `<i></i><span class="step">${RUN_STEPS[i]}…</span><span>this takes a few minutes — keep this tab open</span>`, 'working-note');
    stepTimer = setInterval(() => { i = Math.min(i + 1, RUN_STEPS.length - 1); note.querySelector('.step').textContent = RUN_STEPS[i] + '…'; }, 18000);
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ chatInput, sessionId, files: files.map(f => ({ name: f.name, mimeType: f.type, data: f.data })) })
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    removeTyping(); $('status-dot').className = 'conn connected';
    addMessage('agent', data.response || data.output || data.message || JSON.stringify(data));
    if (Array.isArray(data.receivedDepartments)) receivedDepartments = data.receivedDepartments;
    if (Array.isArray(data.departments)) departments = data.departments;
    if (typeof data.companyName === 'string') companyName = data.companyName;
    enterprise = resolveEnterprise(data.enterprise);
    if (data.enterpriseRunning) watchBackgroundRun(sessionId);
  } catch (err) {
    removeTyping();
    if (err.name === 'AbortError') { /* the user pressed Stop — stopRun() reports the outcome */ }
    else {
    const longRun = entRunNow || assess || answering;
    if (longRun) {
      // Long runs outlast the n8n Cloud request limit (~100 s). The run keeps going on the server — expected, not an error.
      recoverAfterError(sentSid, sentAt, myToken);
    } else {
      $('status-dot').className = 'conn error';
      addNote('error', `Couldn't reach the assistant (${esc(err.message)}). Check that the n8n workflow is active and try again.`);
    }
    }
  } finally {
    if (stepTimer) clearInterval(stepTimer);
    const w = $('working-note'); if (w) w.remove();
    runningDept = null; entRun = null; activeRun = null; setSendMode(false);
  }
  renderBoard(); updateSessionLabel(); saveCurrentConversation();
  refreshSidebarFromServer();   // pick up the server's title/updatedAt for this session
  isLoading = false; syncSend(); renderBoard();
}

// ── Department board ──
function stateOf(d) { return d.assessed ? 'done' : d.awaitingAnswers ? 'wait' : d.received ? 'docs' : 'none'; }
function renderBoard() {
  $('board-company').textContent = companyName || 'No company yet';
  const list = $('board-list'), foot = $('board-foot');
  if (!departments.length) {
    list.innerHTML = '<div class="board-empty">Departments appear here once a company is set up. Each one moves through three stages: documents filed, your answers to any questions, and the completed assessment.</div>';
    foot.textContent = ''; $('board-count').textContent = 'Departments'; return;
  }
  list.innerHTML = departments.map(d => {
    const st = stateOf(d), running = runningDept === d.folderName, prev = prevState[d.folderName];
    const changed = prev !== undefined && prev !== st;
    const flash = changed ? (st === 'done' ? ' flash-done' : ' flash') : '';
    const seg = (cls, on, run) => `<div class="seg ${cls}${on ? ' on' : ''}${run ? ' running' : ''}"><i></i></div>`;
    const cross = isCross(d);
    const stateText = running ? 'assessing…' : st === 'done' ? 'assessed' : st === 'wait' ? 'waiting for your answers' : st === 'docs' ? `${d.files || 1} file${(d.files || 1) === 1 ? '' : 's'} filed` : cross ? 'optional — no shared documents yet' : 'no documents yet';
    const pct = st === 'done' ? `<div class="dept-pct" data-count="${d.automation ?? 0}" title="Calibrated automation level (0 / 10 / 30 / 50 / 70 / 100)">${changed && !REDUCED ? 0 : (d.automation ?? 0)}<small>level</small></div>` : '';
    const dis = busy() ? ' disabled title="Wait for the current request to finish"' : '';
    const action = running ? `<button class="stop-btn" onclick="stopRun()">Stop</button>` : st === 'docs' ? `<button onclick="quickSend('Start ${escAttr(d.name)}')"${dis}>Start ${esc(d.name)} assessment</button>` : st === 'done' ? `<button onclick="quickSend('Start ${escAttr(d.name)}')"${dis}>Run again</button>` : st === 'none' ? `<button onclick="document.getElementById('file-input').click()">Attach ${cross ? 'cross-department' : esc(d.name)} documents</button>` : '';
    return `<div class="dept${flash}${cross ? ' cross' : ''}${running ? ' is-running' : ''}" data-folder="${escAttr(d.folderName)}">
      <div class="dept-top"><div class="dept-name"><span class="dept-folder">${esc(d.folderName.split(' - ')[0])}</span>${esc(d.name)}</div>${pct}</div>
      <div class="rail">${seg('docs', st !== 'none')}${seg('wait', st === 'wait' || st === 'done', running)}${seg('done', st === 'done')}</div>
      <div class="dept-sub"><span class="state ${st}">${stateText}</span><span>${st === 'done' ? 'files in 02 - Outputs' : ''}</span></div>${cross ? '<div class="cross-note">Documents that cover two or more departments are filed here automatically.</div>' : ''}
      <div class="dept-act">${action}</div></div>`;
  }).join('') + (departments.some(isCross) ? '' : `<div class="dept cross missing">
      <div class="dept-top"><div class="dept-name">Cross Department</div></div>
      <div class="cross-note">Not set up for this company yet. It holds documents that cover two or more departments; I'll file them there automatically once it exists.</div>
      <div class="dept-act show"><button onclick="quickSend('Add Cross Department')" ${busy() ? 'disabled' : ''}>Add Cross Department folder</button></div></div>`);
  // count-up for newly assessed departments
  list.querySelectorAll('.dept-pct').forEach(el => { const target = Number(el.dataset.count); if (Number(el.firstChild.textContent) !== target) countUp(el, target); });
  departments.forEach(d => prevState[d.folderName] = stateOf(d));
  const counted = departments.filter(countable);
  const assessed = counted.filter(d => d.assessed), docs = counted.filter(d => d.received).length;
  // Cross Department is a cross-functional domain, not a department: it is never part of the department average.
  const orgAssessed = assessed.filter(d => !isCross(d));
  const avg = orgAssessed.length ? Math.round(orgAssessed.reduce((a, d) => a + (Number(d.automation) || 0), 0) / orgAssessed.length * 10) / 10 : null;
  renderEnterprise();
  foot.innerHTML = `<b>${assessed.length} of ${counted.length}</b> assessed · ${docs} with documents${avg !== null ? ` · raw average of department levels <b>${avg}</b>` : ''}`;
  $('board-count').textContent = `${assessed.length}/${counted.length} assessed`;
}
// ── Enterprise card ──
const ENTERPRISE_RE = /(enterprise\s+assessment|enterprise\s+report|consolidat)/i;
const ENT_STEPS = ['Collecting each department\'s results', 'Consolidating the AS-IS', 'Rolling up automation', 'Consolidating requirements', 'Scoring the 77 building blocks', 'Writing the enterprise workbooks', 'Saving to Enterprise Assessment'];

// Same shape the backend's entView() returns; tolerant of the older { assessed, automation, ... } payload.
function normEnt(e) {
  e = e || {};
  const n = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
  const arr = v => Array.isArray(v) ? v : [];
  return {
    assessed: !!e.assessed, status: e.status === 'validation_failed' ? 'failed' : (e.status || (e.assessed ? 'complete' : 'not_run')),
    validationFailed: e.status === 'validation_failed' || !!e.validationFailed, failedStage: e.failedStage || '',
    overallStatus: e.overallStatus || '', componentStatus: (e.componentStatus && typeof e.componentStatus === 'object') ? e.componentStatus : null,
    automationRawAverage: n(e.automationRawAverage), crossDomainsCount: n(e.crossDomainsCount), blocksInsufficientEvidence: n(e.blocksInsufficientEvidence),
    automation: n(e.automation), maturityLevel: e.maturityLevel || '', maturityScore: n(e.maturityScore),
    blocksAssessed: n(e.blocksAssessed), blocksTotal: n(e.blocksTotal), blocksNotRelevant: n(e.blocksNotRelevant),
    departmentsCount: n(e.departmentsCount), files: arr(e.files), filesExpected: n(e.filesExpected),
    issues: arr(e.issues), notes: arr(e.notes), incompleteDepartments: arr(e.incompleteDepartments),
    lastError: e.lastError || '', completedAt: e.completedAt || null, lastRunAt: e.lastRunAt || e.completedAt || null
  };
}
// Server state first. If the server has nothing (older backend that dropped `enterprise` from its reply),
// rebuild it from the enterprise messages already in the chat so a finished run is never shown as "not run yet".
function resolveEnterprise(serverEnt) {
  const e = normEnt(serverEnt);
  if (e.assessed || e.status !== 'not_run') return e;
  return enterpriseFromTranscript(currentMessages) || e;
}
function enterpriseFromTranscript(msgs) {
  let latest = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]; if (!m || m.role !== 'agent') continue;
    const t = String(m.text || ''), when = isoOf(m.time);
    if (/^\s*Enterprise Digital Maturity Assessment (complete|finished)/i.test(t) && /Enterprise calibrated automation level:/i.test(t)) {
      // Current message format (raw average and calibrated level are separate lines).
      const num = re => { const x = t.match(re); return x ? Number(x[1]) : null; };
      const list = head => { const p = t.split(head)[1]; if (!p) return []; return p.split('\n').slice(1).map(l => l.trim()).filter((l, k, a) => l && a.slice(0, k + 1).every(x => /^[•\-*]/.test(x))).map(l => l.replace(/^[•\-*]\s*/, '')); };
      const overall = (t.match(/Overall Assessment Status:\s*([A-Z_]+)/i) || [])[1] || '';
      const mat = t.match(/Average maturity of (\d+) sufficiently evidenced building blocks = ([\d.]+) \/ 5\. \d+ of (\d+)/i);
      const ok = normEnt({ assessed: true, status: overall === 'INCOMPLETE' ? 'partial' : 'complete', overallStatus: overall,
        automation: num(/Enterprise calibrated automation level:\s*([\d.]+)/i), automationRawAverage: num(/Enterprise raw average:\s*([\d.]+)/i),
        maturityScore: mat ? Number(mat[2]) : null, blocksAssessed: mat ? Number(mat[1]) : null, blocksTotal: mat ? Number(mat[3]) : null,
        blocksInsufficientEvidence: num(/(\d+) building block\(s\) remain insufficiently evidenced/i),
        departmentsCount: num(/Consolidated (\d+) organizational department/i), crossDomainsCount: num(/\+ (\d+) cross-functional process domain/i),
        files: list(/Files saved[^\n]*/i), issues: list(/Issues \/ limitations:/i), completedAt: when });
      return latest ? { ...ok, status: latest.status, lastError: latest.lastError, validationFailed: latest.validationFailed, failedStage: latest.failedStage, incompleteDepartments: latest.incompleteDepartments, lastRunAt: latest.lastRunAt } : ok;
    }
    if (/^\s*Enterprise Digital Maturity Assessment (complete|finished with gaps)/i.test(t)) {
      const num = re => { const x = t.match(re); return x ? Number(x[1]) : null; };
      const mat = t.match(/Digital maturity:\s*(.*?)\s*\(([\d.]+|N\/A) of 5\),\s*(\d+) of (\d+) building blocks/i);
      const list = head => { const p = t.split(head)[1]; if (!p) return []; return p.split('\n').slice(1).map(l => l.trim()).filter((l, k, a) => l && a.slice(0, k + 1).every(x => /^[•\-*]/.test(x))).map(l => l.replace(/^[•\-*]\s*/, '')); };
      const issues = list(/What's incomplete:/i), files = list(/Files saved[^\n]*/i);
      const auto = num(/Enterprise automation:\s*([\d.]+)%/i);
      if (auto == null && !issues.length) issues.push('Enterprise automation score could not be calculated.');
      const ok = normEnt({
        assessed: true, status: issues.length ? 'partial' : 'complete', automation: auto,
        maturityLevel: mat && mat[1] !== 'N/A' ? mat[1] : '', maturityScore: mat && mat[2] !== 'N/A' ? Number(mat[2]) : null,
        blocksAssessed: mat ? Number(mat[3]) : null, blocksTotal: mat ? Number(mat[4]) : null,
        departmentsCount: num(/Consolidated (\d+) departments/i), files, issues, completedAt: when
      });
      return latest ? { ...ok, status: latest.status, lastError: latest.lastError, incompleteDepartments: latest.incompleteDepartments, lastRunAt: latest.lastRunAt } : ok;
    }
    if (latest) continue;   // already found the latest attempt; keep looking only for the last good result
    if (/^\s*Enterprise assessment stopped — /i.test(t))
      latest = normEnt({ status: 'validation_failed', failedStage: (t.match(/stopped — (.*?) did not pass/i) || [])[1] || '', lastError: t.split('\n').filter(l => /^\s*•/.test(l)).map(l => l.replace(/^\s*•\s*/, '')).join(' ') || 'Validation did not pass.', lastRunAt: when });
    else if (/^\s*Stopped the enterprise assessment/i.test(t))
      latest = normEnt({ status: 'stopped', lastError: 'Stopped by you.', lastRunAt: when });
    else if (/^\s*The enterprise assessment could not be completed:?\s*/i.test(t))
      latest = normEnt({ status: 'failed', lastError: t.replace(/^\s*The enterprise assessment could not be completed:?\s*/i, '').split('\n')[0], lastRunAt: when });
    else if (/^\s*Enterprise assessment not started/i.test(t)) {
      const inc = (t.match(/Still incomplete:\s*([^.\n]*)/i) || [])[1] || '';
      latest = normEnt({ status: 'blocked', incompleteDepartments: inc.split(',').map(x => x.trim()).filter(x => x && x !== 'none'), lastRunAt: when });
    }
  }
  return latest;
}
function isoOf(t) { const d = new Date(t); return isNaN(d) ? null : d.toISOString(); }

function entState() {
  const e = enterprise || normEnt(null);
  const total = departments.filter(countable).length, done = departments.filter(d => countable(d) && d.assessed).length;
  if (entRun) return 'running';
  if (e.status === 'stopped') return 'stopped';
  if (e.status === 'failed') return 'failed';
  if (e.status === 'blocked' && done < total) return 'blocked';
  if (e.assessed) return e.status === 'partial' ? 'partial' : 'complete';
  return (total && done === total) ? 'ready' : 'locked';
}
function renderEnterprise() {
  const list = $('board-list'); if (!list || !departments.length) return;
  let card = $('ent-card');
  if (!card) { card = document.createElement('div'); card.id = 'ent-card'; list.appendChild(card); }
  const e = enterprise || normEnt(null), st = entState();
  const total = departments.filter(countable).length, done = departments.filter(d => countable(d) && d.assessed).length;
  const hasResult = e.assessed;
  const consolidated = e.departmentsCount != null ? e.departmentsCount + (e.crossDomainsCount || 0) : null;   // org departments + cross-functional domains
  const stale = hasResult && consolidated != null && done > consolidated;
  const scorable = e.blocksTotal != null ? e.blocksTotal - (e.blocksNotRelevant || 0) : null;
  const limited = hasResult && e.overallStatus === 'COMPLETE_WITH_LIMITATIONS';
  const blockFrac = hasResult && scorable ? Math.min(1, (e.blocksAssessed || 0) / scorable) : hasResult ? 1 : 0;

  // Three stages: departments ready → consolidation (AS-IS, automation, requirements) → 77-block maturity.
  const seg = (frac, tone, run, title) => `<div class="seg ent-seg ${tone}${run ? ' running' : ''}" title="${escAttr(title)}"><i style="transform:scaleX(${run ? 1 : frac})"></i></div>`;
  const runStage = entRun ? (entRun.step < 4 ? 2 : 3) : 0;
  const bad = st === 'failed' && !hasResult;
  const tone1 = bad ? 'err' : 'ok';
  const tone2 = bad ? 'err' : (hasResult && e.automation == null) ? 'warn' : 'ok';
  const tone3 = bad ? 'err' : (hasResult && blockFrac < 1) || st === 'partial' ? 'warn' : 'ok';
  const rail = `<div class="rail">
    ${seg(entRun ? 1 : total ? done / total : 0, tone1, false, `${done} of ${total} departments assessed`)}
    ${seg(entRun ? (runStage > 2 ? 1 : 0) : bad ? 1 : hasResult ? 1 : 0, tone2, runStage === 2, 'Consolidation')}
    ${seg(entRun ? 0 : bad ? 1 : blockFrac, tone3, runStage === 3, hasResult && e.blocksTotal ? `${e.blocksAssessed} of ${e.blocksTotal} building blocks scored` : 'Building-block maturity')}
  </div><div class="ent-stages"><span>departments</span><span>consolidation</span><span>maturity</span></div>`;

  const when = t => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : relTime(d.getTime()); };
  const stateText = {
    running: 'assessing…', locked: 'not ready', ready: 'not run yet',
    complete: limited ? 'assessed · with limitations' : 'assessed', partial: 'incomplete result', failed: 'last run failed', blocked: 'blocked', stopped: 'stopped by you'
  }[st];
  const right = st === 'running' ? (entRun.background ? 'running on the server' : esc(ENT_STEPS[entRun.step])) : (st === 'complete' || st === 'partial') ? esc(when(e.completedAt)) : st === 'stopped' ? esc(when(e.lastRunAt)) : `${done}/${total} departments assessed`;
  const pct = hasResult && st !== 'running' ? `<div class="dept-pct${st === 'failed' || st === 'stopped' ? ' muted' : ''}" title="Enterprise calibrated automation level (0 / 10 / 30 / 50 / 70 / 100)">${e.automation == null ? '—' : e.automation}<small>level</small></div>` : '';

  let body = '';
  if (hasResult && st !== 'running') {
    const facts = [];
    if (e.overallStatus) facts.push(`Status <b>${esc(e.overallStatus.replace(/_/g, ' ').toLowerCase())}</b>`);
    if (e.automation != null) facts.push(`Automation level <b>${e.automation}</b>${e.automationRawAverage != null ? ` (raw average ${e.automationRawAverage})` : ''}`);
    if (e.maturityScore != null && e.blocksAssessed != null) facts.push(`Average maturity <b>${e.maturityScore} / 5</b> across ${e.blocksAssessed} sufficiently evidenced building blocks${e.maturityLevel ? ` (${esc(e.maturityLevel)})` : ''}`);
    else if (e.maturityLevel || e.maturityScore != null) facts.push(`Maturity <b>${esc(e.maturityLevel || 'N/A')}</b>${e.maturityScore != null ? ` (${e.maturityScore} of 5)` : ''}`);
    if (e.blocksTotal != null) facts.push(`${e.blocksAssessed ?? 0} of ${e.blocksTotal} building blocks assessed${e.blocksInsufficientEvidence ? `, ${e.blocksInsufficientEvidence} insufficient evidence (not scored)` : ''}${e.blocksNotRelevant ? `, ${e.blocksNotRelevant} not relevant` : ''}`);
    if (e.departmentsCount != null) facts.push(`${e.departmentsCount} department${e.departmentsCount === 1 ? '' : 's'}${e.crossDomainsCount ? ` + ${e.crossDomainsCount} cross-functional domain${e.crossDomainsCount === 1 ? '' : 's'} (not weighted)` : ''} consolidated`);
    if (e.files.length) facts.push(`${e.files.length}${e.filesExpected ? ` of ${e.filesExpected}` : ''} files in Enterprise Assessment`);
    body += `<ul class="ent-facts${st === 'failed' || st === 'stopped' ? ' muted' : ''}">${facts.map(f => `<li>${f}</li>`).join('')}</ul>`;
  }
  if (st === 'complete' && limited && e.issues.length)
    body += `<div class="ent-alert neutral"><b>Limitations</b><ul>${e.issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  if (st === 'partial' && e.issues.length)
    body += `<div class="ent-alert warn"><b>What's incomplete</b><ul>${e.issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  if (st === 'failed')
    body += e.validationFailed
      ? `<div class="ent-alert err"><b>The last run stopped at validation${e.failedStage ? ` (${esc(e.failedStage)})` : ''}${e.lastRunAt ? ` · ${esc(when(e.lastRunAt))}` : ''}</b><p>No enterprise files were generated. Details are in Enterprise Validation Report.json in 00 - Assessment Control.</p>${e.issues.length ? `<ul>${e.issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p>${esc(e.lastError || '')}</p>`}${hasResult ? `<p>The figures above are from the previous run${e.completedAt ? `, ${esc(when(e.completedAt))}` : ''}.</p>` : ''}</div>`
      : `<div class="ent-alert err"><b>The last run didn't finish${e.lastRunAt ? ` (${esc(when(e.lastRunAt))})` : ''}</b><p>${esc(e.lastError || 'Unknown error.')}</p>${hasResult ? `<p>The figures above are from the previous run${e.completedAt ? `, ${esc(when(e.completedAt))}` : ''}.</p>` : ''}</div>`;
  if (st === 'stopped')
    body += `<div class="ent-alert neutral"><b>You stopped the last run</b><p>Files it had already written to Drive are kept.${hasResult ? ` The figures above are from the previous run${e.completedAt ? `, ${esc(when(e.completedAt))}` : ''}.` : ''}</p></div>`;
  if (st === 'blocked')
    body += `<div class="ent-alert warn"><b>Assess these departments first</b><p>${esc(e.incompleteDepartments.join(', ') || departments.filter(d => !d.assessed).map(d => d.name).join(', '))}</p></div>`;
  if (st === 'locked')
    body += `<p class="ent-hint">Runs once every department is assessed — ${total - done} to go.</p>`;
  if (stale && st !== 'running')
    body += `<div class="ent-alert warn"><b>Out of date</b><p>${done - consolidated} department${done - consolidated === 1 ? ' was' : 's were'} assessed after this run. Run it again to include ${done - consolidated === 1 ? 'it' : 'them'}.</p></div>`;

  const canRun = done === total && total > 0 && !entRun;
  const waiting = busy() && !entRun;
  const label = st === 'ready' ? 'Create enterprise assessment' : (st === 'failed' || st === 'stopped') ? 'Try again' : 'Run again';
  const urgent = st === 'ready' || st === 'failed' || st === 'partial' || st === 'stopped' || stale;
  const action = st === 'running' ? `<div class="ent-act show"><button class="stop-btn" onclick="${entRun && entRun.background ? 'stopBackgroundRun()' : 'stopRun()'}">Stop</button></div>`
    : canRun && st !== 'locked' ? `<div class="ent-act${urgent || waiting ? ' show' : ''}"><button onclick="quickSend('Create Enterprise Assessment')"${waiting ? ' disabled' : ''}>${waiting ? 'Waiting for the current request…' : label}</button></div>` : '';

  card.className = `dept ent ent-${st}`;
  card.innerHTML = `<div class="dept-top"><div class="dept-name">Enterprise</div>${pct}</div>${rail}
    <div class="dept-sub"><span class="state ent-${st}">${stateText}</span><span>${right}</span></div>${body}${action}`;
}

// A long run can outlive the HTTP request (proxy timeout) while n8n keeps going and saves the result.
// After an error, poll the saved session for a few minutes and pick the result up if it lands.
async function recoverAfterError(sid, since, token, immediate) {
  if (!LOAD_URL) return;
  recovering++; renderBoard();
  const note = addNote('working', '<i></i><span class="step">Still working on the server…</span><span>long runs take several minutes — the reply will appear here when it\'s ready</span>');
  const startedAt = Date.now();
  const tick = setInterval(() => { const m = Math.floor((Date.now() - startedAt) / 60000); const s = note.querySelector('.step'); if (s) s.textContent = `Still working on the server… (${m} min)`; }, 30000);
  const done = () => { clearInterval(tick); recovering = Math.max(0, recovering - 1); renderBoard(); };
  for (let k = 0; k < 90; k++) {   // 90 × 20 s ≈ 30 minutes
    await new Promise(r => setTimeout(r, immediate && k === 0 ? 1500 : 20000));
    if (token !== recoverToken || sid !== sessionId) { note.remove(); done(); return; }
    try {
      const res = await fetch(LOAD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
      if (!res.ok) continue;
      const d = await res.json(), tr = Array.isArray(d.transcript) ? d.transcript : [];
      const last = tr[tr.length - 1];
      if (!last || last.role !== 'agent' || new Date(last.time).getTime() < since - 5000) continue;
      if (token !== recoverToken || sid !== sessionId) { note.remove(); done(); return; }
      note.remove(); done();
      addNote('info', 'The run finished on the server — here is its reply.');
      const es = $('empty-state'); if (es) es.remove();
      renderMessage('agent', last.text, last.time, last.files);
      currentMessages.push({ role: 'agent', text: last.text, time: last.time, files: last.files || [] });
      if (Array.isArray(d.departments)) departments = d.departments;
      if (Array.isArray(d.received)) receivedDepartments = d.received;
      if (d.companyName) companyName = d.companyName;
      enterprise = resolveEnterprise(d.enterprise);
      $('status-dot').className = 'conn connected';
      renderBoard(); updateSessionLabel(); saveCurrentConversation(); scrollBottom();
      return;
    } catch { /* keep trying */ }
  }
  note.remove(); done();
  $('status-dot').className = 'conn error';
  addNote('error', 'No result after 30 minutes. The run may have stopped — open the session again from the sidebar to check, or send the message again to retry.');
}

function countUp(el, target) {
  const start = performance.now(), dur = 900;
  const tick = now => { const p = Math.min(1, (now - start) / dur), v = Math.round(target * (1 - Math.pow(1 - p, 3))); el.firstChild.textContent = v; if (p < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function toggleBoard() { $('board').classList.toggle('open'); }
function quickSend(text) { if (busy()) return; $('user-input').value = text; onInputChange($('user-input')); sendMessage(); }

// ── Small helpers ──
function generateSessionId() { return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }
function updateSessionLabel() { $('chat-title').textContent = companyName ? `${companyName} — AS-IS discovery` : 'New session'; $('session-label').textContent = `Session ${sessionId.slice(-10)}`; }
function onInputChange(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; syncSend(); }
function syncSend() { $('send-btn').disabled = activeRun ? !!activeRun.stopping : ((!$('user-input').value.trim() && !attachedFiles.length) || isLoading); }
function handleKeydown(e) {
  if (e.key === 'Escape' && activeRun) { e.preventDefault(); stopRun(); return; } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isLoading && ($('user-input').value.trim() || attachedFiles.length)) sendMessage(); } }
function useChip(el) { $('user-input').value = el.textContent; onInputChange($('user-input')); sendMessage(); }
function scrollBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>'); }
function escAttr(t) { return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }

// ── Stop ──
const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
function setSendMode(running) {
  const b = $('send-btn');
  b.classList.toggle('stop', running);
  b.innerHTML = running ? STOP_ICON : SEND_ICON;
  b.setAttribute('aria-label', running ? 'Stop' : 'Send');
  b.title = running ? 'Stop (Esc)' : 'Send';
  syncSend();
}
function onSendClick() { activeRun ? stopRun() : sendMessage(); }

// Stops waiting in this tab AND asks n8n to cancel the running executions for this session.
async function stopRun() {
  const run = activeRun; if (!run || run.stopping) return;
  run.stopping = true; syncSend();
  run.controller.abort();
  const note = addNote('working', '<i></i><span>Stopping the run on the server…</span>');
  let result = null;
  if (STOP_URL) {
    try {
      const res = await fetch(STOP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: run.sid, text: run.text, kind: run.kind, since: run.since }) });
      if (res.ok) result = await res.json();
    } catch { /* reported below */ }
  }
  note.remove();
  if (run.sid !== sessionId) return;   // user switched sessions meanwhile; the server has the record
  if (result && result.stopped) {
    addMessage('agent', result.note || 'Stopped at your request.');
    if (run.kind === 'enterprise') enterprise = { ...(enterprise || normEnt(null)), status: 'stopped', lastError: 'Stopped by you.', lastRunAt: new Date().toISOString() };
    $('status-dot').className = 'conn';
  } else if (result && result.reason === 'finished') {
    addNote('info', 'The run had already finished — loading its result.');
    recoverAfterError(run.sid, run.startMs, ++recoverToken, true);
  } else {
    addNote('error', "Stopped waiting here, but the server didn't confirm it stopped. It may still finish — checking for a result.");
    recoverAfterError(run.sid, run.startMs, ++recoverToken, true);
  }
  renderBoard(); saveCurrentConversation(); refreshSidebarFromServer();
}

// ── An enterprise run that is still going on the server (started in another tab, before a reload, or blocked by the lock) ──
function watchBackgroundRun(sid) {
  if (bgWatch && bgWatch.sid === sid) return;
  const token = ++recoverToken; bgWatch = { sid, token };
  entRun = { step: 0, background: true }; renderBoard();
  const note = addNote('working', '<i></i><span>An enterprise assessment is running on the server — this card updates when it finishes.</span>');
  (async () => {
    for (let k = 0; k < 60; k++) {                       // up to ~20 minutes
      await new Promise(r => setTimeout(r, 20000));
      if (!bgWatch || bgWatch.token !== token || sid !== sessionId) { note.remove(); return; }
      try {
        const res = await fetch(LOAD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
        if (!res.ok) continue;
        const d = await res.json(); if (d.enterpriseRunning) continue;
        if (!bgWatch || bgWatch.token !== token || sid !== sessionId) { note.remove(); return; }
        note.remove(); bgWatch = null; entRun = null;
        const tr = Array.isArray(d.transcript) ? d.transcript : [], seen = new Set(currentMessages.map(m => m.role + '|' + m.text));
        tr.filter(m => !seen.has(m.role + '|' + m.text)).forEach(m => { renderMessage(m.role, m.text, m.time, m.files); currentMessages.push({ role: m.role, text: m.text, time: m.time, files: m.files || [] }); });
        if (Array.isArray(d.departments)) departments = d.departments;
        enterprise = resolveEnterprise(d.enterprise);
        renderBoard(); saveCurrentConversation(); scrollBottom(); return;
      } catch { /* keep watching */ }
    }
    note.remove(); if (bgWatch && bgWatch.token === token) { bgWatch = null; entRun = null; renderBoard(); }
  })();
}
async function stopBackgroundRun() {
  if (!bgWatch) return;
  const sid = bgWatch.sid; bgWatch = null; recoverToken++;
  const note = addNote('working', '<i></i><span>Stopping the run on the server…</span>');
  let result = null;
  try { const res = await fetch(STOP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, text: '', kind: 'enterprise', since: new Date().toISOString() }) });
        if (res.ok) result = await res.json(); } catch { }
  note.remove(); entRun = null;
  if (result && result.stopped) { addMessage('agent', result.note || 'Stopped at your request.'); enterprise = { ...(enterprise || normEnt(null)), status: 'stopped', lastError: 'Stopped by you.', lastRunAt: new Date().toISOString() }; }
  else addNote('info', 'The run had already finished or could not be stopped — reload the session to see its result.');
  renderBoard(); saveCurrentConversation();
}
