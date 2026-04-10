/**
 * Brand Concierge — Portable embeddable widget
 *
 * Usage:
 *   import { init, open, hasConversation } from './brand-concierge.js';
 *   init({ supabaseUrl: '...', supabaseAnonKey: '...', siteKey: 'mybrand' });
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
let questionCount = 0;
const history = [];

/* ── helpers ──────────────────────────────────────────── */
function headers() {
  return {
    'Content-Type': 'application/json',
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
  };
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
          link.textContent = 'Have a rep reach out - or add your email to save time';
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
    const reply = cfg.emailReply;
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
    const resp = await fetch(`${cfg.supabaseUrl}/functions/v1/brand-chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: text, site_key: cfg.siteKey }),
    });
    const data = await resp.json();
    thinking.remove();

    let reply = data.text || '';
    const citations = data.citations || [];
    const suggestions = data.suggestions || [];
    if (data.contactUrl) cfg.contactUrl = data.contactUrl;
    if (!reply) reply = "I wasn't able to find an answer. Please try rephrasing your question.";

    reply = reply.replace(/【[^】]*】/g, '');
    if (shouldShowContact(text)) suggestions.push('__CONTACT__');

    addMessage(messagesContainer, reply, 'assistant', citations, suggestions);
    history.push({ role: 'assistant', content: reply, citations, suggestions });
  } catch {
    thinking.remove();
    addMessage(messagesContainer, 'Something went wrong. Please try again.', 'assistant');
  }
}

/* ── modal ────────────────────────────────────────────── */
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

  const gearBtn = document.createElement('button');
  gearBtn.className = 'bc-gear';
  gearBtn.type = 'button';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'bc-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  closeBtn.addEventListener('click', closeModal);

  header.append(gearBtn);
  header.append(closeBtn);
  dialog.append(header);

  // Settings panel
  const settings = document.createElement('div');
  settings.className = 'bc-settings';
  settings.innerHTML = `
    <label>Site Key<input type="text" class="bcs-site-key" value="${cfg.siteKey}"></label>
    <label>Domains<input type="text" class="bcs-domains" placeholder="example.com"></label>
    <label>Instructions<textarea class="bcs-instructions" rows="3" placeholder="Custom prompt (optional)"></textarea></label>
    <label>Vector Store ID<input type="text" class="bcs-vector-store" placeholder="vs_abc123 (optional)"></label>
    <label>Contact URL<input type="text" class="bcs-contact-url" placeholder="https://..."></label>
    <div class="bcs-actions"><button type="button" class="bcs-load">Load</button><button type="button" class="bcs-save">Save</button></div>`;

  settings.querySelector('.bcs-load').addEventListener('click', async () => {
    const key = settings.querySelector('.bcs-site-key').value.trim();
    if (!key) return;
    try {
      const r = await fetch(`${cfg.supabaseUrl}/functions/v1/brand-config?site_key=${key}`, { headers: headers() });
      const c = await r.json();
      if (c.error) return;
      settings.querySelector('.bcs-domains').value = (c.domains || []).join(', ');
      settings.querySelector('.bcs-instructions').value = c.instructions || '';
      settings.querySelector('.bcs-vector-store').value = c.vector_store_id || '';
      settings.querySelector('.bcs-contact-url').value = c.contact_url || '';
      cfg.siteKey = key;
      if (c.contact_url) cfg.contactUrl = c.contact_url;
    } catch { /* ignore */ }
  });

  settings.querySelector('.bcs-save').addEventListener('click', async () => {
    const key = settings.querySelector('.bcs-site-key').value.trim();
    if (!key) return;
    const domains = settings.querySelector('.bcs-domains').value.split(',').map((d) => d.trim()).filter(Boolean);
    const body = {
      site_key: key, domains, brand_name: key,
      instructions: settings.querySelector('.bcs-instructions').value,
      vector_store_id: settings.querySelector('.bcs-vector-store').value || null,
      contact_url: settings.querySelector('.bcs-contact-url').value || null,
    };
    try {
      await fetch(`${cfg.supabaseUrl}/functions/v1/brand-config`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      cfg.siteKey = key;
      if (body.contact_url) cfg.contactUrl = body.contact_url;
      settings.classList.remove('active');
    } catch { /* ignore */ }
  });

  gearBtn.addEventListener('click', () => settings.classList.toggle('active'));
  dialog.append(settings);

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

/* ── public API ───────────────────────────────────────── */
export function init(options) {
  cfg = { ...cfg, ...options };
}

export function hasConversation() {
  return history.length > 0;
}

export default function open(query) {
  if (modal) return;

  // Auto-load CSS next to this script
  if (!document.querySelector('link[href*="brand-concierge.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const thisScript = document.querySelector('script[src*="brand-concierge"]');
    const base = thisScript ? thisScript.src.replace(/[^/]+$/, '') : '';
    link.href = `${base}brand-concierge.css`;
    document.head.append(link);
  }

  buildModal(query);
}

/* ── auto-init from script data attributes ────────────── */
(function autoInit() {
  const el = document.querySelector('script[data-site-key]');
  if (!el) return;
  init({
    supabaseUrl: el.dataset.supabaseUrl || '',
    anonKey: el.dataset.supabaseAnonKey || '',
    siteKey: el.dataset.siteKey || '',
    title: el.dataset.title || cfg.title,
  });
}());
