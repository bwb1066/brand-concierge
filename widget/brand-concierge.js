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
  contactLabel: '',
  theme: {},
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
  voiceEnabled: false,
  voice: '',
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

// Voice state
let voiceMode = false;      // session opt-in (default off), persisted per site
let currentAudio = null;    // in-flight TTS playback
let recorder = null;        // active MediaRecorder
let recStream = null;       // active mic MediaStream
let isRecording = false;

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
    cfg.contactLabel = c.contact_label || '';
    cfg.theme = c.theme && typeof c.theme === 'object' ? c.theme : {};
    cfg.voiceEnabled = c.voice_enabled === true;
    cfg.voice = c.voice || '';
    cfg.commerceEnabled = c.commerce_enabled;
    if (cfg.voiceEnabled) loadVoiceMode(); else voiceMode = false;
    heygenAvatarId = c.heygen_avatar_id || null;
    configLoaded = true;
    return true;
  } catch { return false; }
}

/* Map of theme config keys → CSS custom properties. */
const THEME_VARS = {
  font: '--bc-font',
  primary: '--bc-primary',
  primaryHover: '--bc-primary-hover',
  onPrimary: '--bc-on-primary',
  link: '--bc-link',
  userBg: '--bc-user-bg',
  userInk: '--bc-user-ink',
  dialogRadius: '--bc-dialog-radius',
  cta: '--bc-cta',
  ctaInk: '--bc-cta-ink',
  ctaAdded: '--bc-cta-added',
  ctaAddedInk: '--bc-cta-added-ink',
};

/**
 * Apply the per-brand theme to a root element by setting only the CSS
 * variables for keys that are actually present in cfg.theme. Absent keys fall
 * back to the CSS defaults, so an empty/partial theme leaves rendering intact.
 * @param {Element} el root element (e.g. the .bc-overlay or trigger button)
 */
function applyTheme(el) {
  const theme = cfg.theme;
  if (!el || !theme || typeof theme !== 'object') return;
  Object.keys(THEME_VARS).forEach((key) => {
    const value = theme[key];
    if (value != null && value !== '') {
      el.style.setProperty(THEME_VARS[key], value);
    }
  });
}

/* ── voice (STT in / TTS out) ─────────────────────────── */
function voiceKey() { return `bc_voice_${cfg.siteKey}`; }
function loadVoiceMode() { try { voiceMode = localStorage.getItem(voiceKey()) === '1'; } catch { voiceMode = false; } }
function saveVoiceMode(v) { try { localStorage.setItem(voiceKey(), v ? '1' : '0'); } catch { /* ignore */ } }

/* Strip a markdown answer down to plain prose suitable for TTS. Used as a
   fallback when the backend didn't supply a spoken_summary (older deploy or
   voice mode off at request time). Drops code, images, links/URLs, and lists. */
function toSpeakable(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[#*_>`|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function stopSpeaking() {
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch { /* ignore */ }
    currentAudio = null;
  }
  document.querySelectorAll('.bc-replay.speaking').forEach((b) => b.classList.remove('speaking'));
}

/* Fetch and play TTS audio for `text`. `btn` (optional) is a replay button that
   reflects playing state. Any prior playback is stopped first. */
async function speak(text, btn) {
  const t = (text || '').trim();
  if (!t || !cfg.supabaseUrl) return;
  stopSpeaking();
  try {
    const resp = await fetch(`${cfg.supabaseUrl}/functions/v1/brand-speak`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({ text: t, voice: cfg.voice || undefined }),
    });
    if (!resp.ok) return;
    const buf = await resp.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    const audio = new Audio(url);
    currentAudio = audio;
    if (btn) btn.classList.add('speaking');
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (btn) btn.classList.remove('speaking');
      if (currentAudio === audio) currentAudio = null;
    };
    audio.addEventListener('ended', cleanup);
    audio.addEventListener('error', cleanup);
    await audio.play().catch(() => {});
  } catch (err) {
    console.error('[brand-concierge] speak error:', err);
  }
}

/* POST recorded audio to the transcribe function, return the recognized text. */
async function transcribe(blob) {
  try {
    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    const resp = await fetch(`${cfg.supabaseUrl}/functions/v1/brand-transcribe`, {
      method: 'POST',
      // No Content-Type — the browser sets the multipart boundary.
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
      body: fd,
    });
    const data = await resp.json().catch(() => ({}));
    console.log('[brand-concierge] transcribe status', resp.status, data);
    return (data.text || '').trim();
  } catch (err) {
    console.error('[brand-concierge] transcribe error:', err);
    return '';
  }
}

function stopRecording() {
  if (recorder && isRecording) { try { recorder.stop(); } catch { /* ignore */ } }
}

/* Mic capture. Tap once and talk: recording auto-stops ~1.5s after you finish
   speaking (silence detection), or after a hard cap, or on a second tap. On
   stop it transcribes and sends the result (which appears as a user message). */
async function startRecording(input, messages, micBtn) {
  try {
    stopSpeaking();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recStream = stream;
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg']
      .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];

    // Voice-activity auto-stop so users don't have to know to tap again. Watch
    // the mic's RMS level; once speech is detected, stop after a short silence.
    let audioCtx = null;
    let rafId = null;
    let spoke = false;
    const startTime = performance.now();
    let lastLoud = startTime;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const SILENCE_MS = 1500;
      const MAX_MS = 20000;
      const THRESHOLD = 0.02;
      const monitor = () => {
        if (!isRecording) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms > THRESHOLD) { spoke = true; lastLoud = now; }
        if ((spoke && now - lastLoud > SILENCE_MS) || now - startTime > MAX_MS) {
          stopRecording();
          return;
        }
        rafId = requestAnimationFrame(monitor);
      };
      rafId = requestAnimationFrame(monitor);
    } catch { /* AudioContext unsupported — fall back to manual tap-to-stop */ }

    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', async () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } }
      recStream.getTracks().forEach((tr) => tr.stop());
      recStream = null;
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.setAttribute('aria-label', 'Speak');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      console.log('[brand-concierge] recording stopped:', blob.size, 'bytes', blob.type);
      if (blob.size < 800) { // too short / no speech captured
        input.placeholder = "Didn't catch that — tap the mic and speak again";
        return;
      }
      micBtn.classList.add('busy');
      const text = await transcribe(blob);
      micBtn.classList.remove('busy');
      if (text) {
        // Show the recognized words in the composer, then send.
        input.value = text;
        input.dispatchEvent(new Event('input')); // trigger autosize
        sendMessage(messages, text);
        input.value = '';
        input.dispatchEvent(new Event('input'));
      } else {
        input.placeholder = "Didn't catch that — tap the mic and speak again";
        console.warn('[brand-concierge] transcription returned no text');
      }
    });
    recorder.start(250); // flush chunks periodically so we never lose audio
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-label', 'Stop recording');
  } catch (err) {
    console.error('[brand-concierge] mic error:', err);
    isRecording = false;
    micBtn.classList.remove('recording');
  }
}

/* ── messages ─────────────────────────────────────────── */
/**
 * Cross-surface commerce bridge. The host page exposes a generic
 * `window.brandCommerce` store only when a commerce block is present, so this
 * returns null (and the widget is unchanged) on brands without commerce.
 * A brand can also force it off with `commerce_enabled: false` in its config.
 * Backwards compatible and reusable: any replica site that ships the commerce
 * store gets concierge add-to-quote with no widget changes.
 */
function commerceBridge() {
  const bridge = (typeof window !== 'undefined') ? window.brandCommerce : null;
  if (!bridge || typeof bridge.addByQuery !== 'function') return null;
  if (cfg.commerceEnabled === false) return null;
  return bridge;
}

function addMessage(container, text, role, citations, suggestions, recommendations, bookingUrl, messageIdx, resources, spoken) {
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
        const bridge = commerceBridge();
        if (bridge) {
          const footer = card.querySelector('.bc-recommendation-footer');
          const add = document.createElement('span');
          add.className = 'bc-recommendation-add';
          add.setAttribute('role', 'button');
          add.setAttribute('tabindex', '0');
          const label = bridge.ctaLabel || 'Add to quote';
          add.textContent = label;
          const doAdd = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            add.textContent = '…';
            const res = await bridge.addByQuery(u.title, 'concierge');
            const okAdded = !!(res && !res.error);
            add.textContent = okAdded ? 'Added ✓' : 'Not in catalog';
            if (okAdded) add.classList.add('is-added');
            setTimeout(() => { add.textContent = label; add.classList.remove('is-added'); }, 1600);
          };
          add.addEventListener('click', doAdd);
          add.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') doAdd(ev);
          });
          footer.append(add);
        }
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
          link.textContent = cfg.contactLabel || `Have a ${cfg.brandName || 'brand'} representative reach out`;
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

      // Replay button — read this answer aloud (only when the brand enables voice)
      if (cfg.voiceEnabled) {
        const replay = document.createElement('button');
        replay.type = 'button';
        replay.className = 'bc-replay';
        replay.setAttribute('aria-label', 'Read aloud');
        replay.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
        replay.addEventListener('click', () => {
          if (replay.classList.contains('speaking')) { stopSpeaking(); return; }
          speak(spoken || toSpeakable(text), replay);
        });
        feedback.append(replay);
      }
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
    const payload = {
      message: text,
      site_key: cfg.siteKey,
      previous_response_id: lastResponseId || undefined,
      voice: voiceMode || undefined,
    };
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
    const spoken = data.spoken_summary || '';
    if (shouldShowContact(text)) suggestions.push('__CONTACT__');

    if (heygenEnabled && heygenRoom) {
      heygenSpeak(reply);
    } else {
      addMessage(messagesContainer, reply, 'assistant', citations, suggestions, recommendations, bookingUrl, history.length, resources, spoken);
      // Voice mode: read the answer aloud (spoken summary from the backend,
      // else a client-side prose fallback). Cards still render on screen.
      if (voiceMode) speak(spoken || toSpeakable(reply));
    }
    history.push({ role: 'assistant', content: reply, citations, suggestions, recommendations, bookingUrl, resources, spoken });
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
  stopSpeaking();
  stopRecording();
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
  applyTheme(overlay);

  const dialog = document.createElement('div');
  dialog.className = 'bc-dialog';
  if (cfg.voiceEnabled && voiceMode) dialog.classList.add('voice-on');

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

  // Voice-mode toggle (only when the brand enables voice). One tap turns the
  // whole voice experience on/off: mic input + spoken replies. Default off.
  let voiceToggleBtn = null;
  if (cfg.voiceEnabled) {
    voiceToggleBtn = document.createElement('button');
    voiceToggleBtn.type = 'button';
    voiceToggleBtn.className = 'bc-voice-toggle';
    voiceToggleBtn.setAttribute('aria-pressed', voiceMode ? 'true' : 'false');
    voiceToggleBtn.title = voiceMode ? 'Turn voice off' : 'Turn voice on';
    voiceToggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    header.append(voiceToggleBtn);
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
  // Harden the composer against host-page textarea CSS (e.g. a global
  // min-height/height rule) that would otherwise inflate it when the widget is
  // embedded on a brand's own site. Inline !important outranks host rules
  // (even host !important); auto-grow is capped at MAX_INPUT_H.
  const MAX_INPUT_H = 120;
  input.style.setProperty('min-height', '0', 'important');
  input.style.setProperty('max-height', `${MAX_INPUT_H}px`, 'important');
  input.style.setProperty('box-sizing', 'border-box', 'important');
  const autosize = () => {
    input.style.setProperty('height', 'auto', 'important');
    input.style.setProperty('height', `${Math.min(input.scrollHeight, MAX_INPUT_H)}px`, 'important');
  };
  input.addEventListener('input', autosize);
  requestAnimationFrame(autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value.trim();
      if (t) { input.value = ''; autosize(); sendMessage(messages, t); }
    }
  });
  // Mic button (only when the brand enables voice). Hidden via CSS unless voice
  // mode is on. Tap to start recording, tap again to stop → transcribe → send.
  let micBtn = null;
  if (cfg.voiceEnabled) {
    micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'bc-mic';
    micBtn.setAttribute('aria-label', 'Speak');
    micBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    micBtn.addEventListener('click', () => {
      if (isRecording) stopRecording();
      else startRecording(input, messages, micBtn);
    });
  }

  const sendBtn = document.createElement('button');
  sendBtn.className = 'bc-send';
  sendBtn.type = 'button';
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  sendBtn.addEventListener('click', () => {
    const t = input.value.trim();
    if (t) { input.value = ''; autosize(); sendMessage(messages, t); }
  });
  inputWrap.append(input);
  if (micBtn) inputWrap.append(micBtn);
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

  // Avatar is hidden by default. The toggle button only exists when an avatar
  // is configured for the brand (heygenAvatarId set), and clicking it is what
  // reveals/starts the avatar. If no avatar is configured, there is no toggle,
  // so tapping does nothing.
  if (avatarToggleBtn) {
    avatarToggleBtn.addEventListener('click', () => {
      if (heygenEnabled) {
        stopAvatar(videoEl, avatarToggleBtn);
      } else {
        startAvatar(videoEl, avatarToggleBtn);
      }
    });
  }

  if (voiceToggleBtn) {
    voiceToggleBtn.addEventListener('click', () => {
      voiceMode = !voiceMode;
      saveVoiceMode(voiceMode);
      dialog.classList.toggle('voice-on', voiceMode);
      voiceToggleBtn.setAttribute('aria-pressed', voiceMode ? 'true' : 'false');
      voiceToggleBtn.title = voiceMode ? 'Turn voice off' : 'Turn voice on';
      if (!voiceMode) { stopSpeaking(); stopRecording(); }
    });
  }

  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  modal = overlay;

  history.forEach((m, idx) => addMessage(messages, m.content, m.role, m.citations, m.suggestions, m.recommendations, m.bookingUrl, idx, m.resources, m.spoken));
  // Prefill/auto-submit: if a non-empty query was passed to open()/buildModal(),
  // send it immediately — same as a user typing it and pressing Enter.
  if (typeof initialQuery === 'string' && initialQuery.trim()) {
    sendMessage(messages, initialQuery.trim());
  }
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
  applyTheme(btn);

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
