const WEBHOOK_URL = "https://dtsolutions.app.n8n.cloud/webhook/683536ba-dc5c-4796-89e0-b497f8fa92a4";
const STORAGE_KEY = 'as_is_discovery_sessions';

let sessionId = generateSessionId();
let isLoading = false;
let currentMessages = [];        // in-memory message log for active session
let attachedFiles = [];          // staged files: { name, type, size, data }
let receivedDepartments = [];    // folder names the backend has stored, e.g. "01 - Legal"
let departments = [];            // [{name, folderName, received}] from the backend
let companyName = '';

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB per file

// ── Init ──
updateSessionLabel();
renderSidebar();

// ── LocalStorage helpers ──
function loadAllChats() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function saveChat(id, data) {
  const all = loadAllChats();
  all[id] = data;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
function deleteChat(id) {
  const all = loadAllChats();
  delete all[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
function saveCurrentConversation() {
  if (currentMessages.length === 0) return;
  const all = loadAllChats();
  const existing = all[sessionId] || {};
  saveChat(sessionId, {
    sessionId,
    title: existing.title || deriveTitleFromMessages(),
    messages: currentMessages,
    received: receivedDepartments,
    departments,
    companyName,
    updatedAt: Date.now()
  });
  renderSidebar();
}
function deriveTitleFromMessages() {
  const first = currentMessages.find(m => m.role === 'user');
  if (!first) return 'Untitled session';
  return first.text.length > 45 ? first.text.slice(0, 45) + '…' : first.text;
}

// ── Sidebar rendering ──
function renderSidebar() {
  const all = loadAllChats();
  const list = document.getElementById('sidebar-list');
  const entries = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);

  if (entries.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">No previous sessions yet.<br>Start collecting documents to see them here.</div>';
    return;
  }
  const now = Date.now();
  const oneDayMs = 86400000;
  const today = entries.filter(e => now - e.updatedAt < oneDayMs);
  const earlier = entries.filter(e => now - e.updatedAt >= oneDayMs);

  let html = '';
  if (today.length) {
    html += '<div class="sidebar-section-label">Today</div>';
    today.forEach(e => html += chatItemHTML(e));
  }
  if (earlier.length) {
    html += '<div class="sidebar-section-label">Earlier</div>';
    earlier.forEach(e => html += chatItemHTML(e));
  }
  list.innerHTML = html;
}
function chatItemHTML(entry) {
  const isActive = entry.sessionId === sessionId;
  const timeStr = formatRelativeTime(entry.updatedAt);
  const count = (entry.received || []).length;
  const badge = count ? `<span class="chat-item-badge">${count} dept${count > 1 ? 's' : ''}</span>` : '';
  return `
    <div class="chat-item ${isActive ? 'active' : ''}" onclick="loadConversation('${entry.sessionId}')">
      <div class="chat-item-title">${escapeHtml(entry.title)}</div>
      <div class="chat-item-meta">${timeStr} ${badge}</div>
      <button class="chat-item-delete" onclick="event.stopPropagation(); confirmDelete('${entry.sessionId}')" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v6M14 11v6"></path>
        </svg>
      </button>
    </div>`;
}
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// ── Load a past session ──
function loadConversation(id) {
  const all = loadAllChats();
  const entry = all[id];
  if (!entry) return;

  saveCurrentConversation();

  sessionId = id;
  currentMessages = entry.messages || [];
  receivedDepartments = entry.received || [];
  departments = entry.departments || [];
  companyName = entry.companyName || '';
  updateSessionLabel();

  const msgDiv = document.getElementById('messages');
  msgDiv.innerHTML = '';
  addBanner('resumed', `Session resumed — ${currentMessages.length} messages loaded`);
  currentMessages.forEach(m => renderMessageInUI(m.role, m.text, m.time));

  renderDeptChecklist();
  renderSidebar();
  scrollToBottom();
}

// ── New session ──
function newConversation() {
  saveCurrentConversation();

  sessionId = generateSessionId();
  currentMessages = [];
  receivedDepartments = [];
  departments = [];
  companyName = '';
  isLoading = false;

  updateSessionLabel();
  renderDeptChecklist();

  document.getElementById('messages').innerHTML = `
    <div class="empty-state" id="empty-state">
      <div class="empty-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
      </div>
      <div class="empty-title">New discovery session started</div>
      <div class="empty-sub">Pick a department, attach its documents, and I'll file them into Drive.</div>
      <div class="suggestion-chips">
        <span class="chip" onclick="useChip(this)">What documents do you need?</span>
        <span class="chip" onclick="useChip(this)">Let's start with Legal</span>
        <span class="chip" onclick="useChip(this)">Let's start with Finance</span>
      </div>
    </div>`;

  document.getElementById('send-btn').disabled = true;
  document.getElementById('user-input').value = '';
  renderSidebar();
}

// ── Delete ──
function confirmDelete(id) {
  if (!confirm('Delete this session?')) return;
  deleteChat(id);
  if (id === sessionId) newConversation();
  else renderSidebar();
}

// ── Message rendering ──
function renderMessageInUI(role, text, time) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const initials = role === 'user' ? 'You' : 'AI';
  div.innerHTML = `
    <div class="msg-avatar">${initials}</div>
    <div class="msg-body">
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <div class="msg-time">${time || ''}</div>
    </div>`;
  document.getElementById('messages').appendChild(div);
}
function addMessage(role, text) {
  removeEmptyState();
  const time = getTime();
  renderMessageInUI(role, text, time);
  currentMessages.push({ role, text, time });
  scrollToBottom();
}
function addBanner(type, text) {
  const div = document.createElement('div');
  div.className = type === 'error' ? 'error-banner' : type === 'resumed' ? 'resumed-banner' : 'spec-banner';
  div.textContent = text;
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}

// ── Typing indicator ──
function showTyping() {
  removeEmptyState();
  const div = document.createElement('div');
  div.className = 'typing-wrap';
  div.id = 'typing';
  div.innerHTML = `
    <div class="msg-avatar" style="background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;flex-shrink:0;">AI</div>
    <div class="typing-bubble">
      <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>`;
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}
function removeTyping() {
  const t = document.getElementById('typing');
  if (t) t.remove();
}

// ── File attachments ──
function onFilesSelected(fileList) {
  const files = Array.from(fileList);
  let rejected = [];
  const readers = files.map(file => {
    if (file.size > MAX_FILE_SIZE) {
      rejected.push(`${file.name} (too large, max 8MB)`);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: base64 });
      };
      reader.onerror = () => { rejected.push(`${file.name} (failed to read)`); resolve(null); };
      reader.readAsDataURL(file);
    });
  });
  Promise.all(readers).then(results => {
    results.filter(Boolean).forEach(f => attachedFiles.push(f));
    if (rejected.length) alert('Some files were skipped:\n' + rejected.join('\n'));
    renderFilePreview();
    document.getElementById('file-input').value = '';
    const input = document.getElementById('user-input');
    document.getElementById('send-btn').disabled = (!input.value.trim() && attachedFiles.length === 0) || isLoading;
  });
}
function removeAttachedFile(index) {
  attachedFiles.splice(index, 1);
  renderFilePreview();
  const input = document.getElementById('user-input');
  document.getElementById('send-btn').disabled = (!input.value.trim() && attachedFiles.length === 0) || isLoading;
}
function renderFilePreview() {
  const row = document.getElementById('file-preview-row');
  if (attachedFiles.length === 0) {
    row.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  row.style.display = 'flex';
  row.innerHTML =
    `<span class="file-preview-dept">→ department detected automatically</span>` +
    attachedFiles.map((f, i) => `
    <div class="file-chip">
      <span class="file-chip-name" title="${escapeHtml(f.name)}">${escapeHtml(truncateName(f.name))}</span>
      <span class="file-chip-size">${formatFileSize(f.size)}</span>
      <button class="file-chip-remove" onclick="removeAttachedFile(${i})" title="Remove">✕</button>
    </div>`).join('');
}
function truncateName(name) {
  return name.length > 22 ? name.slice(0, 19) + '…' : name;
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Send ──
async function sendMessage() {
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if ((!text && attachedFiles.length === 0) || isLoading) return;

  isLoading = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  const filesForThisMessage = attachedFiles;
  attachedFiles = [];
  renderFilePreview();

  const displayText = filesForThisMessage.length
    ? (text ? text + '\n' : '') + `📎 Sending ${filesForThisMessage.length} file(s):\n` +
      filesForThisMessage.map(f => '• ' + f.name).join('\n')
    : text;

  const chatInputForBackend = text || (
    filesForThisMessage.length
      ? `Please file these documents: ${filesForThisMessage.map(f => f.name).join(', ')}.`
      : ''
  );

  addMessage('user', displayText);
  showTyping();
  const isAssessment = /^\s*(start|run|assess|evaluate|begin|launch)\b/i.test(text) && !filesForThisMessage.length;
  if (isAssessment) addBanner('resumed', 'Running the assessment — reading documents and building the reports. This can take a few minutes, please keep this tab open.');

  const dot = document.getElementById('status-dot');
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatInput: chatInputForBackend,
        sessionId,
        files: filesForThisMessage.map(f => ({ name: f.name, mimeType: f.type, data: f.data }))
      })
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const data = await res.json();
    removeTyping();
    dot.className = 'status-dot connected';

    const raw = data.response || data.output || data.message || JSON.stringify(data);
    addMessage('agent', raw);

    if (Array.isArray(data.receivedDepartments)) receivedDepartments = data.receivedDepartments;
    if (Array.isArray(data.departments)) departments = data.departments;
    if (typeof data.companyName === 'string') companyName = data.companyName;
    renderDeptChecklist();
    saveCurrentConversation();

  } catch (err) {
    removeTyping();
    dot.className = 'status-dot error';
    addBanner('error', `Connection failed: ${err.message}. Check the webhook URL and n8n CORS settings.`);
  }

  isLoading = false;
  document.getElementById('send-btn').disabled = !input.value.trim();
}

// ── Department checklist ──
function renderDeptChecklist() {
  const bar = document.getElementById('dept-checklist');
  const label = companyName ? `${companyName} — documents received:` : 'Documents received:';
  let html = `<span class="progress-label">${label}</span>`;
  if (!departments.length) {
    html += '<span class="step-pill" id="no-depts-pill">Set up a company to begin</span>';
  } else {
    html += departments.map(d => {
      const done = d.received || receivedDepartments.includes(d.folderName);
      const cls = d.assessed ? ' assessed' : (d.awaitingAnswers ? ' active' : (done ? ' done' : ''));
      const label = d.assessed ? `${d.name} ✓ ${d.automation}%` : (d.awaitingAnswers ? `${d.name} — answer questions` : d.name);
      const tip = d.assessed ? `${d.folderName} — assessed, ${d.automation}% automated` : (done ? `${d.folderName} — documents received` : `${d.folderName} — no documents yet`);
      return `<span class="step-pill${cls}" data-dept="${d.folderName}" title="${tip}">${label}</span>`;
    }).join('');
  }
  bar.innerHTML = html;
}

// ── Utilities ──
function generateSessionId() {
  return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}
function updateSessionLabel() {
  document.getElementById('session-label').textContent = `Session: ${sessionId.slice(-10)}`;
}
function onInputChange(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  document.getElementById('send-btn').disabled = (!el.value.trim() && attachedFiles.length === 0) || isLoading;
}
function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isLoading && document.getElementById('user-input').value.trim()) sendMessage();
  }
}
function useChip(el) {
  document.getElementById('user-input').value = el.textContent;
  onInputChange(document.getElementById('user-input'));
  sendMessage();
}
function removeEmptyState() {
  const es = document.getElementById('empty-state');
  if (es) es.remove();
}
function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function scrollToBottom() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
