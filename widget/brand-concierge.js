/**
 * Brand Concierge — Portable embeddable widget
 *
 * Usage:
 *   import { init, open, hasConversation } from './brand-concierge.js';
 *   init({ supabaseUrl: '...', anonKey: '...', siteKey: 'mybrand' });
 *   open();            // opens modal (empty or with prior conversation)
 *   open('question');  // opens modal and sends question immediately
 *
 * Or auto-init via script tag:
 *   <script type="module" src="brand-concierge.js"
 *     data-supabase-url="https://xxx.supabase.co"
 *     data-supabase-anon-key="eyJ..."
 *     data-site-key="mybrand"></script>
 */

const WIDGET_VERSION = '2.0.0';

/* ── state ────────────────────────────────────────────── */
let cfg = {
  supabaseUrl: '',
  anonKey: '',
  siteKey: '',
  brandName: '',
  contactUrl: '',
  title: 'Ask the Brand Concierge',
  disclaimer: 'AI responses may be inaccurate and any offers provided are non-binding.',
  disclaimerLink: '',
  disclaimerLinkText: '',
  emailReply: 'A representative will be in touch very soon!',
  initialPrompt: 'Ask me a question...',
  chatTitle: '',
  showTrigger: false,
  triggerStyle: 'bubble',
  triggerLabel: '',
  widgetBase: '',
  noCssAutoLoad: false,
};

const CONTACT_PHRASES = [
  'contact me', 'contact us', 'reach out', 'speak with',
  'talk to', 'call me', 'rep', 'representative',
  'advisor', 'adviser', 'someone to help',
];

let modal = null;
let configLoaded = false;
let configSaving = null; // promise from auto-save
let initialized = false;
let questionCount = 0;
let lastResponseId = null;
const history = [];
let ratings = {};

// Avatar state
let triggerObserver = null;
let heygenAvatarId = null;
let heygenEnabled = false;
let heygenSessionId = null;
let heygenRoom = null;
let heygenVideoEl = null;

/* ── helpers ──────────────────────────────────────────── */
function ridKey() { return `bc_rid_${cfg.siteKey}`; }
function loadResponseId() { try { lastResponseId = localStorage.getItem(ridKey()) || null; } catch { lastResponseId = null; } }
function saveResponseId(id) { try { localStorage.setItem(ridKey(), id); } catch { /* ignore */ } }
function clearResponseId() { try { localStorage.removeItem(ridKey()); } catch { /* ignore */ } lastResponseId = null; }

function ratKey() { return `bc_ratings_${cfg.siteKey}`; }
function clearRatings() {
  Object.keys(ratings).forEach((k) => delete ratings[k]);
  try { localStorage.removeItem(ratKey()); } catch { /* ignore */ }
}
function saveRating(idx, val) {
  if (val == null) { delete ratings[idx]; } else { ratings[idx] = val; }
  try { localStorage.setItem(ratKey(), JSON.stringify(ratings)); } catch { /* ignore */ }
}

function hdrs() {
  return {
    'Content-Type': 'application/json',
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
  };
}

function toSiteKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function markdownToHtml(md) {
  let h = md;
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Linkify bare URLs not already inside an href
  h = h.replace(/(?<!href=["'])(https?:\/\/[^\s<>"')\]]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/^---$/gm, '<hr>');
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^\|[-| ]+\|$/gm, '');
  h = h.replace(/^\|(.+)\|$/gm, (_, row) => {
    const tds = row.split('|').map((c) => `<td>${c.trim()}</td>`).join('');
    return `<tr>${tds}</tr>`;
  });
  h = h.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  h = h.split('\n').map((l) => {
    const t = l.trim();
    if (!t || t.startsWith('<')) return t;
    return `<p>${t}</p>`;
  }).join('\n');
  return h;
}

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

function rephraseAsUser(q) {
  const rewrites = [
    [/^Want\s+/i, "I'd like "],
    [/^Would you like\s+/i, "I'd like "],
    [/^Would you want\s+/i, "I'd like "],
    [/^Are you interested in\s+/i, "Tell me about "],
    [/^Interested in\s+/i, "Tell me about "],
    [/^Looking for\s+/i, "I'm looking for "],
    [/^Need\s+/i, "I need "],
  ];
  for (const [pattern, replacement] of rewrites) {
    if (pattern.test(q)) {
      return q.replace(pattern, replacement).replace(/\?$/, '');
    }
  }
  return q;
}

function shouldShowContact(text) {
  const lower = text.toLowerCase();
  return CONTACT_PHRASES.some((p) => lower.includes(p)) || questionCount >= 5;
}

/* ── config API ───────────────────────────────────────── */
async function loadConfig() {
  if (!cfg.siteKey || !cfg.supabaseUrl) return false;
  try {
    const r = await fetch(
      `${cfg.supabaseUrl}/functions/v1/brand-config?site_key=${cfg.siteKey}`,
      { headers: hdrs() },
    );
    const c = await r.json();
    if (c.error) return false;
    cfg.brandName = c.brand_name || cfg.brandName;
    cfg.contactUrl = c.contact_url || cfg.contactUrl;
    cfg.initialPrompt = c.initial_prompt || 'Ask me a question...';
    cfg.chatTitle = c.chat_title || '';
    cfg.title = cfg.chatTitle || `Ask the ${cfg.brandName} Brand Concierge`;
    heygenAvatarId = c.heygen_avatar_id || null;
    configLoaded = true;
    return true;
  } catch { return false; }
}

/* ── messages ─────────────────────────────────────────── */
function addMessage(container, text, role, citations, suggestions, recommendations, bookingUrl, messageIdx, resources) {
  container.closest('.bc-dialog')?.classList.add('has-messages');
  const msg = document.createElement('div');
  msg.className = `bc-message bc-${role}`;

  if (role === 'assistant') {
    if (citations?.length) {
      const sources = document.createElement('div');
      sources.className = 'bc-citations';
      citations.forEach((c) => {
        const card = document.createElement('a');
        card.href = c.url;
        card.target = '_blank';
        card.rel = 'noopener';
        card.className = 'bc-citation-card';
        let html = '';
        if (c.image) html += `<img src="${c.image}" alt="" class="bc-citation-img">`;
        html += '<div class="bc-citation-text">';
        html += `<span class="bc-citation-title">${c.title}</span>`;
        if (c.description) html += `<span class="bc-citation-desc">${c.description}</span>`;
        try { html += `<span class="bc-citation-url">${new URL(c.url).hostname}</span>`; } catch { /* skip */ }
        html += '</div>';
        card.innerHTML = html;
        sources.append(card);
      });
      msg.append(sources);
    }

    const content = document.createElement('div');
    content.className = 'bc-content';
    content.innerHTML = markdownToHtml(text);
    msg.append(content);

    if (bookingUrl) {
      const bookBtn = document.createElement('a');
      bookBtn.href = bookingUrl;
      bookBtn.target = '_blank';
      bookBtn.rel = 'noopener';
      bookBtn.className = 'bc-book-now';
      bookBtn.textContent = 'Reserve now →';
      msg.append(bookBtn);
    }

    if (recommendations?.length) {
      const recommendationWrap = document.createElement('div');
      recommendationWrap.className = 'bc-recommendations';
      recommendations.forEach((u) => {
        const card = document.createElement('a');
        card.href = u.url;
        card.target = '_blank';
        card.rel = 'noopener';
        card.className = 'bc-recommendation-card';
        card.innerHTML = `
          ${u.image ? `<img src="${u.image}" alt="" class="bc-recommendation-img">` : ''}
          <div class="bc-recommendation-title">${u.title}</div>
          <div class="bc-recommendation-reason">${u.reason}</div>
          <div class="bc-recommendation-footer">
            <span class="bc-recommendation-price">${u.price}</span>
            <span class="bc-recommendation-cta">View in new window</span>
          </div>`;
        recommendationWrap.append(card);
      });
      msg.append(recommendationWrap);
    }

    if (resources?.length) {
      const resourceWrap = document.createElement('div');
      resourceWrap.className = 'bc-resources';
      resources.forEach((r) => {
        const card = document.createElement('a');
        card.href = r.url;
        card.target = '_blank';
        card.rel = 'noopener';
        card.className = 'bc-resource-card';
        let html = '';
        if (r.image) html += `<img src="${r.image}" alt="" class="bc-resource-img">`;
        html += '<div class="bc-resource-body">';
        html += `<span class="bc-resource-title">${r.title}</span>`;
        if (r.teaser) html += `<span class="bc-resource-teaser">${r.teaser}</span>`;
        html += '<span class="bc-resource-cta">Read article →</span>';
        html += '</div>';
        card.innerHTML = html;
        resourceWrap.append(card);
      });
      msg.append(resourceWrap);
    }

    if (suggestions?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'bc-suggestions';
      suggestions.filter((q) => q?.trim()).forEach((q) => {
        if (q === '__CONTACT__' && cfg.contactUrl) {
          const link = document.createElement('a');
          link.href = cfg.contactUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          link.className = 'bc-suggestion bc-contact';
          link.textContent = `Have a ${cfg.brandName || 'brand'} representative reach out`;
          wrap.append(link);
        } else if (q !== '__CONTACT__') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'bc-suggestion';
          btn.textContent = q;
          btn.addEventListener('click', async () => {
            wrap.remove();
            await sendMessage(container, rephraseAsUser(q));
          });
          wrap.append(btn);
        }
      });
      if (wrap.children.length) msg.append(wrap);
    }

    if (messageIdx !== undefined) {
      const feedback = document.createElement('div');
      feedback.className = 'bc-feedback';
      const thumbUp = document.createElement('button');
      thumbUp.type = 'button';
      thumbUp.className = 'bc-thumb';
      thumbUp.setAttribute('aria-label', 'Helpful');
      thumbUp.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
      const thumbDown = document.createElement('button');
      thumbDown.type = 'button';
      thumbDown.className = 'bc-thumb';
      thumbDown.setAttribute('aria-label', 'Not helpful');
      thumbDown.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
      const sync = () => {
        thumbUp.setAttribute('aria-pressed', ratings[messageIdx] === 'up' ? 'true' : 'false');
        thumbDown.setAttribute('aria-pressed', ratings[messageIdx] === 'down' ? 'true' : 'false');
      };
      sync();
      thumbUp.addEventListener('click', () => { saveRating(messageIdx, ratings[messageIdx] === 'up' ? null : 'up'); sync(); });
      thumbDown.addEventListener('click', () => { saveRating(messageIdx, ratings[messageIdx] === 'down' ? null : 'down'); sync(); });
      feedback.append(thumbUp, thumbDown);
      msg.append(feedback);
    }
  } else {
    msg.textContent = text;
  }

  container.append(msg);
  if (role === 'user') container.scrollTop = container.scrollHeight;
  else msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return msg;
}

/* ── send ─────────────────────────────────────────────── */
async function sendMessage(messagesContainer, text) {
  questionCount += 1;
  addMessage(messagesContainer, text, 'user');
  history.push({ role: 'user', content: text });

  if (isEmail(text)) {
    const reply = `A ${cfg.brandName || ''} representative will be in touch very soon!`;
    addMessage(messagesContainer, reply, 'assistant');
    history.push({ role: 'assistant', content: reply });
    return;
  }

  const thinking = document.createElement('div');
  thinking.className = 'bc-message bc-assistant bc-thinking';
  thinking.innerHTML = '<span></span><span></span><span></span>';
  messagesContainer.append(thinking);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const url = `${cfg.supabaseUrl}/functions/v1/brand-chat`;
    const payload = { message: text, site_key: cfg.siteKey, previous_response_id: lastResponseId || undefined };
    console.log('[brand-concierge] POST', url, payload);

    const resp = await fetch(url, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify(payload),
    });

    console.log('[brand-concierge] status:', resp.status);
    const data = await resp.json();
    console.log('[brand-concierge] response:', data);
    thinking.remove();

    if (data.error) {
      console.error('[brand-concierge] API error:', data.error);
    }
    if (data.debug) {
      console.warn('[brand-concierge] debug:', data.debug);
    }

    let reply = data.text || '';
    const citations = data.citations || [];
    const suggestions = data.suggestions || [];
    const recommendations = data.recommendations || [];
    const resources = data.resources || [];
    const bookingUrl = data.booking_url || null;
    if (data.contactUrl) cfg.contactUrl = data.contactUrl;
    if (data.thread_reset) {
      clearResponseId();
      clearRatings();
    } else if (data.response_id) {
      lastResponseId = data.response_id;
      saveResponseId(data.response_id);
    }
    if (!reply) reply = "I wasn't able to find an answer. Please try rephrasing your question.";

    reply = reply.replace(/【[^】]*】/g, '');
    if (shouldShowContact(text)) suggestions.push('__CONTACT__');

    if (heygenEnabled && heygenRoom) {
      heygenSpeak(reply);
    } else {
      addMessage(messagesContainer, reply, 'assistant', citations, suggestions, recommendations, bookingUrl, history.length, resources);
    }
    history.push({ role: 'assistant', content: reply, citations, suggestions, recommendations, bookingUrl, resources });
  } catch (err) {
    console.error('[brand-concierge] fetch error:', err);
    thinking.remove();
    addMessage(messagesContainer, 'Something went wrong. Please try again.', 'assistant');
  }
}

/* ── heygen avatar ────────────────────────────────────── */
async function heygenPost(action, body) {
  const r = await fetch(`${cfg.supabaseUrl}/functions/v1/brand-heygen`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ action, ...body }),
  });
  return r.json();
}

// Send text for the avatar to speak, over the LiveKit agent-control data channel.
function heygenSpeak(text) {
  if (!heygenRoom || !text) return;
  const evt = JSON.stringify({
    event_id: crypto.randomUUID(),
    event_type: 'avatar.speak_text',
    session_id: heygenSessionId,
    text,
  });
  heygenRoom.localParticipant.publishData(
    new TextEncoder().encode(evt),
    { reliable: true, topic: 'agent-control' },
  ).catch(console.error);
}

// Stop a LiveAvatar session so it doesn't leak toward the concurrency cap.
// Pass keepalive=true from unload handlers so the request survives the page
// going away (a normal fetch is cancelled on unload).
function stopHeygenSession(sessionId, keepalive) {
  if (!sessionId) return;
  try {
    fetch(`${cfg.supabaseUrl}/functions/v1/brand-heygen`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ action: 'stop_session', session_id: sessionId }),
      keepalive: !!keepalive,
    }).catch(() => {});
  } catch { /* ignore */ }
}

// Register once: if the tab is closed/navigated away while a session is live,
// tear it down so it isn't left running until LiveAvatar's idle timeout.
let unloadCleanupRegistered = false;
function ensureUnloadCleanup() {
  if (unloadCleanupRegistered) return;
  unloadCleanupRegistered = true;
  const handler = () => { if (heygenSessionId) stopHeygenSession(heygenSessionId, true); };
  window.addEventListener('pagehide', handler);
  window.addEventListener('beforeunload', handler);
}

function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load LiveKit SDK'));
    document.head.appendChild(s);
  });
}

async function startAvatar(videoEl, toggleBtn) {
  if (!heygenAvatarId) return;
  let startedSessionId = null; // track so we can reclaim it if startup fails
  try {
    toggleBtn.disabled = true;
    ensureUnloadCleanup();
    const result = await heygenPost('start_session', { avatar_id: heygenAvatarId });
    if (result.error) throw new Error(`LiveAvatar: ${result.error}`);
    const { session_id, livekit_url, livekit_client_token } = result;
    startedSessionId = session_id || null;
    if (!session_id || !livekit_url) throw new Error('No session data in response');

    await loadLiveKit();
    const { Room, RoomEvent } = window.LivekitClient;

    const room = new Room();
    heygenRoom = room;
    heygenSessionId = session_id;

    // Prime the avatar with a greeting the moment it's live. The speak command
    // goes over the agent-control data channel, but LiveKit only delivers to
    // participants already connected — if the LiveAvatar agent hasn't joined
    // yet the command is silently dropped. Rather than guess when/what the
    // agent is, we retry on a backoff and stop as soon as the avatar reports it
    // started speaking (agent-response channel).
    const primeName = cfg.chatTitle || `${cfg.brandName ? cfg.brandName + ' ' : ''}Brand Concierge`;
    const primeText = `Hi! I'm ${primeName}. You can type a question below to get started.`;
    let primed = false;
    let videoLive = false;

    // Any speak acknowledgement means priming (or a later reply) has landed.
    room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
      if (topic !== 'agent-response') return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        const t = msg.event_type || msg.type;
        if (t === 'avatar.speak_started' || t === 'agent.speak_started') primed = true;
      } catch { /* ignore */ }
    });

    const primeWithRetries = async () => {
      for (const delay of [500, 1200, 2200, 3500, 5000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (primed || !heygenRoom) return;
        console.log('[avatar] priming attempt');
        heygenSpeak(primeText);
      }
    };

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') {
        track.attach(videoEl);
        if (!videoLive) { videoLive = true; primeWithRetries(); }
      } else if (track.kind === 'audio') {
        const audioEl = track.attach();
        document.body.appendChild(audioEl);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });

    await room.connect(livekit_url, livekit_client_token);

    heygenEnabled = true;
    toggleBtn.disabled = false;
    toggleBtn.setAttribute('aria-pressed', 'true');
    toggleBtn.title = 'Switch to text';
    videoEl.closest('.bc-dialog').classList.add('has-messages');
    videoEl.classList.remove('bc-avatar-hidden');
    videoEl.closest('.bc-messages-wrap').querySelector('.bc-messages').classList.add('bc-avatar-hidden');
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[avatar] start failed:', msg);
    // If a session was created server-side before startup failed, stop it so
    // it doesn't leak toward the concurrency cap.
    if (heygenRoom) { try { heygenRoom.disconnect(); } catch { /* ignore */ } }
    stopHeygenSession(startedSessionId);
    toggleBtn.disabled = false;
    heygenEnabled = false;
    heygenSessionId = null;
    heygenRoom = null;
    // Fall back to text mode — add a subtle notice to the chat
    const messagesEl = videoEl.closest('.bc-messages-wrap')?.querySelector('.bc-messages');
    if (messagesEl) {
      const notice = document.createElement('div');
      notice.className = 'bc-message bc-message--system';
      notice.textContent = `Avatar unavailable: ${msg}`;
      messagesEl.appendChild(notice);
      videoEl.closest('.bc-dialog').classList.add('has-messages');
    }
  }
}

async function stopAvatar(videoEl, toggleBtn) {
  stopHeygenSession(heygenSessionId);
  if (heygenRoom) { heygenRoom.disconnect(); heygenRoom = null; }
  heygenSessionId = null;
  heygenEnabled = false;
  videoEl.srcObject = null;
  videoEl.classList.add('bc-avatar-hidden');
  videoEl.closest('.bc-messages-wrap').querySelector('.bc-messages').classList.remove('bc-avatar-hidden');
  toggleBtn.setAttribute('aria-pressed', 'false');
  toggleBtn.title = 'Switch to avatar';
  toggleBtn.disabled = false;
}

/* ── chat modal ───────────────────────────────────────── */
function closeModal() {
  if (heygenSessionId) {
    stopHeygenSession(heygenSessionId);
    if (heygenRoom) { heygenRoom.disconnect(); heygenRoom = null; }
    heygenSessionId = null;
    heygenEnabled = false;
  }
  if (modal) { modal.remove(); modal = null; document.body.style.overflow = ''; }
}

function buildModal(initialQuery) {
  const overlay = document.createElement('div');
  overlay.className = 'bc-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'bc-dialog';

  // Header
  const header = document.createElement('div');
  header.className = 'bc-header';
  header.innerHTML = `<span class="bc-title">${cfg.title}</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'bc-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  closeBtn.addEventListener('click', closeModal);

  // Avatar toggle button (only when configured for this site)
  let avatarToggleBtn = null;
  if (heygenAvatarId) {
    avatarToggleBtn = document.createElement('button');
    avatarToggleBtn.type = 'button';
    avatarToggleBtn.className = 'bc-avatar-toggle';
    avatarToggleBtn.setAttribute('aria-pressed', 'false');
    avatarToggleBtn.title = 'Switch to avatar';
    avatarToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>';
    header.append(avatarToggleBtn);
  }

  header.append(closeBtn);
  dialog.append(header);

  // Messages
  const messagesWrap = document.createElement('div');
  messagesWrap.className = 'bc-messages-wrap';

  // Avatar video element (hidden until toggled on)
  const videoEl = document.createElement('video');
  videoEl.className = 'bc-avatar-video bc-avatar-hidden';
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  heygenVideoEl = videoEl;
  messagesWrap.append(videoEl);

  const messages = document.createElement('div');
  messages.className = 'bc-messages';
  messagesWrap.append(messages);

  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'bc-scroll-btn';
  scrollBtn.type = 'button';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
  scrollBtn.addEventListener('click', () => messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' }));
  messages.addEventListener('scroll', () => {
    scrollBtn.classList.toggle('hidden', messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50);
  });
  messagesWrap.append(scrollBtn);
  dialog.append(messagesWrap);

  // Input
  const inputArea = document.createElement('div');
  inputArea.className = 'bc-input-area';
  const inputWrap = document.createElement('div');
  inputWrap.className = 'bc-input-wrap';
  const input = document.createElement('textarea');
  input.className = 'bc-input';
  input.placeholder = cfg.initialPrompt || 'Ask me a question...';
  input.rows = 1;
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value.trim();
      if (t) { input.value = ''; input.style.height = 'auto'; sendMessage(messages, t); }
    }
  });
  const sendBtn = document.createElement('button');
  sendBtn.className = 'bc-send';
  sendBtn.type = 'button';
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  sendBtn.addEventListener('click', () => {
    const t = input.value.trim();
    if (t) { input.value = ''; input.style.height = 'auto'; sendMessage(messages, t); }
  });
  inputWrap.append(input);
  inputWrap.append(sendBtn);
  inputArea.append(inputWrap);

  if (cfg.disclaimer) {
    const disc = document.createElement('p');
    disc.className = 'bc-disclaimer';
    let html = cfg.disclaimer;
    if (cfg.disclaimerLink && cfg.disclaimerLinkText) {
      html += ` <a href="${cfg.disclaimerLink}" target="_blank" rel="noopener">${cfg.disclaimerLinkText}</a>.`;
    }
    disc.innerHTML = html;
    inputArea.append(disc);
  }

  dialog.append(inputArea);
  overlay.append(dialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  if (avatarToggleBtn) {
    avatarToggleBtn.addEventListener('click', () => {
      if (heygenEnabled) {
        stopAvatar(videoEl, avatarToggleBtn);
      } else {
        startAvatar(videoEl, avatarToggleBtn);
      }
    });
    startAvatar(videoEl, avatarToggleBtn);
  }

  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  modal = overlay;

  history.forEach((m, idx) => addMessage(messages, m.content, m.role, m.citations, m.suggestions, m.recommendations, m.bookingUrl, idx, m.resources));
  if (initialQuery) sendMessage(messages, initialQuery);
}

/* ── auto-save config to Supabase ─────────────────────── */
async function autoSaveConfig() {
  if (!cfg.brandName || !cfg.domain || !cfg.supabaseUrl) return;
  const key = toSiteKey(cfg.brandName);
  if (!key) return;
  const changed = key !== cfg.siteKey;
  cfg.siteKey = key;
  cfg.title = `Ask the ${cfg.brandName} Brand Concierge`;
  if (changed) {
    history.length = 0;
    questionCount = 0;
    clearResponseId();
  }

  const domains = cfg.domain.split(',').map((d) => d.trim()).filter(Boolean);
  const body = {
    site_key: key,
    domains,
    brand_name: cfg.brandName,
    instructions: cfg.instructions || '',
    vector_store_id: cfg.vectorStoreId || null,
    contact_url: cfg.contactUrl || null,
    open_search_context: cfg.openSearchContext || null,
  };

  console.log('[brand-concierge] auto-saving config:', body);
  try {
    await fetch(`${cfg.supabaseUrl}/functions/v1/brand-config`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify(body),
    });
    configLoaded = true;
    console.log('[brand-concierge] config saved, site_key:', key);
  } catch (err) {
    console.error('[brand-concierge] config save failed:', err);
  }
}

/* ── floating trigger button ──────────────────────────── */
const ADOBE_A = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="18" viewBox="0 0 24 22" fill="none"><path d="M14.2353 21.6209L12.4925 16.7699H8.11657L11.7945 7.51237L17.3741 21.6209H24L15.1548 0.379395H8.90929L0 21.6209H14.2353Z" fill="#EB1000"/></svg>';

function buildTrigger() {
  if (document.getElementById('bc-trigger')) return;
  const btn = document.createElement('button');
  btn.id = 'bc-trigger';
  btn.type = 'button';
  btn.setAttribute('aria-label', cfg.triggerLabel || `Chat with ${cfg.brandName || 'us'}`);

  if (cfg.triggerStyle === 'tab') {
    btn.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${ADOBE_A}${cfg.triggerLabel ? `<span style="font-size:11px;font-weight:600;letter-spacing:0.03em;color:#111">${cfg.triggerLabel}</span>` : ''}</div>`;
    Object.assign(btn.style, {
      position: 'fixed',
      top: '15%',
      right: '0',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '14px 10px',
      background: '#fff',
      border: '1.5px solid #111',
      borderRight: 'none',
      borderRadius: '8px 0 0 8px',
      cursor: 'pointer',
      boxShadow: '-3px 3px 12px rgba(0,0,0,0.12)',
      fontFamily: 'system-ui, sans-serif',
      transition: 'box-shadow 0.15s, padding 0.15s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.paddingRight = '14px'; btn.style.boxShadow = '-4px 4px 16px rgba(0,0,0,0.18)'; });
    btn.addEventListener('mouseleave', () => { btn.style.paddingRight = '10px'; btn.style.boxShadow = '-3px 3px 12px rgba(0,0,0,0.12)'; });
  } else {
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${cfg.triggerLabel ? `<span>${cfg.triggerLabel}</span>` : ''}`;
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: cfg.triggerLabel ? '12px 18px' : '14px',
      background: '#12417c',
      color: '#fff',
      border: 'none',
      borderRadius: cfg.triggerLabel ? '28px' : '50%',
      cursor: 'pointer',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      fontSize: '15px',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '600',
      transition: 'transform 0.15s, box-shadow 0.15s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.06)'; btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.25)'; });
  }

  btn.addEventListener('click', () => open());
  document.body.appendChild(btn);

  // Re-inject if an SPA (e.g. React hydration) removes the trigger
  if (!triggerObserver) {
    triggerObserver = new MutationObserver(() => {
      if (!document.getElementById('bc-trigger')) buildTrigger();
    });
  }
  triggerObserver.observe(document.body, { childList: true });
}

/* ── public API ───────────────────────────────────────── */
export function init(options) {
  // Skip if already initialized with same brand
  const newKey = options.siteKey
    || toSiteKey(options.brandName || '');
  if (initialized && newKey === cfg.siteKey) return;
  initialized = true;

  cfg = { ...cfg, ...options };

  // Auto-derive siteKey from brandName if not set
  if (!cfg.siteKey && cfg.brandName) {
    cfg.siteKey = toSiteKey(cfg.brandName);
  }
  if (cfg.brandName) {
    cfg.title = `Ask the ${cfg.brandName} Brand Concierge`;
  }

  if (cfg.siteKey) loadResponseId();

  // Auto-save if brand + domain provided
  if (cfg.brandName && cfg.domain && cfg.supabaseUrl) {
    configSaving = autoSaveConfig();
  }

  if (cfg.showTrigger) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildTrigger);
    } else {
      buildTrigger();
    }
  }
}

export function hasConversation() {
  return history.length > 0;
}

export default async function open(query) {
  if (modal) return;

  // Auto-load CSS next to this script (skip if TM injected it already)
  if (!cfg.noCssAutoLoad && !document.querySelector('link[href*="brand-concierge.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const s = document.querySelector('script[src*="brand-concierge"]');
    const base = cfg.widgetBase || (s ? s.src.replace(/[^/]+$/, '') : '');
    link.href = `${base}brand-concierge.css`;
    document.head.append(link);
  }

  // Wait for any in-flight config save to complete
  if (configSaving) {
    await configSaving;
    configSaving = null;
  }

  // Try to load config if not yet loaded
  if (!configLoaded && cfg.siteKey) {
    await loadConfig();
  }

  buildModal(query);
}

/* ── auto-init from script tags or URL params ─────────── */
(function autoInit() {
  // Try script data attributes first
  const el = document.querySelector(
    'script[data-site-key], script[data-brand]',
  );
  if (el) {
    init({
      supabaseUrl: el.dataset.supabaseUrl || '',
      anonKey: el.dataset.supabaseAnonKey || '',
      siteKey: el.dataset.siteKey || '',
      brandName: el.dataset.brand || '',
      domain: el.dataset.domain || '',
      vectorStoreId: el.dataset.vectorStore || '',
      instructions: el.dataset.instructions || '',
      contactUrl: el.dataset.contactUrl || '',
      showTrigger: el.dataset.showTrigger === 'true',
      triggerStyle: el.dataset.triggerStyle || 'bubble',
      triggerLabel: el.dataset.triggerLabel || '',
    });
    return;
  }

  // Try URL query params
  const params = new URLSearchParams(window.location.search);
  const brand = params.get('brand');
  if (brand) {
    init({
      supabaseUrl: params.get('supabase_url')
        || 'https://cyjquwhkmzyedkwuaffc.supabase.co',
      anonKey: params.get('anon_key') || '',
      brandName: brand,
      domain: params.get('domain') || '',
      vectorStoreId: params.get('vector_store') || '',
      instructions: params.get('instructions') || '',
      contactUrl: params.get('contact_url') || '',
    });
  }
}());
