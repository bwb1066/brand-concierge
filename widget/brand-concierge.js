const SUPABASE_BASE = 'https://cyjquwhkmzyedkwuaffc.supabase.co/functions/v1';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anF1d2hrbXp5ZWRrd3VhZmZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNjY4MjcsImV4cCI6MjA5MDY0MjgyN30.GkMBLXBZr9u34m4uI6ZR-2ZniLZD3RkjropjQw058k4';
const CONTACT_PHRASES = [
  'contact me', 'contact us', 'reach out', 'speak with',
  'talk to', 'call me', 'rep', 'representative',
  'advisor', 'adviser', 'someone to help',
];

// Default site key — can be overridden via settings
let siteKey = 'lordabbett';
let contactUrl = 'https://www.lordabbett.com/en-us/financial-advisor/about-us/contact-us.html';

let modal = null;
let questionCount = 0;
const conversationHistory = [];

function supaHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
  };
}

function close() {
  if (modal) {
    modal.remove();
    modal = null;
    document.body.style.overflow = '';
  }
}

function markdownToHtml(md) {
  let html = md;
  // Remove inline citation links like [text](url) — we show citations separately
  html = html.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Table rows
  html = html.replace(/^\|[-| ]+\|$/gm, '');
  html = html.replace(/^\|(.+)\|$/gm, (match, row) => {
    const cells = row.split('|').map((c) => c.trim());
    const tds = cells.map((c) => `<td>${c}</td>`).join('');
    return `<tr>${tds}</tr>`;
  });
  // Wrap consecutive <tr> in table
  html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');
  // List items
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // Paragraphs — wrap remaining non-tag lines
  html = html.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<')) return trimmed;
    return `<p>${trimmed}</p>`;
  }).join('\n');
  return html;
}

function addMessage(container, text, role, citations, suggestions) {
  const msg = document.createElement('div');
  msg.className = `concierge-message concierge-${role}`;

  if (role === 'assistant') {
    // Citations as rich cards at the top
    if (citations?.length) {
      const sources = document.createElement('div');
      sources.className = 'concierge-citations';
      citations.forEach((c) => {
        const card = document.createElement('a');
        card.href = c.url;
        card.target = '_blank';
        card.rel = 'noopener';
        card.className = 'concierge-citation-card';
        let cardHtml = '';
        if (c.image) {
          cardHtml += `<img src="${c.image}" alt="" class="concierge-citation-img">`;
        }
        cardHtml += '<div class="concierge-citation-text">';
        cardHtml += `<span class="concierge-citation-title">${c.title}</span>`;
        if (c.description) {
          cardHtml += `<span class="concierge-citation-desc">${c.description}</span>`;
        }
        const domain = new URL(c.url).hostname;
        cardHtml += `<span class="concierge-citation-url">${domain}</span>`;
        cardHtml += '</div>';
        card.innerHTML = cardHtml;
        sources.append(card);
      });
      msg.append(sources);
    }

    const content = document.createElement('div');
    content.className = 'concierge-content';
    content.innerHTML = markdownToHtml(text);
    msg.append(content);

    // Suggested follow-up questions
    if (suggestions?.length) {
      const suggestionsEl = document.createElement('div');
      suggestionsEl.className = 'concierge-suggestions';
      suggestions.filter((q) => q?.trim()).forEach((q) => {
        if (q === '__CONTACT__') {
          const link = document.createElement('a');
          link.href = contactUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          link.className = 'concierge-suggestion concierge-contact';
          link.textContent = 'Have a Lord Abbett rep reach out - or add your email to save time';
          suggestionsEl.append(link);
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'concierge-suggestion';
          btn.textContent = q;
          btn.addEventListener('click', async () => {
            suggestionsEl.remove();
            // eslint-disable-next-line no-use-before-define
            await sendMessage(container, q);
          });
          suggestionsEl.append(btn);
        }
      });
      if (suggestionsEl.children.length) msg.append(suggestionsEl);
    }
  } else {
    msg.textContent = text;
  }

  container.append(msg);
  if (role === 'user') {
    container.scrollTop = container.scrollHeight;
  } else {
    msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return msg;
}

function shouldShowContact(userText) {
  const lower = userText.toLowerCase();
  if (CONTACT_PHRASES.some((p) => lower.includes(p))) return true;
  if (questionCount >= 5) return true;
  return false;
}

function isEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
}

async function sendMessage(messagesContainer, text) {
  questionCount += 1;
  addMessage(messagesContainer, text, 'user');
  conversationHistory.push({ role: 'user', content: text });

  // Intercept email addresses — don't send to API
  if (isEmail(text)) {
    const reply = 'A Lord Abbett representative will be in touch very soon!';
    addMessage(messagesContainer, reply, 'assistant');
    conversationHistory.push({ role: 'assistant', content: reply });
    return;
  }

  const thinking = document.createElement('div');
  thinking.className = 'concierge-message concierge-assistant concierge-thinking';
  thinking.innerHTML = '<span></span><span></span><span></span>';
  messagesContainer.append(thinking);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const resp = await fetch(`${SUPABASE_BASE}/brand-chat`, {
      method: 'POST',
      headers: supaHeaders(),
      body: JSON.stringify({ message: text, site_key: siteKey }),
    });
    const data = await resp.json();
    if (data.debug) console.warn('brand-chat debug:', data.debug);
    console.log('brand-chat response:', JSON.stringify(data).slice(0, 500));

    thinking.remove();

    let reply = data.text || '';
    const citations = data.citations || [];
    const suggestions = data.suggestions || [];
    if (data.contactUrl) contactUrl = data.contactUrl;
    if (!reply) reply = 'I wasn\'t able to find an answer. Please try rephrasing your question.';

    // Remove citation markers like 【...】
    reply = reply.replace(/【[^】]*】/g, '');

    // Inject contact suggestion when appropriate
    if (shouldShowContact(text)) {
      suggestions.push('__CONTACT__');
    }

    addMessage(messagesContainer, reply, 'assistant', citations, suggestions);
    conversationHistory.push({
      role: 'assistant', content: reply, citations, suggestions,
    });
  } catch {
    thinking.remove();
    addMessage(messagesContainer, 'Something went wrong. Please try again.', 'assistant');
  }
}

function buildModal(initialQuery) {
  const overlay = document.createElement('div');
  overlay.className = 'concierge-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'concierge-dialog';

  // Header
  const header = document.createElement('div');
  header.className = 'concierge-header';
  header.innerHTML = '<span class="concierge-title"><svg class="concierge-sparkle" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M9.91819 13.2491C9.69944 13.2491 9.47874 13.1924 9.27952 13.0772C8.79807 12.7989 8.55491 12.2471 8.67307 11.7041L9.40061 8.33011L7.08225 5.77249C6.7092 5.36038 6.64475 4.76077 6.92307 4.27933C7.20139 3.79691 7.75803 3.55374 8.29612 3.67288L11.6701 4.40042L14.2278 2.08206C14.6409 1.70706 15.2405 1.64554 15.7209 1.92288C16.2024 2.2012 16.4455 2.75296 16.3274 3.29593L15.5998 6.66995L17.9182 9.22757C18.2912 9.6387 18.3547 10.2383 18.0774 10.7198C17.7991 11.2002 17.2493 11.4453 16.7053 11.3282L13.3313 10.5987L10.7727 12.918C10.5315 13.1368 10.2258 13.2491 9.91819 13.2491ZM10.8918 8.53324L10.2873 11.333L12.4094 9.40921C12.7121 9.1348 13.1301 9.02151 13.5315 9.10745L16.3332 9.71292L14.4094 7.59085C14.134 7.28616 14.0217 6.86526 14.1096 6.46487L14.7131 3.66702L12.5911 5.59085C12.2864 5.86624 11.8664 5.97757 11.4651 5.89065L8.66722 5.28713L10.5911 7.4092C10.8664 7.71291 10.9787 8.13285 10.8918 8.53324Z" fill="url(#concierge-grad-1)"/><path d="M3.34569 18.252C3.21678 18.252 3.08788 18.2188 2.97069 18.1514C2.68846 17.9883 2.54393 17.6622 2.61229 17.3438L2.91893 15.9258L1.94432 14.8516C1.72557 14.6104 1.68748 14.2549 1.85057 13.9727C2.01366 13.6905 2.34178 13.5498 2.65819 13.6143L4.07616 13.9209L5.15038 12.9463C5.39257 12.7266 5.74608 12.6895 6.02929 12.8526C6.31152 13.0157 6.45605 13.3418 6.38769 13.6602L6.08105 15.0782L7.05566 16.1524C7.27441 16.3936 7.3125 16.7491 7.14941 17.0313C6.98632 17.3135 6.65722 17.4522 6.34179 17.3897L4.92382 17.0831L3.8496 18.0577C3.708 18.1856 3.52733 18.252 3.34569 18.252Z" fill="url(#concierge-grad-2)"/><defs><linearGradient id="concierge-grad-1" x1="6.75" y1="1.75" x2="19.29" y2="3.04" gradientUnits="userSpaceOnUse"><stop stop-color="#D73220"/><stop offset="0.33" stop-color="#D92361"/><stop offset="1" stop-color="#7155FA"/></linearGradient><linearGradient id="concierge-grad-2" x1="1.75" y1="12.75" x2="7.75" y2="13.37" gradientUnits="userSpaceOnUse"><stop stop-color="#D73220"/><stop offset="0.33" stop-color="#D92361"/><stop offset="1" stop-color="#7155FA"/></linearGradient></defs></svg> Ask the Lord Abbett Concierge</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'concierge-close';
  closeBtn.type = 'button';
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  closeBtn.addEventListener('click', close);

  // Settings gear
  const gearBtn = document.createElement('button');
  gearBtn.className = 'concierge-gear';
  gearBtn.type = 'button';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  header.append(gearBtn);
  header.append(closeBtn);
  dialog.append(header);

  // Settings panel
  const settingsPanel = document.createElement('div');
  settingsPanel.className = 'concierge-settings';
  settingsPanel.innerHTML = `
    <label>Site Key
      <input type="text" class="cs-site-key" value="${siteKey}">
    </label>
    <label>Domains (comma-separated)
      <input type="text" class="cs-domains" placeholder="example.com">
    </label>
    <label>Instructions
      <textarea class="cs-instructions" rows="3"
        placeholder="Custom system prompt (optional)"></textarea>
    </label>
    <label>Vector Store ID
      <input type="text" class="cs-vector-store"
        placeholder="vs_abc123 (optional)">
    </label>
    <label>Contact URL
      <input type="text" class="cs-contact-url"
        placeholder="https://...">
    </label>
    <div class="cs-actions">
      <button type="button" class="cs-load">Load</button>
      <button type="button" class="cs-save">Save</button>
    </div>`;

  // Load config from Supabase by site_key
  const loadConfig = async () => {
    const key = settingsPanel.querySelector('.cs-site-key').value.trim();
    if (!key) return;
    try {
      const r = await fetch(
        `${SUPABASE_BASE}/brand-config?site_key=${key}`,
        { headers: supaHeaders() },
      );
      const cfg = await r.json();
      if (cfg.error) return;
      settingsPanel.querySelector('.cs-domains').value = (cfg.domains || []).join(', ');
      settingsPanel.querySelector('.cs-instructions').value = cfg.instructions || '';
      settingsPanel.querySelector('.cs-vector-store').value = cfg.vector_store_id || '';
      settingsPanel.querySelector('.cs-contact-url').value = cfg.contact_url || '';
      siteKey = key;
      if (cfg.contact_url) contactUrl = cfg.contact_url;
    } catch { /* ignore */ }
  };

  // Save config to Supabase
  const saveConfig = async () => {
    const key = settingsPanel.querySelector('.cs-site-key').value.trim();
    if (!key) return;
    const domains = settingsPanel.querySelector('.cs-domains').value
      .split(',').map((d) => d.trim()).filter(Boolean);
    const body = {
      site_key: key,
      domains,
      brand_name: key,
      instructions: settingsPanel.querySelector('.cs-instructions').value,
      vector_store_id: settingsPanel.querySelector('.cs-vector-store').value || null,
      contact_url: settingsPanel.querySelector('.cs-contact-url').value || null,
    };
    try {
      await fetch(`${SUPABASE_BASE}/brand-config`, {
        method: 'POST',
        headers: supaHeaders(),
        body: JSON.stringify(body),
      });
      siteKey = key;
      if (body.contact_url) contactUrl = body.contact_url;
      settingsPanel.classList.remove('active');
    } catch { /* ignore */ }
  };

  settingsPanel.querySelector('.cs-load').addEventListener('click', loadConfig);
  settingsPanel.querySelector('.cs-save').addEventListener('click', saveConfig);

  gearBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('active');
  });

  dialog.append(settingsPanel);

  // Messages
  const messagesWrap = document.createElement('div');
  messagesWrap.className = 'concierge-messages-wrap';

  const messages = document.createElement('div');
  messages.className = 'concierge-messages';
  messagesWrap.append(messages);

  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'concierge-scroll-btn';
  scrollBtn.type = 'button';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
  scrollBtn.addEventListener('click', () => {
    messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
  });

  // Show/hide scroll button based on scroll position
  messages.addEventListener('scroll', () => {
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
    scrollBtn.classList.toggle('hidden', atBottom);
  });

  messagesWrap.append(scrollBtn);
  dialog.append(messagesWrap);

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'concierge-input-area';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'concierge-input-wrap';

  const input = document.createElement('textarea');
  input.className = 'concierge-input';
  input.placeholder = 'Ask a question';
  input.rows = 1;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) {
        input.value = '';
        input.style.height = 'auto';
        sendMessage(messages, text);
      }
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'concierge-send';
  sendBtn.type = 'button';
  sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (text) {
      input.value = '';
      input.style.height = 'auto';
      sendMessage(messages, text);
    }
  });

  inputWrap.append(input);
  inputWrap.append(sendBtn);
  inputArea.append(inputWrap);

  const disclaimer = document.createElement('p');
  disclaimer.className = 'concierge-disclaimer';
  disclaimer.innerHTML = 'AI responses may be inaccurate and any offers provided are non-binding. <a href="https://www.adobe.com/legal/licenses-terms/adobe-gen-ai-user-guidelines.html" target="_blank" rel="noopener">Generative AI Terms</a>.';
  inputArea.append(disclaimer);

  dialog.append(inputArea);

  overlay.append(dialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  modal = overlay;

  // Restore previous conversation
  conversationHistory.forEach((msg) => {
    addMessage(messages, msg.content, msg.role, msg.citations, msg.suggestions);
  });

  // Send initial query
  if (initialQuery) {
    sendMessage(messages, initialQuery);
  }
}

export function hasConversation() {
  return conversationHistory.length > 0;
}

export default async function openConcierge(query) {
  if (modal) return;

  // Load CSS
  if (!document.querySelector('link[href*="brand-concierge.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/blocks/brand-concierge/brand-concierge.css';
    document.head.append(link);
  }

  buildModal(query);
}
