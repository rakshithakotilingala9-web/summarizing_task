(() => {
  const ROOT_ID = 'vh-agui-root';
  if (document.getElementById(ROOT_ID)) return;

  // ---------- Utilities ----------
  const qs = (sel, root = document) => root.querySelector(sel);
  const tidy = (s = '') => s.replace(/\xA0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  function normalizeUrl() {
    try { const u = new URL(location.href); return `${u.origin}${u.pathname}`; }
    catch { return location.href; }
  }
  async function getOrCreateUserId() {
    let syncOk = true; let syncData = {};
    try { syncData = await chrome.storage.sync.get(['VIBE_USER_ID']); } catch (_) { syncOk = false; }
    if (syncOk && syncData?.VIBE_USER_ID) return syncData.VIBE_USER_ID;
    const local = await chrome.storage.local.get(['VIBE_USER_ID']);
    if (local?.VIBE_USER_ID) {
      if (syncOk) { try { await chrome.storage.sync.set({ VIBE_USER_ID: local.VIBE_USER_ID }); } catch (_) { } }
      return local.VIBE_USER_ID;
    }
    const uid = crypto.randomUUID();
    if (syncOk) { try { await chrome.storage.sync.set({ VIBE_USER_ID: uid }); } catch (_) { } }
    await chrome.storage.local.set({ VIBE_USER_ID: uid });
    return uid;
  }
  const nowTime = () => new Date().toLocaleTimeString([], { hour12: false });

  // ---------- Thread & Transcript ----------
  function pageKey() { return normalizeUrl(); }
  function threadMapKey(agentId) { return `AGUI_THREAD_MAP::${agentId}::${pageKey()}`; } // value = threadId
  function getKnownThreadId(agentId) { return localStorage.getItem(threadMapKey(agentId)) || null; }
  function setKnownThreadId(agentId, threadId) { localStorage.setItem(threadMapKey(agentId), threadId); }

  function pendingTranscriptId(agentId) { return `PENDING::${agentId}::${pageKey()}`; }

  function transcriptKey(id) { return `AGUI_TRANSCRIPT::${id}`; }
  function loadTranscript(id) {
    try { return JSON.parse(localStorage.getItem(transcriptKey(id)) || '[]'); }
    catch { return []; }
  }
  function saveTranscript(id, arr) {
    try { localStorage.setItem(transcriptKey(id), JSON.stringify(arr)); } catch { }
  }
  
  // Modified to include processing details
  function pushTranscript(id, role, content, processingDetails = []) {
    const arr = loadTranscript(id);
    arr.push({ role, content, processingDetails, ts: Date.now() });
    saveTranscript(id, arr);
  }
  
  function updateLastAssistant(id, patch) {
    const arr = loadTranscript(id);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === 'agent') { arr[i].content = patch; saveTranscript(id, arr); break; }
    }
  }
  
  // New function to update processing details for last user message
  function updateLastUserProcessing(id, processingDetails) {
    const arr = loadTranscript(id);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === 'user') { 
        arr[i].processingDetails = [...processingDetails]; 
        saveTranscript(id, arr); 
        break; 
      }
    }
  }

  function migrateTranscript(fromId, toId) {
    if (fromId === toId) return;
    const arr = loadTranscript(fromId);
    if (arr.length) saveTranscript(toId, arr);
    try { localStorage.removeItem(transcriptKey(fromId)); } catch { }
  }

  // ---------- Extension Info ----------
  function getExtensionName() {
    return chrome.runtime.getManifest().name || 'Extension';
  }

  // ---------- Shadow host ----------
  const host = document.createElement('div');
  host.id = ROOT_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  // Fallback CSS (in case styles.css didn't load)
  const fallbackStyle = document.createElement('style');
  fallbackStyle.textContent = `
    .vh-bubble { position:fixed; right:20px; bottom:20px; z-index:2147483647; width:48px; height:48px; border-radius:24px; display:grid; place-items:center; cursor:pointer; background:#111; color:#fff; font-size:20px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
    .vh-sidebar { position:fixed; top:0; right:-480px; width:480px; max-width:92vw; height:100%; background:#0b0b0c; color:#eaeaea; border-left:1px solid #2a2a2a; box-shadow:-4px 0 20px rgba(0,0,0,.35); display:flex; flex-direction:column; transition:right .3s ease-in-out; z-index:2147483647; }
    .vh-sidebar.open { right:0; }
    .vh-header { display:flex; justify-content:space-between; align-items:center; padding:12px; background:#111114; border-bottom:1px solid #24242a; }
    .vh-title { font-weight:700; font-size:14px; } .vh-actions { display:flex; gap:8px; }
    .vh-btn { background:#1b1b20; color:#dcdcdc; border:1px solid #2a2a2a; padding:6px 10px; border-radius:8px; cursor:pointer; font-size:12px; }
    .vh-sub { font-size:12px; opacity:.85; padding:8px 12px; border-bottom:1px dashed #2a2a2a; white-space:pre-wrap; word-break:break-word; display: none; }
    .vh-history { padding:12px; overflow:auto; display:flex; flex-direction:column; gap:10px; flex:1 1 auto; }
    .vh-msg { display:inline-block; max-width:92%; padding:10px 12px; border-radius:14px; line-height:1.45; white-space:pre-wrap; word-wrap: break-word; font-size:14px; }
    .vh-msg.user { align-self:flex-end; background:#15243a; border:1px solid #244a7a; display: flex; align-items: center; gap: 8px; }
    .vh-msg-text { background: #15243a;   padding: 10px 12px;    border-radius: 12px;    color: white; } 
    .vh-msg.agent { align-self:flex-start; background:#17171b; border:1px solid #2a2a2a; }
    .vh-msg.pending { opacity:.85; } .vh-msg.error { border-color:#7a2424; background:#3a1515; }
    .vh-thinking { display:inline-flex; align-items:center; gap:6px; }
    .vh-dots { display:inline-flex; gap:3px; }
    .vh-dot { width:6px; height:6px; border-radius:3px; background:#9aa0a6; opacity:.4; animation: vh-bounce 1.3s infinite ease-in-out; }
    .vh-dot:nth-child(2){ animation-delay:.15s; } .vh-dot:nth-child(3){ animation-delay:.3s; }
    @keyframes vh-bounce { 0%,80%,100%{ transform:translateY(0); opacity:.4;} 40%{ transform:translateY(-4px); opacity:1; } }
    .vh-input { display:flex; gap:8px; padding:10px; border-top:1px solid #24242a; background:#111114; }
    #vh-textarea { flex:1; resize:vertical; background:#0d0d10; color:#eaeaea; border:1px solid #2a2a2a; border-radius:10px; padding:10px; min-height:44px; }
    .vh-send { background:#2c6e49; color:#fff; border:none; padding:10px 14px; border-radius:10px; cursor:pointer; }
    .vh-spin { width:12px; height:12px; border-radius:50%; border:2px solid rgba(255,255,255,.15); border-top-color: rgba(255,255,255,.75); animation: vh-spin .8s linear infinite; }
    @keyframes vh-spin { to { transform: rotate(360deg); } }

    /* Processing Details Styles */
    .vh-processing-details { margin-top: 8px; border-top: 1px dashed #2a2a2a; padding-top: 8px; }
    .vh-processing-toggle { background: none; border: none; color: #666; font-size: 11px; cursor: pointer; padding: 2px 0; }
    .vh-processing-events { margin-top: 4px; font-size: 10px; }
    .vh-processing-event { display: flex; padding: 1px 0; border-bottom: 1px solid #1a1a1a; }
    .vh-processing-time { width: 50px; color: #888; font-variant-numeric: tabular-nums; }
    .vh-processing-type { width: 70px; font-weight: bold; color: #ccc; }
    .vh-processing-content { flex: 1; color: #999; }
    .vh-retry-btn {
    background: orange;
    border: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    font-size: 14px;
    cursor: pointer;
    margin-right: 6px;
    display: flex;
    align-items: center;
    justify-content: center; 
    }
  `;
  shadow.appendChild(fallbackStyle);

  const bubble = document.createElement('div');
  bubble.className = 'vh-bubble';
  bubble.title = `Open ${getExtensionName()} Chat (Ctrl+Shift+L)`;
  bubble.textContent = '💬';
  shadow.appendChild(bubble);

  let sidebar = null, historyEl, textarea, sendBtn, closeBtn, refreshBtn, summarizeBtn, headerSmall, statusList;

  // ---------- Settings ----------
  async function loadPackagedConfig() {
    try {
      const url = chrome.runtime.getURL('config.json');
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      return {
        AGUI_API_BASE: json.AGUI_API_BASE || '',
        AGUI_ENDPOINT: json.AGUI_ENDPOINT || '',
        AGUI_API_KEY: json.AGUI_API_KEY || '',
        AGUI_AGENT_ID: json.AGUI_AGENT_ID || '',
        AGUI_FILE_ID: json.AGUI_FILE_ID || ''
      };
    } catch (e) {
      return null;
    }
  }

  async function getSettingsOrThrow() {
    const pkg = await loadPackagedConfig();
    const storage = await chrome.storage.local.get([
      'AGUI_API_BASE', 'AGUI_ENDPOINT', 'AGUI_API_KEY', 'AGUI_AGENT_ID', 'AGUI_FILE_ID'
    ]);

    const rawBase = (pkg?.AGUI_API_BASE ?? storage.AGUI_API_BASE ?? '').trim();
    const rawEndpoint = (pkg?.AGUI_ENDPOINT ?? storage.AGUI_ENDPOINT ?? '/v1/agents/chat').trim();
    const rawApiKey = (pkg?.AGUI_API_KEY ?? storage.AGUI_API_KEY ?? '').trim();
    const rawAgentId = (pkg?.AGUI_AGENT_ID ?? storage.AGUI_AGENT_ID ?? '').trim();
    const rawFileId = (pkg?.AGUI_FILE_ID ?? storage.AGUI_FILE_ID ?? '').trim();

    const base = rawBase.replace(/\/+$/, '');
    const endpoint = rawEndpoint || '/v1/agents/chat';
    const apiKey = rawApiKey;
    const agentId = rawAgentId;
    const fileId = rawFileId || '';

    if (!base) throw new Error('API base URL not configured. Add config.json or set in extension Options.');
    if (!agentId) throw new Error('agent_id not configured. Add config.json or set in extension Options.');
    if (!apiKey) throw new Error('API key not configured. Add config.json or set in extension Options.');

    return { base, endpoint, apiKey, agentId, fileId };
  }

  // ---------- Networking ----------
  async function* sseRead(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    try {
      while (true) {
        let value, done;
        try {
          ({ value, done } = await reader.read());
        } catch (readError) {
          console.error('🔧 [NETWORK] SSE read error:', readError);
          throw new Error('NETWORK_CHANGED');
        }
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split('\n').filter(l => l.startsWith('data:'));
          for (const line of lines) {
            const payload = line.slice(5).trim();
            if (payload) yield payload;
          }
        }
      }
    } catch (error) {
      console.error('🔧 [NETWORK] SSE processing error:', error);
      throw new Error('NETWORK_CHANGED');
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {
        // Ignore release errors
      }
    }
  }

  async function testBasicConnectivity() {
    if (!navigator.onLine) {
      throw new Error('No internet connection detected');
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const testUrl = `${cfg.base.replace('/api', '')}/`;
      const test = await fetch(testUrl, { 
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-cache',
        mode: 'no-cors'
      });
      
      clearTimeout(timeoutId);
      console.log('🔧 [NETWORK] Basic connectivity: OK');
      return true;
    } catch (error) {
      console.log('🔧 [NETWORK] Connectivity test failed:', error.message);
      throw new Error('Server unreachable. Please check your network connection.');
    }
  }

  async function postAndStream(cfg, payload, targetAgentId = null) {
    const url = `${cfg.base}${cfg.endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
      'User-Agent': 'AgentGateway/1.0'
    };

    // Use target agent ID if provided, otherwise use default
    const finalPayload = targetAgentId ? { ...payload, agent_id: targetAgentId } : payload;

    console.log('🔧 [NETWORK] Making request to:', url);
    console.log('🔧 [NETWORK] Headers:', {
      ...headers,
      Authorization: 'Bearer ***' + cfg.apiKey.slice(-4)
    });
    console.log('🔧 [NETWORK] Payload:', finalPayload);

    await testBasicConnectivity();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏰ Request timeout after 2 minutes');
      controller.abort();
    }, 120000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(finalPayload),
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit'
      });

      clearTimeout(timeoutId);

      const ctype = res.headers.get('content-type') || '';
      console.log('🔧 [NETWORK] Response status:', res.status);
      console.log('🔧 [NETWORK] Content-Type:', ctype);

      if (res.ok && ctype.includes('text/event-stream')) {
        console.log('🔧 [NETWORK] Streaming response detected');
        return { mode: 'sse', res };
      }

      const responseText = await res.text();
      console.log('🔧 [NETWORK] Response body:', responseText);

      let json;
      try {
        json = responseText ? JSON.parse(responseText) : {};
      } catch (parseError) {
        console.error('🔧 [NETWORK] JSON parse error:', parseError);
        json = {};
      }

      if (!res.ok) {
        const msg = json?.detail || json?.message || json?.error || `HTTP ${res.status}: ${responseText}`;
        console.error('🔧 [NETWORK] API error:', msg);
        throw new Error(msg);
      }

      console.log('🔧 [NETWORK] JSON response success:', json);
      return { mode: 'json', json };

    } catch (err) {
      clearTimeout(timeoutId);
      
      console.error('🔧 [NETWORK] Fetch error:', err);
      
      if (err.name === 'AbortError') {
        throw new Error('Request timeout - server took too long to respond (2 minute limit)');
      } else if (err.message.includes('NETWORK_CHANGED') || err.message.includes('Failed to fetch')) {
        throw new Error('Network connection changed during request. Please check your internet connection and try again.');
      } else if (err instanceof TypeError) {
        throw new Error(`Network error: ${err.message}. This may be a CORS or connectivity issue.`);
      } else {
        throw new Error(err.message || `Request failed: ${String(err)}`);
      }
    }
  }

  async function postWithRetry(cfg, payload, maxRetries = 4, targetAgentId = null) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 [NETWORK] Attempt ${attempt}/${maxRetries}`);
        
        if (attempt > 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`⏳ [NETWORK] Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const result = await postAndStream(cfg, payload, targetAgentId);
        console.log(`✅ [NETWORK] Success on attempt ${attempt}`);
        return result;
        
      } catch (error) {
        console.warn(`❌ [NETWORK] Attempt ${attempt} failed:`, error.message);
        
        if (error.message.includes('401') || 
            error.message.includes('Not Authenticated') ||
            error.message.includes('USER_SEND_FAILED') ||
            error.message.includes('timeout') ||
            error.message.includes('422') ||
            attempt === maxRetries) {
          console.error(`💥 [NETWORK] Final failure:`, error.message);
          throw new Error("USER_SEND_FAILED");
        }
        
        console.log(`🔄 [NETWORK] Will retry...`);
      }
    }
  }

  // ---------- Processing Details UI ----------
  function createProcessingDetails(events) {
    if (!events || events.length === 0) return null;
    
    const container = document.createElement('div');
    container.className = 'vh-processing-details';
    
    const toggle = document.createElement('button');
    toggle.className = 'vh-processing-toggle';
    toggle.textContent = `▶ Processing Details (${events.length} events)`;
    
    const eventsContainer = document.createElement('div');
    eventsContainer.className = 'vh-processing-events';
    eventsContainer.style.display = 'none';
    
    events.forEach(event => {
      const eventDiv = document.createElement('div');
      eventDiv.className = `vh-processing-event`;
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'vh-processing-time';
      timeSpan.textContent = event.timestamp;
      
      const typeSpan = document.createElement('span');
      typeSpan.className = 'vh-processing-type';
      typeSpan.textContent = event.type;
      
      const contentSpan = document.createElement('span');
      contentSpan.className = 'vh-processing-content';
      contentSpan.textContent = event.content;
      
      eventDiv.appendChild(timeSpan);
      eventDiv.appendChild(typeSpan);
      eventDiv.appendChild(contentSpan);
      eventsContainer.appendChild(eventDiv);
    });
    
    let isExpanded = false;
    toggle.addEventListener('click', () => {
      isExpanded = !isExpanded;
      eventsContainer.style.display = isExpanded ? 'block' : 'none';
      toggle.textContent = `${isExpanded ? '▼' : '▶'} Processing Details (${events.length} events)`;
    });
    
    container.appendChild(toggle);
    container.appendChild(eventsContainer);
    return container;
  }

  // ---------- Status & UI helpers ----------
  function setStatus(text) { if (headerSmall) headerSmall.textContent = text; }
  
  // Modified to add processing events to current user message
  let currentProcessingDetails = [];
  
  function addProcessingEvent(type, content, kind = 'info') {
    const event = {
      type,
      content,
      timestamp: nowTime(),
      kind
    };
    currentProcessingDetails.push(event);
    
    // Update the transcript with current processing details
    if (transcriptId) {
      updateLastUserProcessing(transcriptId, currentProcessingDetails);
      renderTranscript();
    }
    
    return event;
  }

  function createThinkingBubble() {
    const div = document.createElement('div'); div.className = 'vh-msg agent pending';
    const flex = document.createElement('span'); flex.className = 'vh-thinking'; flex.append('thinking');
    const dots = document.createElement('span'); dots.className = 'vh-dots';
    dots.innerHTML = '<span class="vh-dot"></span><span class="vh-dot"></span><span class="vh-dot"></span>';
    flex.appendChild(dots); div.appendChild(flex); return div;
  }

  // ---------- Chat (stream) ----------
  let userId = null;
  let cfg = null;
  let agentId = null;
  let fileId = null;

  let threadId = null;
  let transcriptId = null;
  let lastRunId = null;

  function initPersistenceIds() {
    const known = getKnownThreadId(agentId);
    if (known) {
      threadId = known;
      transcriptId = threadId;
    } else {
      threadId = null;
      transcriptId = pendingTranscriptId(agentId);
    }
  }

  // Add markdown to HTML conversion function
  function markdownToHtml(markdown) {
    if (!markdown) return '';
    
    return markdown
      // Convert headers
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Convert bold and italic
      .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/gim, '<em>$1</em>')
      .replace(/_(.*?)_/gim, '<em>$1</em>')
      // Convert lists
      .replace(/^\* (.*$)/gim, '<li>$1</li>')
      .replace(/^- (.*$)/gim, '<li>$1</li>')
      // Wrap lists in ul tags
      .replace(/(<li>.*<\/li>)/gims, '<ul>$1</ul>')
      // Convert line breaks
      .replace(/\n/g, '<br>')
      // Basic sanitization (you might want to use a more robust sanitizer)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Convert back the allowed tags
      .replace(/&lt;(h1|h2|h3|strong|em|ul|li|br)&gt;/g, '<$1>')
      .replace(/&lt;\/(h1|h2|h3|strong|em|ul|li|br)&gt;/g, '</$1>');
  }

  function renderTranscript() {
    if (!transcriptId) return;
    const rows = loadTranscript(transcriptId);
    historyEl.innerHTML = '';
    
    rows.forEach(r => {
      const div = document.createElement('div');
      div.className = `vh-msg ${r.role === 'user' ? 'user' : 'agent'}`;
      
      // Use innerHTML for agent messages to render markdown formatting
      if (r.role === 'agent') {
        div.innerHTML = markdownToHtml(r.content);
      } else {
        div.textContent = r.content;
      }
      
      historyEl.appendChild(div);
      
      // Add processing details below user messages
      if (r.role === 'user' && r.processingDetails && r.processingDetails.length > 0) {
        const processingUI = createProcessingDetails(r.processingDetails);
        if (processingUI) {
          historyEl.appendChild(processingUI);
        }
      }
    });
    
    historyEl.scrollTop = historyEl.scrollHeight;
  }


  // Modified version of streamAguiReply that handles summary agent failures gracefully
  async function streamAguiReplyWithFallback(cfg, { agent_id, file_id, message }, isSummaryRequest = false) {
    const maxStreamRetries = 2; // Fewer retries for summary agent
    let streamAttempt = 0;
    let lastReceivedData = '';
    
    // Create assistant message element once and reuse it
    let assistantDiv = null;
    let assistantOut = null;
    let full = '';
    let thinking = createThinkingBubble();
    
    historyEl.appendChild(thinking);
    historyEl.scrollTop = historyEl.scrollHeight;

    // Create the assistant transcript entry once
    pushTranscript(transcriptId, 'agent', '');

    function ensureAssistant() {
      if (!assistantDiv) {
        assistantDiv = thinking;
        assistantDiv.classList.add('pending');
        assistantDiv.innerHTML = '';
        assistantOut = document.createTextNode(lastReceivedData);
        assistantDiv.appendChild(assistantOut);
        full = lastReceivedData;
      } else if (!assistantOut) {
        assistantDiv.innerHTML = '';
        assistantOut = document.createTextNode(lastReceivedData);
        assistantDiv.appendChild(assistantOut);
        full = lastReceivedData;
      }
      return assistantOut;
    }

    while (streamAttempt < maxStreamRetries) {
      streamAttempt++;
      
      try {
        if (streamAttempt > 1) {
          addProcessingEvent('RETRY', `Streaming retry attempt ${streamAttempt}/${maxStreamRetries}`, 'warn');
        }

        addProcessingEvent('SEND', `User message to agent ${agent_id}`, 'ok');

        let finalMessage;
        
        try {
          const parsed = JSON.parse(message);
          
          if (parsed.page_content) {
            // For summary requests, always use the full page context
            if (isSummaryRequest) {
              finalMessage = `=== SYSTEM INSTRUCTIONS ===
CONTEXT: The user wants a summary of the current webpage they are viewing.
Please provide a comprehensive, well-structured short descriptive summary of the webpage content below.
Focus on the main points, key information, and overall purpose. Do not make it too long.

PAGE INFORMATION:
- URL: ${parsed.page_metadata?.url || window.location.href}
- Title: ${parsed.page_metadata?.title || document.title}

PAGE CONTENT:
${parsed.page_content.substring(0, 12000)}

Please provide a clear, short and concise summary of this webpage content.`;
            } else {
              finalMessage = parsed.user_message;
            }
          } else {
            finalMessage = parsed.user_message || message;
          }
        } catch {
          finalMessage = message;
        }

        const basePayload = { 
          agent_id, 
          file_id, 
          message: finalMessage
        };

        // Don't use thread_id for summary requests to keep conversations separate
        const result = await postWithRetry(cfg, basePayload, 2, agent_id);

        if (result.mode === 'sse') {
          addProcessingEvent('SSE', `Streaming started${streamAttempt > 1 ? ` (retry ${streamAttempt})` : ''}`, 'info');
          
          try {
            let inToolCall = false;
            let currentToolCallId = null;
            
            for await (const dataLine of sseRead(result.res)) {
              let evt; 
              try { 
                evt = JSON.parse(dataLine); 
              } catch { 
                evt = null; 
              }
              
              if (!evt || !evt.type) continue;

              lastReceivedData = full;

              switch (evt.type) {
                case 'RUN_STARTED': {
                  addProcessingEvent('RUN', `Started (agent: ${agent_id})`, 'info');
                  break;
                }

                case 'TEXT_MESSAGE_START': {
                  addProcessingEvent('MSG', 'Assistant started composing', 'info');
                  ensureAssistant();
                  break;
                }

                case 'TEXT_MESSAGE_CONTENT': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    if (typeof evt.delta === 'string') {
                      full += evt.delta;
                      // Use innerHTML for markdown rendering
                      assistantDiv.innerHTML = markdownToHtml(full);
                      updateLastAssistant(transcriptId, full); // Store raw markdown
                      historyEl.scrollTop = historyEl.scrollHeight;
                    }
                  }
                  break;
                }

                case 'TEXT_DELTA':
                case 'delta': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    if (typeof evt.text === 'string') {
                      full += evt.text;
                      out.appendData(evt.text);
                      updateLastAssistant(transcriptId, out.data);
                      historyEl.scrollTop = historyEl.scrollHeight;
                    }
                  }
                  break;
                }

                case 'TOOL_CALL_START': {
                  inToolCall = true;
                  currentToolCallId = evt.toolCallId;
                  addProcessingEvent('TOOL_CALL_START', `Tool call: ${evt.toolCallName || 'unknown'}`, 'info');
                  break;
                }

                case 'TOOL_CALL_ARGS': {
                  if (evt.toolCallId === currentToolCallId) {
                    addProcessingEvent('TOOL_CALL_ARGS', 'Processing tool arguments...', 'info');
                  }
                  break;
                }

                case 'TOOL_CALL_END': {
                  if (evt.toolCallId === currentToolCallId) {
                    inToolCall = false;
                    currentToolCallId = null;
                    addProcessingEvent('TOOL_CALL_END', 'Tool call completed', 'info');
                  }
                  break;
                }

                case 'TEXT_MESSAGE_END':
                case 'final':
                case 'message': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    const content =
                      typeof evt.content === 'string' ? evt.content :
                        typeof evt.text === 'string' ? evt.text :
                          '';
                    // If no deltas were seen, write the final content once
                    if (content && full.length === 0) {
                      full = content;
                      out.appendData(content);
                      updateLastAssistant(transcriptId, out.data);
                    }
                    assistantDiv.classList.remove('pending');
                    addProcessingEvent('DONE', 'Assistant finished', 'ok');
                  }
                  break;
                }

                case 'DONE': {
                  if (!inToolCall && assistantDiv) {
                    assistantDiv.classList.remove('pending');
                    addProcessingEvent('DONE', 'Assistant finished', 'ok');
                  }
                  break;
                }

                case 'RUN_FINISHED': {
                  addProcessingEvent('RUN', `Finished (agent: ${agent_id})`, 'ok');
                  break;
                }

                case 'ERROR':
                case 'error': {
                  const msg = evt.message || 'Unknown error';
                  addProcessingEvent('ERR', msg, 'err');
                  throw new Error(msg);
                }

                default: {
                  const desc = Object.keys(evt).length > 1 ? JSON.stringify(evt) : '';
                  addProcessingEvent(evt.type, desc || 'event', 'warn');
                  break;
                }
              }
            }
            
            if (assistantDiv) assistantDiv.classList.remove('pending');
            else if (thinking.parentNode) thinking.remove();
            
            addProcessingEvent('SSE', 'Stream completed successfully', 'info');
            return;
            
          } catch (streamError) {
            console.error('🔧 [NETWORK] Stream error:', streamError);
            
            if (streamAttempt < maxStreamRetries) {
              addProcessingEvent('RETRY', `Stream interrupted, will retry... (${streamAttempt}/${maxStreamRetries})`, 'warn');
              continue;
            } else {
              addProcessingEvent('ERR', 'Stream failed after multiple retries', 'err');
              throw new Error('Summary agent stream failed');
            }
          }
        } else {
          // JSON fallback handling
          addProcessingEvent('HTTP', 'Non-streaming JSON response', 'info');
          const j = result.json;

          const content =
            j?.content || j?.message ||
            (typeof j === 'string' ? j : JSON.stringify(j, null, 2));
          
          // Use the existing assistant div instead of creating new one
          if (assistantDiv) {
            assistantDiv.innerHTML = markdownToHtml(content || '(no content)');
            assistantDiv.classList.remove('pending');
          } else {
            thinking.innerHTML = markdownToHtml(content || '(no content)');
            thinking.classList.remove('pending');
          }

          updateLastAssistant(transcriptId, content || '(no content)');
          addProcessingEvent('DONE', 'Completed (JSON)', 'ok');
          return;
        }
      } catch (e) {
        if (streamAttempt < maxStreamRetries && 
            (e.message.includes('NETWORK_CHANGED') || 
            e.message.includes('network connection changed') ||
            e.message.includes('Stream interrupted'))) {
          addProcessingEvent('RETRY', `Network error detected, retrying... (${streamAttempt}/${maxStreamRetries})`, 'warn');
          continue;
        } else {
          // Don't show error UI here - let the summarizePage function handle the fallback
          addProcessingEvent('ERR', e?.message || String(e), 'err');
          throw e; // Re-throw to be caught by summarizePage
        }
      }
    }
  }

  // New function to handle summarization
  async function summarizePage() {
    // Reset processing details for new message
    currentProcessingDetails = [];

    const div = document.createElement('div');
    div.className = 'vh-msg user';
    div.textContent = 'Summarize this page';
    historyEl.appendChild(div);
    historyEl.scrollTop = historyEl.scrollHeight;
    
    // Store user message with empty processing details
    pushTranscript(transcriptId, 'user', 'Summarize this page', currentProcessingDetails);

    // Add user event to processing details
    addProcessingEvent('USR', 'You requested page summary', 'ok');
    
    // Capture page content
    addProcessingEvent('PAGE', 'Capturing page content for summarization...', 'info');
    const pageContent = capturePageContent();
    const pageMetadata = getPageMetadata();
    
    addProcessingEvent('PAGE', `Captured ${pageContent.length} chars from page`, 'ok');

    const summaryMessage = {
      user_message: "Please provide a comprehensive summary of the following webpage content. Focus on the main points, key information, and overall purpose of the page.",
      page_content: pageContent,
      page_metadata: pageMetadata,
      timestamp: new Date().toISOString()
    };
    
    const messageToSend = JSON.stringify(summaryMessage);

    // Try to use summary agent (agent id - agnt_86795d15-4ac8-4ff5-aed0-b75e31b81bc4) first
    const SUMMARY_AGENT_ID = 'agnt_86795d15-4ac8-4ff5-aed0-b75e31b81bc4';
    addProcessingEvent('SUMMARY', `Attempting to use summary agent (ID: ${SUMMARY_AGENT_ID})`, 'info');

    let summarySuccess = false;
    
    try {
      // Use a simpler approach - try summary agent with shorter timeout
      await streamAguiReplyWithFallback(cfg, {
        agent_id: SUMMARY_AGENT_ID,
        file_id: fileId,
        message: messageToSend
      }, true);
      summarySuccess = true;
      
    } catch (error) {
      console.log('🔧 [SUMMARY] Summary agent failed:', error.message);
      addProcessingEvent('SUMMARY', `Summary agent failed: ${error.message}`, 'warn');
      
      // Show error message but continue with fallback
      const errorDiv = document.createElement('div');
      errorDiv.className = 'vh-msg agent error';
      errorDiv.textContent = `⚠️ Summary agent unavailable. Using current agent for summarization...`;
      historyEl.appendChild(errorDiv);
      historyEl.scrollTop = historyEl.scrollHeight;
      
      // Use current agent for summarization
      try {
        await streamAguiReply(cfg, {
          agent_id: agentId,
          file_id: fileId,
          message: messageToSend
        }, true);
        summarySuccess = true;
      } catch (fallbackError) {
        console.error('🔧 [SUMMARY] Fallback also failed:', fallbackError);
        addProcessingEvent('SUMMARY', `Fallback also failed: ${fallbackError.message}`, 'err');
      }
    }
  }

  async function streamAguiReply(cfg, { agent_id, file_id, message }, isSummaryRequest = false) {
    const maxStreamRetries = 3;
    let streamAttempt = 0;
    let lastReceivedData = '';
    
    // Create assistant message element once and reuse it
    let assistantDiv = null;
    let assistantOut = null;
    let full = '';
    let thinking = createThinkingBubble();
    
    historyEl.appendChild(thinking);
    historyEl.scrollTop = historyEl.scrollHeight;

    // Create the assistant transcript entry once
    pushTranscript(transcriptId, 'agent', '');

    function ensureAssistant() {
      if (!assistantDiv) {
        assistantDiv = thinking;
        assistantDiv.classList.add('pending');
        assistantDiv.innerHTML = '';
        assistantOut = document.createTextNode(lastReceivedData);
        assistantDiv.appendChild(assistantOut);
        full = lastReceivedData;
      } else if (!assistantOut) {
        assistantDiv.innerHTML = '';
        assistantOut = document.createTextNode(lastReceivedData);
        assistantDiv.appendChild(assistantOut);
        full = lastReceivedData;
      }
      return assistantOut;
    }

    while (streamAttempt < maxStreamRetries) {
      streamAttempt++;
      
      try {
        if (streamAttempt > 1) {
          addProcessingEvent('RETRY', `Streaming retry attempt ${streamAttempt}/${maxStreamRetries}`, 'warn');
        }

        addProcessingEvent('SEND', threadId ? 'User message (existing thread)' : 'User message (new thread)', 'ok');

        let finalMessage;
        
        try {
          const parsed = JSON.parse(message);
          
          if (parsed.page_content) {
            // For summary requests, always use the full page context
            if (isSummaryRequest) {
              finalMessage = `=== SYSTEM INSTRUCTIONS ===
CONTEXT: The user wants a summary of the current webpage they are viewing.
Please provide a comprehensive, well-structured summary of the webpage content below.
Focus on the main points, key information, and overall purpose. Don't make it too long.

PAGE INFORMATION:
- URL: ${parsed.page_metadata?.url || window.location.href}
- Title: ${parsed.page_metadata?.title || document.title}

PAGE CONTENT:
${parsed.page_content.substring(0, 12000)}

Please provide a clear, short and concise summary of this webpage content.`;
            } else {
              const userQuery = parsed.user_message.toLowerCase();
              
              const pageRelatedKeywords = [
                'page', 'website', 'site', 'current', 'this', 'here',
                'summary', 'explain', 'describe', 'what is this',
                'content', 'text', 'article', 'information'
              ];
              
              const isPageRelated = pageRelatedKeywords.some(keyword => 
                userQuery.includes(keyword)
              );
              
              if (isPageRelated) {
                finalMessage = `=== SYSTEM INSTRUCTIONS ===
CONTEXT: The user is viewing a webpage and asking about its content.
You are analyzing the CURRENT WEBPAGE that the user is viewing.
The user cannot provide additional text - you MUST use the page content provided below.
Do NOT ask for URLs, do NOT request additional content.

USER QUESTION: ${parsed.user_message}

PAGE INFORMATION:
- URL: ${parsed.page_metadata?.url || window.location.href}
- Title: ${parsed.page_metadata?.title || document.title}

PAGE CONTENT:
${parsed.page_content.substring(0, 12000)}

Please answer the user's question using the provided page content.
If they ask about any question from the page, check the content given to you in the page content.
The page content is already provided - no need to ask for it again.`;
              } else {
                finalMessage = parsed.user_message;
              }
            }
          } else {
            finalMessage = parsed.user_message || message;
          }
        } catch {
          finalMessage = message;
        }

        const basePayload = { 
          agent_id, 
          file_id, 
          message: finalMessage
        };

        if (threadId && !isSummaryRequest) basePayload.thread_id = threadId;

        // For summary requests, don't use thread_id to keep conversations separate
        const result = await postWithRetry(cfg, basePayload, 4, isSummaryRequest ? agent_id : null);

        if (result.mode === 'sse') {
          addProcessingEvent('SSE', `Streaming started${streamAttempt > 1 ? ` (retry ${streamAttempt})` : ''}`, 'info');
          
          try {
            let inToolCall = false;
            let currentToolCallId = null;
            
            for await (const dataLine of sseRead(result.res)) {
              let evt; 
              try { 
                evt = JSON.parse(dataLine); 
              } catch { 
                evt = null; 
              }
              
              if (!evt || !evt.type) continue;

              lastReceivedData = full;

              switch (evt.type) {
                case 'RUN_STARTED': {
                  if (evt.threadId && evt.threadId !== threadId && !isSummaryRequest) {
                    const newTid = evt.threadId;
                    if (!threadId) {
                      setKnownThreadId(agentId, newTid);
                      migrateTranscript(transcriptId, newTid);
                      transcriptId = newTid;
                    }
                    threadId = newTid;
                  }

                  if (evt.runId && evt.runId === lastRunId) break;
                  lastRunId = evt.runId || lastRunId;

                  addProcessingEvent('RUN', `Started (runId=${lastRunId || 'n/a'})`, 'info');
                  setStatus(
                    `API: ${cfg.base}${cfg.endpoint}\nUser: ${userId}\nAgent: ${agentId}\nThread: ${threadId || '(initializing)'}${lastRunId ? `\nRun: ${lastRunId} (started)` : ''}`
                  );
                  break;
                }

                case 'TEXT_MESSAGE_START': {
                  addProcessingEvent('MSG', 'Assistant started composing', 'info');
                  ensureAssistant();
                  break;
                }

                case 'TEXT_MESSAGE_CONTENT': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    if (typeof evt.delta === 'string') {
                      full += evt.delta;
                      // Use innerHTML for markdown rendering
                      assistantDiv.innerHTML = markdownToHtml(full);
                      updateLastAssistant(transcriptId, full); // Store raw markdown
                      historyEl.scrollTop = historyEl.scrollHeight;
                    }
                  }
                  break;
                }

                case 'TEXT_DELTA':
                case 'delta': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    if (typeof evt.text === 'string') {
                      full += evt.text;
                      // Use innerHTML for markdown rendering
                      assistantDiv.innerHTML = markdownToHtml(full);
                      updateLastAssistant(transcriptId, full); // Store raw markdown
                      historyEl.scrollTop = historyEl.scrollHeight;
                    }
                  }
                  break;
                }

                case 'TOOL_CALL_START': {
                  inToolCall = true;
                  currentToolCallId = evt.toolCallId;
                  addProcessingEvent('TOOL_CALL_START', `Tool call: ${evt.toolCallName || 'unknown'}`, 'info');
                  break;
                }

                case 'TOOL_CALL_ARGS': {
                  if (evt.toolCallId === currentToolCallId) {
                    addProcessingEvent('TOOL_CALL_ARGS', 'Processing tool arguments...', 'info');
                  }
                  break;
                }

                case 'TOOL_CALL_END': {
                  if (evt.toolCallId === currentToolCallId) {
                    inToolCall = false;
                    currentToolCallId = null;
                    addProcessingEvent('TOOL_CALL_END', 'Tool call completed', 'info');
                  }
                  break;
                }

                case 'TEXT_MESSAGE_END':
                case 'final':
                case 'message': {
                  if (!inToolCall) {
                    const out = ensureAssistant();
                    const content =
                      typeof evt.content === 'string' ? evt.content :
                        typeof evt.text === 'string' ? evt.text :
                          '';
                    // If no deltas were seen, write the final content once
                    if (content && full.length === 0) {
                      full = content;
                      out.appendData(content);
                      updateLastAssistant(transcriptId, out.data);
                    }
                    assistantDiv.classList.remove('pending');
                    addProcessingEvent('DONE', 'Assistant finished', 'ok');
                  }
                  break;
                }

                case 'DONE': {
                  if (!inToolCall && assistantDiv) {
                    assistantDiv.classList.remove('pending');
                    addProcessingEvent('DONE', 'Assistant finished', 'ok');
                  }
                  break;
                }

                case 'RUN_FINISHED': {
                  addProcessingEvent('RUN', `Finished (runId=${evt.runId || 'n/a'})`, 'ok');
                  break;
                }

                case 'ERROR':
                case 'error': {
                  const msg = evt.message || 'Unknown error';
                  addProcessingEvent('ERR', msg, 'err');
                  throw new Error(msg);
                }

                default: {
                  const desc = Object.keys(evt).length > 1 ? JSON.stringify(evt) : '';
                  addProcessingEvent(evt.type, desc || 'event', 'warn');
                  break;
                }
              }
            }
            
            if (assistantDiv) assistantDiv.classList.remove('pending');
            else if (thinking.parentNode) thinking.remove();
            
            addProcessingEvent('SSE', 'Stream completed successfully', 'info');
            return;
            
          } catch (streamError) {
            console.error('🔧 [NETWORK] Stream error:', streamError);
            
            if (streamAttempt < maxStreamRetries) {
              addProcessingEvent('RETRY', `Stream interrupted, will retry... (${streamAttempt}/${maxStreamRetries})`, 'warn');
              continue;
            } else {
              addProcessingEvent('ERR', 'Stream failed after multiple retries', 'err');
              
              // Show error in the same assistant message
              if (assistantDiv) {
                assistantDiv.classList.remove('pending');
                assistantDiv.classList.add('error');
                assistantDiv.textContent = `⚠️ Network connection changed during streaming - max retries exceeded`;
                updateLastAssistant(transcriptId, assistantDiv.textContent);
              }
              return;
            }
          }
        } else {
          // JSON fallback handling
          addProcessingEvent('HTTP', 'Non-streaming JSON response', 'info');
          const j = result.json;

          if (!threadId && !isSummaryRequest) {
            const newTid = j.threadId || j.thread_id;
            if (newTid) {
              setKnownThreadId(agentId, newTid);
              migrateTranscript(transcriptId, newTid);
              transcriptId = newTid;
              threadId = newTid;
              setStatus(`API: ${cfg.base}${cfg.endpoint}\nUser: ${userId}\nAgent: ${agentId}\nThread: ${threadId}`);
            }
          }

          const content =
            j?.content || j?.message ||
            (typeof j === 'string' ? j : JSON.stringify(j, null, 2));

          // Use the existing assistant div instead of creating new one
          if (assistantDiv) {
            assistantDiv.innerHTML = '';
            assistantDiv.appendChild(document.createTextNode(content || '(no content)'));
            assistantDiv.classList.remove('pending');
          } else {
            thinking.innerHTML = '';
            thinking.appendChild(document.createTextNode(content || '(no content)'));
            thinking.classList.remove('pending');
          }
          
          updateLastAssistant(transcriptId, content || '(no content)');
          addProcessingEvent('DONE', 'Completed (JSON)', 'ok');
          return;
        }

      } catch (e) {
        if (streamAttempt < maxStreamRetries && 
            (e.message.includes('NETWORK_CHANGED') || 
            e.message.includes('network connection changed') ||
            e.message.includes('Stream interrupted'))) {
          addProcessingEvent('RETRY', `Network error detected, retrying... (${streamAttempt}/${maxStreamRetries})`, 'warn');
          continue;
        } else {
             // ending part //
           // Show error in the existing assistant message
          // Show error with retry button beside the assistant bubble
          if (assistantDiv) {
            assistantDiv.classList.remove('pending');
            assistantDiv.classList.add('error');
            const errorText = document.createElement('span');
            errorText.textContent = `⚠️ ${e?.message || 'Message failed'}`;
            const retryBtn = document.createElement('button');
            retryBtn.className = 'vh-retry-btn';
            retryBtn.innerHTML = '⟳';
            retryBtn.addEventListener('click', async () => {
              retryBtn.disabled = true;
              retryBtn.style.opacity = '0.6';
              retryBtn.style.transform = 'rotate(360deg)';
              await streamAguiReply(cfg, payload);// Resend assistant response
              retryBtn.remove();
            });
            assistantDiv.innerHTML = '';
            assistantDiv.appendChild(retryBtn);
            assistantDiv.appendChild(errorText);
            
            updateLastAssistant(transcriptId, errorText.textContent);
          }

          
          addProcessingEvent('ERR', e?.message || String(e), 'err');
          throw e; 
        }
      }
    }
  }

  function extractAllTextContent(element) {
    const clone = element.cloneNode(true);
    
    // ONLY remove script and style tags for cleanliness, keep everything else
    const removals = clone.querySelectorAll('script, style');
    removals.forEach(el => el.remove());
    
    function getCompleteTextContent(node) {
      let text = '';
      
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = child.tagName.toLowerCase();
          
          // Add appropriate spacing/formatting based on element type
          const blockElements = ['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                                'section', 'article', 'ul', 'ol', 'blockquote', 'header',
                                'footer', 'nav', 'aside', 'main', 'form'];
          const isBlockElement = blockElements.includes(tagName);
          
          // Add line breaks before block elements for readability
          if (isBlockElement && text && !text.endsWith('\n')) {
            text += '\n';
          }
          
          text += getCompleteTextContent(child);
          
          // Add line breaks after block elements
          if (isBlockElement && !text.endsWith('\n')) {
            text += '\n';
          }
          
          // Handle specific elements
          if (tagName === 'br') {
            text += '\n';
          }
        }
      }
      
      return text;
    }

    let text = getCompleteTextContent(clone);
    
    // Light cleanup - preserve most whitespace for readability
    text = text
      .replace(/\n{4,}/g, '\n\n\n') // Max 3 consecutive line breaks
      .replace(/[ \t]+\n/g, '\n')   // Remove trailing spaces before line breaks
      .replace(/\n[ \t]+/g, '\n')   // Remove leading spaces after line breaks
      .trim();
    
    return text;
  }

  // ---------- Page Content Capture ----------
  function capturePageContent() {
    try {
      // Create a clean clone of the entire document body
      const bodyClone = document.body.cloneNode(true);
      
      // ONLY remove our extension root and nothing else
      const extensionRoot = bodyClone.querySelector('#vh-agui-root');
      if (extensionRoot) {
        extensionRoot.remove();
      }
      
      // Extract ALL text content from the entire page (except our extension)
      const fullContent = extractAllTextContent(bodyClone);
      
      return fullContent.substring(0, 20000); // Increased limit to capture more content
    } catch (error) {
      console.warn('Failed to capture page content:', error);
      return '';
    }
  }


  function extractTextContent(element) {
    const clone = element.cloneNode(true);
    
    // Remove unwanted elements
    const removals = clone.querySelectorAll(
      'script, style, nav, header, footer, aside, .sidebar, .ad, .advertisement, .navbar, .menu, [role="navigation"], #vh-agui-root, .vh-bubble, .vh-sidebar, .vh-header, .vh-sub, .vh-status, .vh-history, .vh-input, .vh-msg, .vh-processing-details'
    );
    removals.forEach(el => el.remove());
    
    const extensionElements = clone.querySelectorAll('[class*="vh-"], [id*="vh-"]');
    extensionElements.forEach(el => el.remove());
    
    function getTextWithFormatting(node) {
      let text = '';
      
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = child.tagName.toLowerCase();
          const blockElements = ['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'ul', 'ol', 'blockquote'];
          const isBlockElement = blockElements.includes(tagName);
          
          // Add line break before block elements (except first child)
          if (isBlockElement && text && !text.endsWith('\n')) {
            text += '\n';
          }
          
          text += getTextWithFormatting(child);
          
          // Add line break after block elements
          if (isBlockElement && !text.endsWith('\n')) {
            text += '\n';
          }
          
          // Special handling for specific elements
          if (tagName === 'br') {
            text += '\n';
          }
        }
      }
      
      return text;
    }
  
  let text = getTextWithFormatting(clone);
  
  // Conservative cleanup - preserve meaningful whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive line breaks
    .replace(/[ \t]+\n/g, '\n') // Remove trailing spaces
    .replace(/\n[ \t]+/g, '\n') // Remove leading spaces after breaks
    .replace(/[ \t]{2,}/g, ' ') // Collapse multiple spaces
    .trim();
  
  return text;
}

  function isSubstantialContent(element) {
    // Skip if this element contains our extension
    if (element.querySelector('#vh-agui-root') || 
        element.querySelector('.vh-sidebar') || 
        element.querySelector('.vh-bubble') ||
        element.classList.contains('vh-sidebar') ||
        element.classList.contains('vh-bubble')) {
      return false;
    }
    
    const text = element.textContent || '';
    return text.length > 100 && text.split(/\s+/).length > 20;
  }

  // Simple metadata - just URL and title
  function getPageMetadata() {
    return {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString()
    };
  }

  // ---------- Sidebar ----------
  function buildSidebar() {
    const el = document.createElement('div');
    el.className = 'vh-sidebar';
    el.innerHTML = `
      <div class="vh-header">
        <div class="vh-title">${getExtensionName()} Agent Chat</div>
        <div class="vh-actions">
          <button class="vh-btn summarize" id="vh-summarize" title="Summarize this page">Summarize</button>
          <button class="vh-btn" id="vh-refresh">Refresh</button>
          <button class="vh-btn" id="vh-close">Close</button>
        </div>
      </div>
      <div class="vh-sub" id="vh-sub">Loading…</div>
      <div class="vh-status" id="vh-status"></div>
      <div class="vh-history" id="vh-history" tabindex="0"></div>
      <div class="vh-input">
        <textarea id="vh-textarea" placeholder="Type a message… (Ctrl/Cmd+Enter to send)" rows="2"></textarea>
        <button class="vh-send" id="vh-send">Send</button>
      </div>
    `;
    shadow.appendChild(el);

    historyEl = qs('#vh-history', el);
    textarea = qs('#vh-textarea', el);
    sendBtn = qs('#vh-send', el);
    closeBtn = qs('#vh-close', el);
    refreshBtn = qs('#vh-refresh', el);
    summarizeBtn = qs('#vh-summarize', el);
    headerSmall = qs('#vh-sub', el);
    statusList = qs('#vh-status', el);

    sendBtn.addEventListener('click', onSend);
    closeBtn.addEventListener('click', closeSidebar);
    refreshBtn.addEventListener('click', renderTranscript);
    summarizeBtn.addEventListener('click', summarizePage);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });


    return el;
  }

  async function onSend() {
    const text = tidy(textarea.value);
    if (!text) return;
    textarea.value = '';

    // Reset processing details for new message
    currentProcessingDetails = [];

    const div = document.createElement('div');
    div.className = 'vh-msg user';
    // Create wrapper for message text
    const textWrap = document.createElement('div');
    textWrap.className = 'vh-msg-text';
    textWrap.textContent = text;
    
    div.appendChild(textWrap);
    historyEl.appendChild(div);
    historyEl.scrollTop = historyEl.scrollHeight;

    
    // Store user message with empty processing details
    pushTranscript(transcriptId, 'user', text, currentProcessingDetails);

    // Add user event to processing details
    addProcessingEvent('USR', 'You sent a message', 'ok');
    
    // Capture ALL page content at once
    addProcessingEvent('PAGE', 'Capturing complete page content...', 'info');
    const pageContent = capturePageContent();
    const pageMetadata = getPageMetadata();
    
    addProcessingEvent('PAGE', `Captured ${pageContent.length} characters from entire page`, 'ok');

    const enhancedMessage = {
      user_message: text,
      page_content: pageContent,
      page_metadata: pageMetadata,
      timestamp: new Date().toISOString()
    };
    
    const messageToSend = JSON.stringify(enhancedMessage);
    try {
      await streamAguiReply(cfg, {
        agent_id: agentId,
        file_id: fileId,
        message: messageToSend
      });
    } catch (e) {
      console.error("User message failed:", e);
      const lastUserBubble = historyEl.querySelector('.vh-msg.user:last-child');
      if (lastUserBubble) {
        lastUserBubble.classList.add('error');
        const retryBtn = document.createElement('button');
        retryBtn.className = 'vh-retry-btn';
        retryBtn.innerHTML = '⟳';
        
        retryBtn.addEventListener('click', async () => {
          retryBtn.disabled = true;
          retryBtn.style.opacity = '0.6';
          retryBtn.style.transform = 'rotate(360deg)';
          await onSend();
          retryBtn.remove();
        });
        // IMPORTANT CHANGE HERE:
        lastUserBubble.appendChild(retryBtn);
      }
    }
  }
  
  async function openSidebar() {
    if (sidebar) return;
    sidebar = buildSidebar();
    requestAnimationFrame(async () => {
      sidebar.classList.add('open');
      bubble.style.display = 'none';
      try {
        const uid = await getOrCreateUserId(); userId = uid;
        cfg = await getSettingsOrThrow();
        agentId = cfg.agentId; fileId = cfg.fileId;

        initPersistenceIds();

        setStatus(`API: ${cfg.base}${cfg.endpoint}\nUser: ${userId}\nAgent: ${agentId}\nThread: ${threadId || '(new on first reply)'}`);
        renderTranscript();
      } catch (e) {
        historyEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'vh-msg agent error';
        err.textContent = `⚠️ ${e?.message || e}`;
        historyEl.appendChild(err);
      }
    });
  }

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    const el = sidebar;
    el.addEventListener('transitionend', () => { if (el.parentNode) el.parentNode.removeChild(el); }, { once: true });
    sidebar = null;
    bubble.style.display = '';
  }

  function toggleSidebar() { if (sidebar) closeSidebar(); else openSidebar(); }

  bubble.addEventListener('click', openSidebar);
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'AGUI_TOGGLE') toggleSidebar(); 
  
  });   // end of the code//

})();
