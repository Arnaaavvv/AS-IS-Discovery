const WEBHOOK_URL = "https://dtsolutions.app.n8n.cloud/webhook/683536ba-dc5c-4796-89e0-b497f8fa92a4";
  const STATUS_URL = "https://dtsolutions.app.n8n.cloud/webhook/pipeline-status";
  const STORAGE_KEY = 'ba_agent_chats';
  const PIPELINE_STAGES = ['process_design', 'process_map', 'decision_tree', 'business_rules', 'automation_design', 'complete'];
  let pipelinePollTimer = null;
  let pipelinePollAttempts = 0;
  const PIPELINE_MAX_POLLS = 120; // ~3 minutes at 1.5s intervals, then give up gracefully

  let sessionId = generateSessionId();
  let isLoading = false;
  let currentMessages = []; // in-memory message log for active conversation
  let attachedFiles = []; // files staged for the next message: { name, type, size, data }

  const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB per file
  const ALLOWED_TYPES = ['application/pdf', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword', 'application/vnd.ms-excel', 'image/png', 'image/jpeg'];

  const STEP_KEYWORDS = {
    1: ['objective', 'goal', 'problem', 'outcome', 'success', 'kpi', 'metric', 'benefit', 'pain', 'current process'],
    2: ['trigger', 'event', 'initiates', 'starts', 'frequency', 'manual', 'automatic', 'docusign', 'webhook'],
    3: ['input', 'source', 'format', 'data', 'crm', 'erp', 'excel', 'pdf', 'api', 'database', 'google sheet'],
    4: ['process', 'transform', 'validat', 'business rule', 'logic', 'mapping', 'calculat'],
    5: ['output', 'destination', 'recipient', 'email', 'slack', 'jira', 'notification', 'report'],
    6: ['approv', 'escalat', 'manager', 'sign-off', 'review', 'gate'],
    7: ['sla', 'volume', 'frequency', 'peak', 'hour', 'day', 'month', 'hires per'],
    8: ['security', 'compliance', 'gdpr', 'pii', 'encrypt', 'access control', 'audit', 'sensitive']
  };

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
      updatedAt: Date.now(),
      isComplete: existing.isComplete || false
    });
    renderSidebar();
  }

  function deriveTitleFromMessages() {
    // Use first user message as title, truncated
    const first = currentMessages.find(m => m.role === 'user');
    if (!first) return 'Untitled conversation';
    return first.text.length > 45 ? first.text.slice(0, 45) + '…' : first.text;
  }

  // ── Sidebar rendering ──
  function renderSidebar() {
    const all = loadAllChats();
    const list = document.getElementById('sidebar-list');
    const entries = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);

    if (entries.length === 0) {
      list.innerHTML = '<div class="sidebar-empty">No previous chats yet.<br>Start a conversation to see it here.</div>';
      return;
    }

    // Group into Today / Earlier
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
    const badge = entry.isComplete ? '<span class="chat-item-badge">Done</span>' : '';
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

  // ── Load a past conversation ──
  function loadConversation(id) {
    const all = loadAllChats();
    const entry = all[id];
    if (!entry) return;

    // Save current if it has messages
    saveCurrentConversation();

    sessionId = id;
    currentMessages = entry.messages || [];
    updateSessionLabel();
    resetSteps();
    stopPipelinePolling();
    document.getElementById('pipeline-track').style.display = 'none';

    // Clear and rebuild message UI
    const msgDiv = document.getElementById('messages');
    msgDiv.innerHTML = '';

    addBanner('resumed', `Conversation resumed — ${entry.messages.length} messages loaded`);

    currentMessages.forEach(m => {
      renderMessageInUI(m.role, m.text, m.time);
      updateSteps(m.text);
    });

    if (entry.isComplete) markAllDone();

    renderSidebar();
    scrollToBottom();
  }

  // ── New conversation ──
  function newConversation() {
    saveCurrentConversation();

    sessionId = generateSessionId();
    currentMessages = [];
    isLoading = false;

    updateSessionLabel();
    resetSteps();
    stopPipelinePolling();
    document.getElementById('pipeline-track').style.display = 'none';

    document.getElementById('messages').innerHTML = `
      <div class="empty-state" id="empty-state">
        <div class="empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="empty-title">New conversation started</div>
        <div class="empty-sub">Describe the next process you want to automate.</div>
        <div class="suggestion-chips">
          <span class="chip" onclick="useChip(this)">Automate employee onboarding</span>
          <span class="chip" onclick="useChip(this)">Automate invoice approval</span>
          <span class="chip" onclick="useChip(this)">Automate lead qualification</span>
        </div>
      </div>`;

    document.getElementById('send-btn').disabled = true;
    document.getElementById('user-input').value = '';
    renderSidebar();
  }

  // ── Delete ──
  function confirmDelete(id) {
    if (!confirm('Delete this conversation?')) return;
    deleteChat(id);
    if (id === sessionId) newConversation();
    else renderSidebar();
  }

  // ── Message rendering ──
  function renderMessageInUI(role, text, time) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const initials = role === 'user' ? 'You' : 'BA';
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
    updateSteps(text);
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
      <div class="msg-avatar" style="background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;flex-shrink:0;">BA</div>
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
          // reader.result is "data:<mime>;base64,<data>" — keep just the base64 part
          const base64 = reader.result.split(',')[1];
          resolve({
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
            data: base64
          });
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
    row.innerHTML = attachedFiles.map((f, i) => `
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
      ? text + (text ? '\n' : '') + filesForThisMessage.map(f => '📎 ' + f.name).join('\n')
      : text;

    // Gemini rejects an empty message — if the user only attached files with no
    // typed text, send a sensible fallback so chatInput is never blank.
    const chatInputForBackend = text || (
      filesForThisMessage.length
        ? `I've attached the following file(s): ${filesForThisMessage.map(f => f.name).join(', ')}. Please review them.`
        : ''
    );

    addMessage('user', displayText);
    showTyping();

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

      const raw = data.output || data.text || data.message || JSON.stringify(data);

      // Backend emits "[SPEC_READY|<one-line description>]" — match on the
      // prefix only, since the exact closing text varies.
      const specMatch = raw.match(/\[SPEC_READY\|(.*?)\]/s);

      if (specMatch) {
        const clean = raw.replace(/\[SPEC_READY\|.*?\]/s, '').trim();
        addMessage('agent', clean);
        markAllDone();
        addBanner('spec', '✓ Requirements captured — building your automation now...');
        // Mark complete in storage
        const all = loadAllChats();
        if (all[sessionId]) {
          all[sessionId].isComplete = true;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        }
        startPipelinePolling();
      } else {
        addMessage('agent', raw);
      }

      saveCurrentConversation();

    } catch (err) {
      removeTyping();
      dot.className = 'status-dot error';
      addBanner('error', `Connection failed: ${err.message}. Check webhook URL and n8n CORS settings.`);
    }

    isLoading = false;
    document.getElementById('send-btn').disabled = !input.value.trim();
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

  function resetSteps() {
    for (let i = 1; i <= 8; i++) document.getElementById('step-' + i).className = 'step-pill';
  }

  function updateSteps(text) {
    const lower = text.toLowerCase();
    for (const [step, keywords] of Object.entries(STEP_KEYWORDS)) {
      const el = document.getElementById('step-' + step);
      if (el.classList.contains('done')) continue;
      if (keywords.some(k => lower.includes(k))) el.className = 'step-pill active';
    }
  }

  function markStepDone(stepNum) {
    const el = document.getElementById('step-' + stepNum);
    if (el) el.className = 'step-pill done';
  }

  function markAllDone() {
    for (let i = 1; i <= 8; i++) markStepDone(i);
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

  // ── Pipeline progress (Process Design → ... → Automation Design) ──
  function startPipelinePolling() {
    stopPipelinePolling(); // clear any previous run
    pipelinePollAttempts = 0;
    document.getElementById('pipeline-track').style.display = 'flex';
    resetPipelineBoxes();
    pollPipelineStatus();
    pipelinePollTimer = setInterval(pollPipelineStatus, 1500);
  }

  function stopPipelinePolling() {
    if (pipelinePollTimer) {
      clearInterval(pipelinePollTimer);
      pipelinePollTimer = null;
    }
  }

  function resetPipelineBoxes() {
    document.querySelectorAll('.pipeline-box').forEach(box => {
      box.classList.remove('running', 'done');
    });
  }

  async function pollPipelineStatus() {
    pipelinePollAttempts++;
    if (pipelinePollAttempts > PIPELINE_MAX_POLLS) {
      stopPipelinePolling();
      addBanner('error', 'Automation build is taking longer than expected — check the workflow directly.');
      return;
    }

    try {
      const res = await fetch(`${STATUS_URL}?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return; // transient — just try again on the next tick
      const data = await res.json();
      const stages = data.stages || [];

      // Highest-order stage present in the table is the current/most-recent one;
      // everything before it is implicitly done since stages run strictly in order.
      let runningIndex = -1;
      stages.forEach(s => {
        const idx = PIPELINE_STAGES.indexOf(s.stage);
        if (idx > runningIndex) runningIndex = idx;
      });

      PIPELINE_STAGES.forEach((stage, i) => {
        const box = document.querySelector(`.pipeline-box[data-stage="${stage}"]`);
        if (!box) return;
        box.classList.remove('running', 'done');
        if (i < runningIndex || data.complete) box.classList.add('done');
        else if (i === runningIndex) box.classList.add('running');
      });

      if (data.complete) {
        stopPipelinePolling();
        addBanner('spec', '✓ Automation design complete.');
      }
    } catch (err) {
      // network hiccup — keep polling, don't spam banners
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }