const WEBHOOK_URL = "https://dtsolutions.app.n8n.cloud/webhook/683536ba-dc5c-4796-89e0-b497f8fa92a4";
const STORAGE_KEY = 'as_is_discovery_sessions';
const MAX_FILE_SIZE = 8 * 1024 * 1024;

let sessionId = generateSessionId();
let isLoading = false;
let currentMessages = [];
let attachedFiles = [];
let receivedDepartments = [];
let departments = [];           // [{name, folderName, received, assessed, automation, awaitingAnswers}]
let companyName = '';
let runningDept = null;         // department key currently being assessed (UI only)
let prevState = {};             // folderName -> state, to animate changes

const $ = id => document.getElementById(id);
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Init ──
renderEmpty();
renderSidebar();
renderBoard();
updateSessionLabel();
setupDragDrop();

// ── Storage ──
function loadAllChats() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
function saveChat(id, data) { const all = loadAllChats(); all[id] = data; localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
function deleteChat(id) { const all = loadAllChats(); delete all[id]; localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); }
function saveCurrentConversation() {
  if (!currentMessages.length) return;
  const existing = loadAllChats()[sessionId] || {};
  saveChat(sessionId, { sessionId, title: companyName || existing.title || deriveTitle(), messages: currentMessages,
    received: receivedDepartments, departments, companyName, updatedAt: Date.now() });
  renderSidebar();
}
function deriveTitle() {
  const first = currentMessages.find(m => m.role === 'user');
  if (!first) return 'Untitled session';
  return first.text.length > 40 ? first.text.slice(0, 40) + '…' : first.text;
}

// ── Sidebar ──
function renderSidebar() {
  const list = $('sidebar-list');
  const entries = Object.values(loadAllChats()).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!entries.length) { list.innerHTML = '<div class="session-empty">Sessions you start will be listed here so you can come back to a company later.</div>'; return; }
  const day = 86400000, now = Date.now();
  const groups = [['Today', entries.filter(e => now - e.updatedAt < day)], ['Earlier', entries.filter(e => now - e.updatedAt >= day)]];
  list.innerHTML = groups.filter(g => g[1].length).map(([label, items]) =>
    `<div class="session-group">${label}</div>` + items.map(e => {
      const depts = e.departments || [], assessed = depts.filter(d => d.assessed).length, docs = depts.filter(d => d.received).length;
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

function loadConversation(id) {
  const entry = loadAllChats()[id]; if (!entry) return;
  saveCurrentConversation();
  sessionId = id; currentMessages = entry.messages || []; receivedDepartments = entry.received || [];
  departments = entry.departments || []; companyName = entry.companyName || ''; runningDept = null; prevState = {};
  $('messages').innerHTML = '';
  addNote('info', `Session resumed — ${currentMessages.length} messages`);
  currentMessages.forEach(m => renderMessage(m.role, m.text, m.time, m.files));
  departments.forEach(d => prevState[d.folderName] = stateOf(d));
  updateSessionLabel(); renderBoard(); renderSidebar(); scrollBottom();
}
function newConversation() {
  saveCurrentConversation();
  sessionId = generateSessionId(); currentMessages = []; receivedDepartments = []; departments = []; companyName = ''; runningDept = null; prevState = {}; isLoading = false;
  attachedFiles = []; renderAttachments();
  $('user-input').value = ''; $('send-btn').disabled = true; $('status-dot').className = 'conn';
  renderEmpty(); updateSessionLabel(); renderBoard(); renderSidebar();
}
function confirmDelete(id) { if (!confirm('Delete this session from this browser? Files in Drive are not affected.')) return; deleteChat(id); id === sessionId ? newConversation() : renderSidebar(); }

// ── Messages ──
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

  // Assessment run: show which department and cycle through the pipeline stages while we wait.
  const assess = /^\s*(start|run|assess|evaluate|begin|launch)\b/i.test(text) && !files.length;
  const answering = departments.some(d => d.awaitingAnswers) && !assess && !files.length;
  let stepTimer = null;
  if (assess || answering) {
    const target = departments.find(d => text.toLowerCase().includes(d.name.toLowerCase())) || departments.find(d => d.awaitingAnswers);
    if (target) { runningDept = target.folderName; renderBoard(); }
    let i = answering ? 3 : 0;
    const note = addNote('working', `<i></i><span class="step">${RUN_STEPS[i]}…</span><span>this takes a few minutes — keep this tab open</span>`, 'working-note');
    stepTimer = setInterval(() => { i = Math.min(i + 1, RUN_STEPS.length - 1); note.querySelector('.step').textContent = RUN_STEPS[i] + '…'; }, 18000);
  }

  try {
    const res = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatInput, sessionId, files: files.map(f => ({ name: f.name, mimeType: f.type, data: f.data })) }) });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    removeTyping(); $('status-dot').className = 'conn connected';
    addMessage('agent', data.response || data.output || data.message || JSON.stringify(data));
    if (Array.isArray(data.receivedDepartments)) receivedDepartments = data.receivedDepartments;
    if (Array.isArray(data.departments)) departments = data.departments;
    if (typeof data.companyName === 'string') companyName = data.companyName;
  } catch (err) {
    removeTyping(); $('status-dot').className = 'conn error';
    addNote('error', `Couldn't reach the assistant (${esc(err.message)}). Check that the n8n workflow is active and try again.`);
  } finally {
    if (stepTimer) clearInterval(stepTimer);
    const w = $('working-note'); if (w) w.remove();
    runningDept = null;
  }
  renderBoard(); updateSessionLabel(); saveCurrentConversation();
  isLoading = false; syncSend();
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
    const stateText = running ? 'assessing…' : st === 'done' ? 'assessed' : st === 'wait' ? 'waiting for your answers' : st === 'docs' ? `${d.files || 1} file${(d.files || 1) === 1 ? '' : 's'} filed` : 'no documents yet';
    const pct = st === 'done' ? `<div class="dept-pct" data-count="${d.automation ?? 0}">${changed && !REDUCED ? 0 : (d.automation ?? 0)}<small>%</small></div>` : '';
    const action = st === 'docs' ? `<button onclick="quickSend('Start ${escAttr(d.name)}')">Start ${esc(d.name)} assessment</button>` : st === 'done' ? `<button onclick="quickSend('Start ${escAttr(d.name)}')">Run again</button>` : st === 'none' ? `<button onclick="document.getElementById('file-input').click()">Attach ${esc(d.name)} documents</button>` : '';
    return `<div class="dept${flash}" data-folder="${escAttr(d.folderName)}">
      <div class="dept-top"><div class="dept-name"><span class="dept-folder">${esc(d.folderName.split(' - ')[0])}</span>${esc(d.name)}</div>${pct}</div>
      <div class="rail">${seg('docs', st !== 'none')}${seg('wait', st === 'wait' || st === 'done', running)}${seg('done', st === 'done')}</div>
      <div class="dept-sub"><span class="state ${st}">${stateText}</span><span>${st === 'done' ? 'files in 02 - Outputs' : ''}</span></div>
      <div class="dept-act">${action}</div></div>`;
  }).join('');
  // count-up for newly assessed departments
  list.querySelectorAll('.dept-pct').forEach(el => { const target = Number(el.dataset.count); if (Number(el.firstChild.textContent) !== target) countUp(el, target); });
  departments.forEach(d => prevState[d.folderName] = stateOf(d));
  const assessed = departments.filter(d => d.assessed), docs = departments.filter(d => d.received).length;
  const avg = assessed.length ? Math.round(assessed.reduce((a, d) => a + (Number(d.automation) || 0), 0) / assessed.length) : null;
  foot.innerHTML = `<b>${assessed.length} of ${departments.length}</b> assessed · ${docs} with documents${avg !== null ? ` · average automation <b>${avg}%</b>` : ''}`;
  $('board-count').textContent = `${assessed.length}/${departments.length} assessed`;
}
function countUp(el, target) {
  const start = performance.now(), dur = 900;
  const tick = now => { const p = Math.min(1, (now - start) / dur), v = Math.round(target * (1 - Math.pow(1 - p, 3))); el.firstChild.textContent = v; if (p < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function toggleBoard() { $('board').classList.toggle('open'); }
function quickSend(text) { $('user-input').value = text; onInputChange($('user-input')); sendMessage(); }

// ── Small helpers ──
function generateSessionId() { return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }
function updateSessionLabel() { $('chat-title').textContent = companyName ? `${companyName} — AS-IS discovery` : 'New session'; $('session-label').textContent = `Session ${sessionId.slice(-10)}`; }
function onInputChange(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; syncSend(); }
function syncSend() { $('send-btn').disabled = (!$('user-input').value.trim() && !attachedFiles.length) || isLoading; }
function handleKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isLoading && ($('user-input').value.trim() || attachedFiles.length)) sendMessage(); } }
function useChip(el) { $('user-input').value = el.textContent; onInputChange($('user-input')); sendMessage(); }
function scrollBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>'); }
function escAttr(t) { return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }
