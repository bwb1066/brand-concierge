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

/* ── state ────────────────────────────────────────────── */
let cfg = {
  supabaseUrl: '',
  anonKey: '',
  siteKey: '',
  brandName: '',
  contactUrl: '',
  title: 'Brand Concierge',
  disclaimer: 'AI responses may be inaccurate and any offers provided are non-binding.',
  disclaimerLink: '',
  disclaimerLinkText: '',
  emailReply: 'A representative will be in touch very soon!',
};

const CONTACT_PHRASES = [
  'contact me', 'contact us', 'reach out', 'speak with',
  'talk to', 'call me', 'rep', 'representative',
  'advisor', 'adviser', 'someone to help',
];

let modal = null;
let configLoaded = false;
let questionCount = 0;
const history = [];

/* ── helpers ──────────────────────────────────────────── */
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
  h = h.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
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
    cfg.title = `${cfg.brandName} Concierge`;
    configLoaded = true;
    return true;
  } catch { return false; }
}

async function saveConfig(data) {
  const key = toSiteKey(data.brandName) || cfg.siteKey;
  const domains = data.domain.split(',').map((d) => d.trim()).filter(Boolean);
  const body = {
    site_key: key,
    domains,
    brand_name: data.brandName,
    instructions: data.instructions || '',
    vector_store_id: data.vectorStore || null,
    contact_url: data.contactUrl || null,
  };
  try {
    await fetch(`${cfg.supabaseUrl}/functions/v1/brand-config`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify(body),
    });
    cfg.siteKey = key;
    cfg.brandName = data.brandName;
    cfg.contactUrl = data.contactUrl || '';
    cfg.title = `${cfg.brandName} Concierge`;
    configLoaded = true;
    return true;
  } catch { return false; }
}

/* ── config panel ─────────────────────────────────────── */
function buildConfigPanel(onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'bc-overlay';

  const panel = document.createElement('div');
  panel.className = 'bc-config-panel';

  const aIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="22" viewBox="0 0 24 22" fill="none"><path d="M14.2353 21.6209L12.4925 16.7699H8.11657L11.7945 7.51237L17.3741 21.6209H24L15.1548 0.379395H8.90929L0 21.6209H14.2353Z" fill="#EB1000"></path></svg>';

  panel.innerHTML = `
    <div class="bc-config-header">
      <span class="bc-config-icon">${aIcon}</span>
      <h3 class="bc-config-title">Configuration</h3>
    </div>
    <label class="bc-config-label">Brand Name:
      <input type="text" class="bcc-brand" placeholder="My Brand" value="${cfg.brandName || ''}">
    </label>
    <label class="bc-config-label">Domain:
      <input type="text" class="bcc-domain" placeholder="example.com">
    </label>
    <label class="bc-config-label">Vector Store:
      <input type="text" class="bcc-vector" placeholder="vs_abc123 (optional)">
    </label>
    <label class="bc-config-label">Instructions:
      <textarea class="bcc-instructions" rows="4" placeholder="Custom system prompt (optional)"></textarea>
    </label>
    <label class="bc-config-label">Contact URL:
      <input type="text" class="bcc-contact" placeholder="https://... (optional)">
    </label>
    <div class="bc-config-actions">
      <button type="button" class="bcc-cancel">Cancel</button>
      <button type="button" class="bcc-save">Save</button>
    </div>`;

  // Pre-fill from existing config if available
  if (cfg.siteKey && configLoaded) {
    (async () => {
      try {
        const r = await fetch(
          `${cfg.supabaseUrl}/functions/v1/brand-config?site_key=${cfg.siteKey}`,
          { headers: hdrs() },
        );
        const c = await r.json();
        if (!c.error) {
          panel.querySelector('.bcc-brand').value = c.brand_name || '';
          panel.querySelector('.bcc-domain').value = (c.domains || []).join(', ');
          panel.querySelector('.bcc-vector').value = c.vector_store_id || '';
          panel.querySelector('.bcc-instructions').value = c.instructions || '';
          panel.querySelector('.bcc-contact').value = c.contact_url || '';
        }
      } catch { /* ignore */ }
    })();
  }

  panel.querySelector('.bcc-cancel').addEventListener('click', () => overlay.remove());

  panel.querySelector('.bcc-save').addEventListener('click', async () => {
    const data = {
      brandName: panel.querySelector('.bcc-brand').value.trim(),
      domain: panel.querySelector('.bcc-domain').value.trim(),
      vectorStore: panel.querySelector('.bcc-vector').value.trim(),
      instructions: panel.querySelector('.bcc-instructions').value.trim(),
      contactUrl: panel.querySelector('.bcc-contact').value.trim(),
    };
    if (!data.brandName || !data.domain) return;
    const ok = await saveConfig(data);
    if (ok) {
      overlay.remove();
      if (onSaved) onSaved();
    }
  });

  overlay.append(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  return overlay;
}

/* ── messages ─────────────────────────────────────────── */
function addMessage(container, text, role, citations, suggestions) {
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
            await sendMessage(container, q);
          });
          wrap.append(btn);
        }
      });
      if (wrap.children.length) msg.append(wrap);
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
    const payload = { message: text, site_key: cfg.siteKey };
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
    if (data.contactUrl) cfg.contactUrl = data.contactUrl;
    if (!reply) reply = "I wasn't able to find an answer. Please try rephrasing your question.";

    reply = reply.replace(/【[^】]*】/g, '');
    if (shouldShowContact(text)) suggestions.push('__CONTACT__');

    addMessage(messagesContainer, reply, 'assistant', citations, suggestions);
    history.push({ role: 'assistant', content: reply, citations, suggestions });
  } catch (err) {
    console.error('[brand-concierge] fetch error:', err);
    thinking.remove();
    addMessage(messagesContainer, 'Something went wrong. Please try again.', 'assistant');
  }
}

/* ── chat modal ───────────────────────────────────────── */
function closeModal() {
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

  // Config button (Adobe A)
  const configBtn = document.createElement('button');
  configBtn.className = 'bc-config-btn';
  configBtn.type = 'button';
  configBtn.setAttribute('aria-label', 'Configuration');
  configBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="22" viewBox="0 0 24 22" fill="none"><path d="M14.2353 21.6209L12.4925 16.7699H8.11657L11.7945 7.51237L17.3741 21.6209H24L15.1548 0.379395H8.90929L0 21.6209H14.2353Z" fill="#EB1000"></path></svg>';
  configBtn.addEventListener('click', () => {
    buildConfigPanel(() => {
      // Update title after config save
      header.querySelector('.bc-title').textContent = cfg.title;
    });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'bc-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  closeBtn.addEventListener('click', closeModal);

  header.append(configBtn);
  header.append(closeBtn);
  dialog.append(header);

  // Messages
  const messagesWrap = document.createElement('div');
  messagesWrap.className = 'bc-messages-wrap';
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
  input.placeholder = 'Ask a question';
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

  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  modal = overlay;

  history.forEach((m) => addMessage(messages, m.content, m.role, m.citations, m.suggestions));
  if (initialQuery) sendMessage(messages, initialQuery);
}

/* ── auto-save config to Supabase ─────────────────────── */
async function autoSaveConfig() {
  if (!cfg.brandName || !cfg.domain || !cfg.supabaseUrl) return;
  const key = toSiteKey(cfg.brandName);
  if (!key) return;
  cfg.siteKey = key;
  cfg.title = `${cfg.brandName} Concierge`;

  const domains = cfg.domain.split(',').map((d) => d.trim()).filter(Boolean);
  const body = {
    site_key: key,
    domains,
    brand_name: cfg.brandName,
    instructions: cfg.instructions || '',
    vector_store_id: cfg.vectorStoreId || null,
    contact_url: cfg.contactUrl || null,
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

/* ── public API ───────────────────────────────────────── */
export function init(options) {
  cfg = { ...cfg, ...options };

  // Auto-derive siteKey from brandName if not set
  if (!cfg.siteKey && cfg.brandName) {
    cfg.siteKey = toSiteKey(cfg.brandName);
  }
  if (cfg.brandName) {
    cfg.title = `${cfg.brandName} Concierge`;
  }

  // Auto-save if brand + domain provided
  if (cfg.brandName && cfg.domain && cfg.supabaseUrl) {
    autoSaveConfig();
  }
}

export function openConfig(onSaved) {
  buildConfigPanel(onSaved);
}

export function hasConversation() {
  return history.length > 0;
}

export default async function open(query) {
  if (modal) return;

  // Auto-load CSS next to this script
  if (!document.querySelector('link[href*="brand-concierge.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const s = document.querySelector('script[src*="brand-concierge"]');
    const base = s ? s.src.replace(/[^/]+$/, '') : '';
    link.href = `${base}brand-concierge.css`;
    document.head.append(link);
  }

  // Try to load config if not yet loaded
  if (!configLoaded && cfg.siteKey) {
    const ok = await loadConfig();
    if (!ok && !cfg.brandName) {
      buildConfigPanel(() => buildModal(query));
      return;
    }
  } else if (!configLoaded && !cfg.siteKey && !cfg.brandName) {
    buildConfigPanel(() => buildModal(query));
    return;
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
