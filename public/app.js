'use strict';

const $ = (id) => document.getElementById(id);
function readFlag(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function writeFlag(key, value) { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* preferences are optional */ } }

const state = {
  authenticated: false, authGeneration: 0, csrf: '', ownerName: '',
  devices: [], devicesLoaded: false, sessions: [], sessionsLoaded: false,
  selected: null, directory: null, browsing: false, browseSequence: 0, shownPath: '', skeletonTimer: 0,
  showHidden: readFlag('anywhere-show-hidden'), folderFilter: '',
  route: { view: 'new', id: '' }, routed: false,
  mode: 'bypassPermissions', launching: false, pendingLaunch: null, pendingStop: null, installPrompt: null,
  polls: new Map(), confirmingTrust: new Set(), submittedTrust: new Map(), trustErrors: new Map(),
  launchAttempts: new Map(), sessionChecks: new Map(), sessionFirstSeen: new Map(), actionErrors: new Map(), busy: new Set(),
  pendingRemovals: new Map(), pendingClear: null, editDevices: false
};
const ACTIVE = ['ready', 'starting'];
const MODE_LABELS = { bypassPermissions: 'Full auto', acceptEdits: 'Accept edits', default: 'Ask' };
const MODE_ICONS = { bypassPermissions: 'bolt', acceptEdits: 'pencil', default: 'shield' };
const MODE_TEXT = {
  bypassPermissions: 'Full auto: Claude reads, edits and runs anything in this folder and on this machine without asking you first.',
  acceptEdits: 'Accept edits: file edits go through without asking; commands still ask for your approval in Claude.',
  default: 'Ask: Claude asks for your approval in Claude before edits and commands.'
};
function supportsModes(device) { return (device?.capabilities || []).includes('permission-mode'); }
function modeFor(device, wanted = state.mode) { return supportsModes(device) ? wanted : 'default'; }

const icons = {
  desktop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v9M3 15h18l-1.5 3.5h-15L3 15Z"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.8"/><path d="M8 7.25h.01M8 16.75h.01"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/></svg>',
  chevron: '<svg class="folder-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M8 10H5v11h14V10h-3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" stroke="none"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path pathLength="1" d="m6 12.5 4 4 8-9"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6l-7-3Z"/></svg>',
  caret: '<svg class="side-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/><path d="M4 4l16 16"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6ZM12 15v5"/></svg>'
};
function iconButton(name, className, label, handler) {
  const button = el('button', `icon-btn xs ${className}`); button.type = 'button'; button.append(icon(name));
  button.setAttribute('aria-label', label); button.title = label;
  button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); handler(); });
  return button;
}
const iconCache = new Map();
function icon(name) {
  let template = iconCache.get(name);
  if (!template) { template = document.createElement('template'); template.innerHTML = icons[name] || icons.folder; iconCache.set(name, template); }
  return template.content.firstElementChild.cloneNode(true);
}
function withIcon(node, name) { node.prepend(icon(name)); return node; }

/* ---------- motion ---------- */
const MOTION = { press: 90, fast: 140, base: 200, slow: 320, lazy: 650, stagger: 14, out: 'cubic-bezier(.22,1,.36,1)', in: 'cubic-bezier(.4,0,1,1)', inOut: 'cubic-bezier(.65,0,.35,1)', sheet: 'cubic-bezier(.32,.72,0,1)' };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrowScreen = window.matchMedia('(max-width: 820px)');
function motionOK() { return !reducedMotion.matches && !document.hidden; }
function play(node, keyframes, options = {}) {
  if (!node || typeof node.animate !== 'function' || !motionOK()) return null;
  if (options.id) for (const running of node.getAnimations()) if (running.id === options.id) running.cancel();
  return node.animate(keyframes, { duration: MOTION.base, easing: MOTION.out, ...options });
}
function enter(node, { delay = 0, x = 0, y = 6, duration = MOTION.base } = {}) {
  return play(node, [{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'translate(0, 0)' }], { id: 'enter', delay, duration, fill: 'backwards' });
}
function leave(node) {
  node.classList.add('is-leaving');
  const animation = play(node, [{ opacity: 1 }, { opacity: 0 }], { id: 'leave', duration: MOTION.fast, easing: MOTION.in, fill: 'forwards' });
  if (animation) animation.finished.then(() => node.remove(), () => node.remove()); else node.remove();
}
function animateHeight(node, from) {
  if (!node || !Number.isFinite(from)) return;
  const to = node.offsetHeight;
  if (Math.abs(to - from) > 2) play(node, [{ height: `${from}px` }, { height: `${to}px` }], { id: 'height', duration: MOTION.slow, easing: MOTION.sheet });
}
function withAlpha(color, alpha) {
  const match = String(color).match(/rgba?\(([^)]+)\)/);
  if (!match) return `rgba(127, 127, 127, ${alpha})`;
  const [r, g, b] = match[1].split(/[\s,/]+/).filter(Boolean);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function ping(node) {
  const color = getComputedStyle(node).backgroundColor;
  play(node, [{ boxShadow: `0 0 0 0 ${withAlpha(color, .6)}` }, { boxShadow: `0 0 0 8px ${withAlpha(color, 0)}` }], { id: 'ping', duration: 800 });
}
function ring(node) {
  const color = getComputedStyle(node).backgroundColor;
  play(node, [{ boxShadow: `0 0 0 0 ${withAlpha(color, .5)}` }, { boxShadow: `0 0 0 10px ${withAlpha(color, 0)}` }], { id: 'ring', duration: 900, iterations: 2 });
}

/* ---------- stable DOM ---------- */
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function setText(node, text) { text = String(text ?? ''); if (node.textContent !== text) node.textContent = text; }
function setClass(node, className) { if (node.className !== className) node.className = className; }
function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  value = String(value); if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
function setProp(node, name, value) { if (node[name] !== value) node[name] = value; }
function setVisible(target, visible) { setProp(typeof target === 'string' ? $(target) : target, 'hidden', !visible); }
function isOnScreen(node) {
  if (document.hidden || !node.getClientRects().length) return false;
  return !node.closest('.sidebar') || !narrowScreen.matches || $('shell').classList.contains('drawer-open');
}
const keyedLists = new WeakMap();
// Keyed list update: existing nodes are patched in place, only new keys are created
// (and animated), and a refresh with unchanged data touches nothing.
function reconcile(box, items, { key, create, update, stagger = false }) {
  let record = keyedLists.get(box);
  if (!record) { record = { nodes: new Map(), painted: false }; keyedLists.set(box, record); }
  for (const child of [...box.children]) if (!child._key && !child.classList.contains('is-leaving')) child.remove();
  const keys = items.map(key); const wanted = new Set(keys); const animate = motionOK() && isOnScreen(box);
  for (const [itemKey, node] of record.nodes) if (!wanted.has(itemKey)) { record.nodes.delete(itemKey); if (animate) leave(node); else node.remove(); }
  let previous = null;
  items.forEach((item, index) => {
    let node = record.nodes.get(keys[index]); const fresh = !node;
    if (fresh) { node = create(item); node._key = keys[index]; record.nodes.set(keys[index], node); }
    update(node, item);
    let next = previous ? previous.nextElementSibling : box.firstElementChild;
    while (next && next.classList.contains('is-leaving')) next = next.nextElementSibling;
    if (next !== node) box.insertBefore(node, next);
    if (fresh && animate && (record.painted || stagger)) enter(node, { delay: record.painted ? 0 : Math.min(index, 8) * MOTION.stagger });
    previous = node;
  });
  if (items.length) record.painted = true;
}
function resetList(box) { keyedLists.delete(box); box.replaceChildren(); }

/* ---------- animated text fields ---------- */
// A text field's own glyphs are hidden and redrawn in a layer on top, so typed letters can
// fade in and deleted ones fade out. The real input keeps caret, selection and keyboard.
function smoothInput(input) {
  if (input._smooth) return input;
  const wrap = el('span', 'smooth-field'); input.parentNode.insertBefore(wrap, input); wrap.append(input);
  const layer = el('span', 'smooth-layer'); layer.setAttribute('aria-hidden', 'true');
  const line = el('span', 'smooth-line'); layer.append(line); wrap.append(layer);
  input.classList.add('smooth-input');
  let text = '';
  const metrics = () => {
    const style = getComputedStyle(input);
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'textAlign']) layer.style[name] = style[name];
    layer.style.color = style.getPropertyValue('--smooth-color').trim() || 'inherit';
    layer.style.paddingLeft = `${parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)}px`;
    layer.style.paddingRight = `${parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)}px`;
  };
  const align = () => { line.style.transform = `translateX(${-input.scrollLeft}px)`; };
  const glyph = (character) => el('span', 'glyph', character);
  const sync = (animate) => {
    const next = input.value; const previous = text; text = next;
    if (!animate || !motionOK()) { line.replaceChildren(...[...next].map(glyph)); requestAnimationFrame(align); return; }
    const before = [...previous]; const after = [...next];
    let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let endBefore = before.length; let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    const live = [...line.children].filter((node) => !node._ghost);
    const anchor = live[endBefore] || null;
    for (const node of live.slice(start, endBefore)) {
      node._ghost = true;
      const left = node.offsetLeft; const top = node.offsetTop;
      node.classList.add('glyph-out'); node.style.left = `${left}px`; node.style.top = `${top}px`;
      const animation = play(node, [{ opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-5px) scale(.9)', filter: 'blur(2px)' }], { duration: 180, easing: MOTION.out, fill: 'forwards' });
      const remove = () => node.remove(); if (animation) animation.finished.then(remove, remove); else remove();
    }
    after.slice(start, endAfter).forEach((character, index) => {
      const node = glyph(character); line.insertBefore(node, anchor);
      play(node, [{ opacity: 0, transform: 'translateY(5px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }], { duration: 220, delay: Math.min(index, 24) * 12, easing: MOTION.out, fill: 'backwards' });
    });
    requestAnimationFrame(align);
  };
  input._smooth = (animate) => { metrics(); sync(animate); };
  input.addEventListener('input', () => sync(true));
  input.addEventListener('focus', metrics); input.addEventListener('blur', metrics);
  for (const type of ['scroll', 'keyup', 'keydown', 'select', 'focus', 'pointerup']) input.addEventListener(type, () => requestAnimationFrame(align));
  window.addEventListener('resize', () => { metrics(); align(); });
  metrics(); sync(false);
  return input;
}
function setField(input, value, animate = false) { if (input.value === value) return; input.value = value; if (input._smooth) input._smooth(animate); }

/* ---------- time ---------- */
function relativeTime(value) {
  const time = new Date(value).getTime(); if (!Number.isFinite(time)) return '';
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60); if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60); if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(time));
}
function fullTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }
function duration(seconds) {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
function formatTime(value, format) {
  const time = new Date(value).getTime(); if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (format === 'secs') return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (format === 'for') return `Running for ${duration(seconds)}`;
  if (format === 'started') return `Started ${relativeTime(value)}`;
  if (format === 'dot-ago') return ` · ${relativeTime(value)}`;
  return relativeTime(value);
}
function timeNode(value, format, className = '') {
  const node = el('span', className); node.dataset.ts = String(value || ''); node.dataset.fmt = format;
  node.textContent = formatTime(value, format); return node;
}
function tickTimes() { if (document.hidden) return; for (const node of document.querySelectorAll('[data-ts]')) setText(node, formatTime(node.dataset.ts, node.dataset.fmt)); }

/* ---------- toasts ---------- */
function findToast(key) { return key ? [...$('toasts').children].find((node) => node._key === key && !node.classList.contains('leaving')) : null; }
function toast(message, { action = null, duration = 4000, key = '', persistent = false, tone = '', spark = false } = {}) {
  const box = $('toasts'); const existing = findToast(key);
  if (existing) { setText(existing.querySelector('.toast-text'), message); startToastTimer(existing); return existing; }
  const node = el('div', `toast${tone ? ` ${tone}` : ''}${action ? ' has-action' : ''}`); node._key = key;
  if (spark) node.append(el('span', 'spark'));
  node.append(el('span', 'toast-text', message));
  if (action) {
    const button = el('button', 'toast-action', action.label); button.type = 'button';
    button.addEventListener('click', () => { dismissToast(node); action.run(); });
    node.append(button);
  }
  node._duration = persistent ? 0 : duration;
  node.addEventListener('pointerenter', () => clearTimeout(node._timer));
  node.addEventListener('pointerleave', () => startToastTimer(node));
  box.append(node);
  const live = [...box.children].filter((child) => !child.classList.contains('leaving'));
  for (const extra of live.slice(0, Math.max(0, live.length - 3))) dismissToast(extra);
  startToastTimer(node);
  return node;
}
function startToastTimer(node) { clearTimeout(node._timer); if (node._duration) node._timer = setTimeout(() => dismissToast(node), node._duration); }
function dismissToast(node) {
  if (!node || node.classList.contains('leaving')) return;
  clearTimeout(node._timer);
  if (!motionOK()) { node.remove(); return; }
  node.classList.add('leaving');
  const done = () => node.remove();
  node.addEventListener('animationend', done, { once: true }); setTimeout(done, 400);
}
function dismissToastKey(key) { const node = findToast(key); if (node) dismissToast(node); }
function announce(message) { toast(message); }

/* ---------- dialogs ---------- */
function openDialog(dialog) { clearTimeout(dialog._closing); dialog.classList.remove('closing'); dialog.returnValue = ''; if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog, value = 'cancel') {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  if (!motionOK()) { dialog.close(value); return; }
  dialog.classList.add('closing');
  const finish = () => { clearTimeout(dialog._closing); dialog.removeEventListener('animationend', onEnd); dialog.classList.remove('closing'); if (dialog.open) dialog.close(value); };
  const onEnd = (event) => { if (event.target === dialog) finish(); };
  dialog.addEventListener('animationend', onEnd);
  dialog._closing = setTimeout(finish, 320);
}

/* ---------- helpers ---------- */
function showError(message) { setText($('global-error'), message || ''); setVisible('global-error', !!message); }
function messageOf(error) { return error && error.message ? error.message : 'Something went wrong. Please try again.'; }
function csrfFrom(data) { if (data && data.csrfToken) state.csrf = data.csrfToken; }
function safeClaudeUrl(raw) { try { const url = new URL(raw); return url.protocol === 'https:' && url.hostname === 'claude.ai' && !url.username && !url.password ? url.href : null; } catch { return null; } }
function folderName(path) { const parts = String(path || '').split(/[\\/]/).filter(Boolean); return parts.at(-1) || path || 'Folder'; }
function online(device) { return device?.online === true; }
function deviceById(id) { return state.devices.find((device) => device.id === id) || null; }
function deviceName(id) { return deviceById(id)?.name || id || 'Device'; }
function deviceType(device) {
  const name = `${device?.name || ''} ${device?.id || ''}`;
  if (/laptop|book|portable/i.test(name)) return 'laptop';
  if (/server|vps|srv|host|cloud|nas/i.test(name)) return 'server';
  if (/desktop|pc|workstation|tower/i.test(name) || ['windows', 'wsl'].includes(device?.os)) return 'desktop';
  return 'server';
}
function deviceKind(device) { const name = device?.name || ''; return device?.os === 'wsl' || /wsl/i.test(name) ? 'WSL' : device?.os === 'windows' || /windows/i.test(name) ? 'Windows' : 'Linux'; }
function canShare() { return typeof navigator.share === 'function'; }
function samePath(deviceId, a, b) {
  const clean = (value) => { const text = String(value || ''); return text.replace(/[\\/]+$/, '') || text; };
  const windows = deviceKind(deviceById(deviceId)) === 'Windows';
  return windows ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
}

/* ---------- sessions model ---------- */
function normalizeSession(session) {
  const normalized = { ...session, id: String(session.id || ''), status: session.status || 'unknown', url: safeClaudeUrl(session.url), trustPending: session.trustPending || null, error: typeof session.error === 'string' ? session.error : (session.error?.message || ''), stopError: typeof session.stopError === 'string' ? session.stopError : '' };
  if (['error', 'setup_required'].includes(normalized.status)) normalized.status = 'failed';
  if (normalized.status === 'ready' && !normalized.url) { normalized.status = 'failed'; normalized.error ||= 'Claude reported that it was ready but did not return a valid session link. Check Claude Code on this device, then try again.'; }
  if (normalized.id && !state.sessionFirstSeen.has(normalized.id)) state.sessionFirstSeen.set(normalized.id, Date.now());
  return normalized;
}
function sessionReady(session) { return session.status === 'ready' && !!session.url; }
function sessionActive(session) { return ACTIVE.includes(session.status); }
function trustPrompt(session) {
  const prompt = session.trustPending;
  if (session.status !== 'starting' || !prompt || !['folder', 'remote-control'].includes(prompt.kind) || typeof prompt.nonce !== 'string' || !prompt.nonce || typeof prompt.path !== 'string' || !prompt.path || typeof prompt.message !== 'string' || !prompt.message) return null;
  return prompt;
}
function sessionIssue(session) {
  if (!sessionActive(session) || sessionReady(session) || trustPrompt(session) || session.stopping) return null;
  const check = state.sessionChecks.get(session.id) || {};
  const name = session.deviceName || deviceName(session.deviceId);
  if (!navigator.onLine) return { label: 'Connection lost', title: 'Reconnect to check this session.', message: 'Your phone is offline. Reconnect, then check the session status.' };
  if (check.paused) return { label: 'Check status', title: 'Automatic checking paused.', message: `Claude has not returned a session link yet. Look at Claude Code on ${name} for sign-in or setup prompts, then check again. Checking never starts another session.` };
  if (session.deviceOnline === false) return { label: 'Device disconnected', title: `Waiting for ${name} to reconnect.`, message: 'Anywhere cannot reach this device right now. Wake it or restart its Anywhere agent. Checking continues automatically.' };
  if (check.error) return { label: 'Status unavailable', title: 'Couldn’t refresh the status.', message: `${check.error} Anywhere keeps trying.` };
  const started = new Date(session.startedAt || session.createdAt || state.sessionFirstSeen.get(session.id) || Date.now()).getTime();
  if (Number.isFinite(started) && Date.now() - started >= 120000) return { label: 'Taking longer', title: 'Claude is taking longer than usual.', message: `No session link yet. Check Claude Code on ${name} for sign-in or setup prompts. Checking continues automatically.` };
  return null;
}
function statusOf(session) {
  if (session.stopping && sessionActive(session)) return { cls: 'stopping', label: 'Stopping…' };
  if (trustPrompt(session)) return { cls: 'attention', label: 'Needs you' };
  const issue = sessionIssue(session); if (issue) return { cls: 'attention', label: issue.label };
  if (sessionReady(session)) return { cls: 'ready', label: 'Running' };
  return ({ starting: { cls: 'starting', label: 'Starting' }, stopped: { cls: '', label: 'Stopped' }, failed: { cls: 'failed', label: 'Failed' }, offline: { cls: '', label: 'Ended' } })[session.status] || { cls: '', label: 'Unknown' };
}
function findSession(id) { return state.sessions.find((session) => session.id === id) || null; }
function visibleSessions() { return state.sessions.filter((session) => !state.pendingRemovals.has(session.id) && !state.pendingClear?.ids.has(session.id)); }
function activeSessionAt(deviceId, path) {
  if (!deviceId || !path) return null;
  return visibleSessions().find((session) => session.deviceId === deviceId && sessionActive(session) && samePath(deviceId, session.path, path)) || null;
}
function upsertSession(session) {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index < 0) state.sessions.unshift(session); else state.sessions[index] = { ...state.sessions[index], ...session };
  renderAll();
}

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, timeout = 25000, keepalive = false } = {}) {
  const generation = state.authGeneration;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, keepalive, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
    if (generation === state.authGeneration) csrfFrom(data);
    if (!response.ok) {
      if (response.status === 401 && state.authenticated && generation === state.authGeneration) showLogin();
      const failure = new Error(typeof data.error === 'string' ? data.error : (data.error?.message || `The request failed (${response.status}).`));
      failure.httpStatus = response.status;
      throw failure;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The device is taking too long to respond. Check its connection and try again.');
    if (error instanceof TypeError) throw new Error('Couldn’t reach Anywhere. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}
const current = (generation) => state.authenticated && generation === state.authGeneration;

/* ---------- auth / boot ---------- */
function showLogin() {
  state.authenticated = false; state.authGeneration++; state.csrf = '';
  state.devices = []; state.sessions = []; state.devicesLoaded = false; state.sessionsLoaded = false;
  state.selected = null; state.directory = null; state.pendingLaunch = null; state.pendingStop = null; state.shownPath = '';
  state.launching = false; state.browsing = false; state.browseSequence++; state.routed = false;
  for (const timer of state.polls.values()) clearTimeout(timer);
  for (const timer of state.pendingRemovals.values()) clearTimeout(timer);
  if (state.pendingClear) clearTimeout(state.pendingClear.timer);
  state.pendingClear = null;
  for (const collection of [state.polls, state.confirmingTrust, state.submittedTrust, state.trustErrors, state.sessionChecks, state.sessionFirstSeen, state.actionErrors, state.busy, state.pendingRemovals]) collection.clear();
  for (const id of ['trust-dialog', 'stop-dialog', 'install-dialog']) if ($(id).open) $(id).close('cancel');
  for (const id of ['device-chips', 'device-groups', 'pinned-list', 'history-list', 'recent-list', 'jump-list']) resetList($(id));
  state.editDevices = false;
  $('folder-list').replaceChildren(); setField($('folder-path'), ''); $('toasts').replaceChildren();
  Object.assign(sv, { id: null, sig: '', refs: null, placeholder: '' }); $('session-view').replaceChildren();
  setVisible('browser', false); setVisible('choose-hint', true); showError(''); closeDrawer();
  setVisible('boot-screen', false); setVisible('shell', false); setVisible('login-screen', true);
  setTimeout(() => $('access-token').focus(), 50);
}

async function loadStatus() {
  const status = await api('/api/status');
  if (status.authenticated) state.ownerName = typeof status.ownerName === 'string' ? status.ownerName.slice(0, 40) : '';
  return status;
}

async function boot() {
  setVisible('boot-screen', true); setVisible('login-screen', false); setVisible('shell', false);
  $('boot-screen').replaceChildren(Object.assign(el('span', 'spark spark-pulse'), { ariaHidden: 'true' }), el('p', '', 'Connecting…'));
  try {
    const status = await loadStatus();
    if (!status.authenticated) return showLogin();
    await openWorkspace();
  } catch (error) {
    const retry = el('button', 'btn btn-ghost', 'Try again'); retry.type = 'button'; retry.addEventListener('click', boot);
    $('boot-screen').replaceChildren(el('span', 'spark spark-lg'), el('p', '', messageOf(error)), retry);
  }
}

function greetingText() {
  const hour = new Date().getHours(); const name = state.ownerName;
  if (hour >= 23 || hour < 5) return name ? `Still up, ${name}?` : 'Still up?';
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}
function updateGreeting() { setText($('greeting-text'), greetingText()); }
function playIntro() {
  if (state.route.view !== 'new') return;
  play($('greeting-spark'), [{ opacity: 0, transform: 'rotate(-90deg) scale(.4)' }, { opacity: 1, transform: 'rotate(0deg) scale(1)' }], { id: 'intro', duration: MOTION.lazy, easing: MOTION.out });
  enter($('greeting-text'), { y: 8, duration: MOTION.slow });
  enter($('greeting-sub'), { y: 8, delay: 60, duration: MOTION.slow });
  enter($('composer'), { y: 12, delay: 110, duration: MOTION.slow });
}

async function openWorkspace() {
  const generation = state.authGeneration;
  state.authenticated = true;
  updateGreeting();
  setVisible('boot-screen', false); setVisible('login-screen', false); setVisible('shell', true);
  route(); playIntro();
  const results = await Promise.allSettled([refreshDevices(), refreshSessions()]);
  if (!current(generation)) return;
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) showError(messageOf(failure.reason));
  renderAll();
}

/* ---------- routing ---------- */
function parseRoute() { const match = location.hash.match(/^#\/s\/([A-Za-z0-9-]+)$/); return match ? { view: 'session', id: match[1] } : { view: 'new', id: '' }; }
function navigate(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
function setTopbarTitle(text) {
  const node = $('topbar-title'); if (node.textContent === text) return;
  node.textContent = text;
  if (state.routed) play(node, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { id: 'title', duration: MOTION.base });
}
function route() {
  const previous = state.route; state.route = parseRoute();
  const changed = previous.view !== state.route.view || previous.id !== state.route.id;
  closeDrawer();
  if (!state.authenticated) return;
  if (changed) Object.assign(sv, { id: null, placeholder: '' });
  const isSession = state.route.view === 'session';
  setVisible('new-view', !isSession); setVisible('session-view', isSession);
  renderAll();
  if (changed) {
    $('main').scrollTop = 0;
    if (state.routed) enter(isSession ? $('session-view') : $('new-view'), { y: 10, duration: MOTION.slow });
  }
  state.routed = true;
}
function newSession() {
  if (!state.launching && (state.selected || state.directory)) {
    const composer = $('composer'); const from = composer.offsetHeight; const visible = !$('new-view').hidden;
    state.selected = null; state.directory = null; state.browsing = false; state.browseSequence++; state.shownPath = '';
    clearTimeout(state.skeletonTimer);
    $('folder-list').replaceChildren(); setField($('folder-path'), ''); showFolderMessage('');
    state.folderFilter = ''; setField($('folder-filter'), ''); setVisible('filter-form', false); setVisible('folder-foot', false);
    setVisible('browser', false); setVisible('choose-hint', true); showError('');
    if (visible) { renderAll(); animateHeight(composer, from); }
  }
  navigate('#/');
  $('main').scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' });
}

/* ---------- devices ---------- */
async function refreshDevices() {
  const generation = state.authGeneration;
  const data = await api('/api/devices');
  if (!current(generation)) return;
  state.devices = Array.isArray(data.devices) ? data.devices : [];
  state.devicesLoaded = true;
  if (state.selected) {
    state.selected = deviceById(state.selected.id);
    if (!state.selected) { state.directory = null; setVisible('browser', false); setVisible('choose-hint', true); }
  }
  renderAll();
}

function renderDeviceChips() {
  const box = $('device-chips');
  if (!state.devicesLoaded) { if (!box.querySelector('.skeleton-chip')) { resetList(box); box.append(...Array.from({ length: 4 }, () => el('span', 'skeleton-chip'))); } return; }
  if (!state.devices.length) {
    if (!box.querySelector('.chips-empty')) {
      resetList(box); const empty = el('span', 'side-empty chips-empty', 'No devices yet.');
      const add = el('button', 'btn btn-primary', 'Add a device'); add.type = 'button'; add.addEventListener('click', openAddDevice); empty.append(add); box.append(empty);
    }
    return;
  }
  reconcile(box, state.devices.filter((device) => !device.hidden || state.selected?.id === device.id), { key: (device) => device.id, stagger: true, create: createChip, update: updateChip });
}
function createChip(device) {
  const chip = el('button', 'device-chip'); chip.type = 'button';
  chip.append(icon(deviceType(device)), el('span', 'chip-name'), el('span', 'dot'));
  chip.addEventListener('click', () => pickDevice(chip._key));
  return chip;
}
function updateChip(chip, device) {
  const connected = online(device); const selected = state.selected?.id === device.id;
  setClass(chip, `device-chip${selected ? ' selected' : ''}${connected ? '' : ' offline'}`);
  setAttr(chip, 'aria-pressed', String(selected));
  setAttr(chip, 'aria-label', `${device.name || device.id}, ${deviceKind(device)}, ${connected ? 'online' : 'offline'}`);
  setText(chip.children[1], device.name || device.id);
  setClass(chip.children[2], `dot${connected ? ' online' : ''}`);
}

/* ---------- sidebar organisation ---------- */
function sessionTitle(session) { return session.label || folderName(session.path); }
const collapsed = (() => { try { const value = JSON.parse(localStorage.getItem('anywhere-collapsed') || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } })();
function isCollapsed(key) { return key === 'hidden' ? collapsed[key] !== false : collapsed[key] === true; }
function collapsibleParts(key) {
  if (key.startsWith('dev:')) {
    const group = [...$('device-groups').children].find((node) => node._key === key.slice(4));
    return group ? { list: group.querySelector('.dev-sessions'), toggle: group.querySelector('.dev-toggle') } : {};
  }
  return { list: $(`${key}-list`), toggle: document.querySelector(`[data-collapse="${key}"]`) };
}
const folding = new Set();
// Fold and unfold slide the list's height; the arrow turns at the same time.
function toggleCollapsed(key) {
  if (folding.has(key)) return;
  const fold = !isCollapsed(key); const { list, toggle } = collapsibleParts(key);
  const commit = () => {
    collapsed[key] = fold;
    try { localStorage.setItem('anywhere-collapsed', JSON.stringify(collapsed)); } catch { /* preferences are optional */ }
    renderAll();
  };
  if (!list || list.hidden || !motionOK()) {
    commit();
    if (!fold && list && !list.hidden && motionOK()) slideOpen(list);
    return;
  }
  if (toggle) toggle.setAttribute('aria-expanded', String(!fold));
  if (!fold) { commit(); slideOpen(list); return; }
  folding.add(key); list.style.overflow = 'hidden';
  const animation = play(list, [{ height: `${list.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { id: 'fold', duration: MOTION.slow, easing: MOTION.inOut, fill: 'forwards' });
  const done = () => { folding.delete(key); list.style.overflow = ''; commit(); animation?.cancel(); };
  if (animation) animation.finished.then(done, done); else done();
}
function slideOpen(list) {
  const height = list.offsetHeight; list.style.overflow = 'hidden';
  const animation = play(list, [{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }], { id: 'fold', duration: MOTION.slow, easing: MOTION.sheet });
  const done = () => { list.style.overflow = ''; };
  if (animation) animation.finished.then(done, done); else done();
}
function deviceHasActive(id, sessions = visibleSessions()) { return sessions.some((session) => session.deviceId === id && sessionActive(session) && !session.pinned); }
function renderSideDevices() {
  const sessions = visibleSessions();
  const shown = state.devices.filter((device) => !device.hidden || deviceHasActive(device.id, sessions));
  const tucked = state.devices.filter((device) => device.hidden && !deviceHasActive(device.id, sessions));
  if (!deviceDrag?.active) reconcile($('device-groups'), shown, { key: (device) => device.id, create: createDeviceGroup, update: updateDeviceGroup });
  setVisible('hidden-devices', tucked.length > 0);
  setText($('hidden-count'), `Hidden · ${tucked.length}`);
  setAttr(document.querySelector('[data-collapse="hidden"]'), 'aria-expanded', String(!isCollapsed('hidden')));
  setVisible('hidden-list', !isCollapsed('hidden'));
  reconcile($('hidden-list'), isCollapsed('hidden') ? [] : tucked, {
    key: (device) => device.id,
    create: (device) => {
      const row = el('div', 'hidden-dev'); const kind = el('span', 'dev-icon'); kind.append(icon(deviceType(device)));
      row.append(kind, el('span', 'dev-name'), iconButton('eyeOff', 'dev-show', 'Show', () => toggleDeviceHidden(row._key)));
      if (device.enrolled) row.append(iconButton('trash', 'dev-forget', 'Remove this device', () => forgetDevice(row._key)));
      return row;
    },
    update: (row, device) => { setText(row.children[1], device.name || device.id); setAttr(row.children[2], 'aria-label', `Show ${device.name || device.id}`); setAttr(row.children[2], 'title', `Show ${device.name || device.id}`); }
  });
}
function createDeviceGroup(device) {
  const group = el('div', 'dev-group'); const head = el('div', 'dev-head');
  const toggle = el('button', 'dev-toggle'); toggle.type = 'button';
  const kind = el('span', 'dev-icon'); kind.append(icon(deviceType(device)));
  toggle.append(kind, el('span', 'dev-name'), el('span', 'dot'), el('span', 'dev-spacer'), el('span', 'dev-count'), icon('caret'));
  toggle.addEventListener('click', () => toggleCollapsed(`dev:${group._key}`));
  const actions = el('span', 'dev-actions');
  actions.append(iconButton('eye', 'dev-eye', 'Hide', () => toggleDeviceHidden(group._key)),
    iconButton('plus', 'dev-add', 'New session', () => { navigate('#/'); pickDevice(group._key); }));
  head.append(toggle, actions);
  group.append(head, el('div', 'side-list dev-sessions'));
  return group;
}
function updateDeviceGroup(group, device) {
  const sessions = visibleSessions().filter((session) => session.deviceId === device.id && sessionActive(session) && !session.pinned);
  const connected = online(device); const folded = isCollapsed(`dev:${device.id}`) && sessions.length > 0;
  const name = device.name || device.id;
  setClass(group, `dev-group${connected ? '' : ' offline'}${device.hidden ? ' is-hidden' : ''}${folded ? ' folded' : ''}${sessions.length ? ' has-sessions' : ''}${group.classList.contains('dragging') ? ' dragging' : ''}${group.classList.contains('show-actions') ? ' show-actions' : ''}`);
  const [head, list] = group.children; const [toggle, actions] = head.children; const [eye, add] = actions.children;
  setAttr(toggle, 'aria-expanded', sessions.length ? String(!folded) : null);
  const caps = device.capabilities || []; const outdated = Number(device.version) < Number(device.latestAgentVersion);
  const note = !connected ? 'Offline' : !caps.includes('self-update') ? 'Online · update agent once' : outdated ? 'Online · updating…' : 'Online';
  setAttr(toggle, 'title', `${name} · ${deviceKind(device)} · ${note} — drag to reorder`);
  setText(toggle.querySelector('.dev-name'), name);
  setText(toggle.querySelector('.dev-count'), sessions.length ? String(sessions.length) : '');
  setClass(toggle.querySelector('.dot'), `dot${connected ? ' online' : ''}`);
  setAttr(add, 'aria-label', `New session on ${name}`); setAttr(add, 'title', `New session on ${name}`); setProp(add, 'disabled', !connected);
  const eyeName = device.hidden ? 'eyeOff' : 'eye';
  if (eye._icon !== eyeName) { eye._icon = eyeName; eye.replaceChildren(icon(eyeName)); }
  const eyeLabel = device.hidden ? `Show ${name}` : `Hide ${name}`; setAttr(eye, 'aria-label', eyeLabel); setAttr(eye, 'title', eyeLabel);
  setVisible(list, sessions.length > 0 && !folded);
  reconcile(list, folded ? [] : sessions, { key: (session) => session.id, create: createSideSession, update: (row, session) => updateSideSession(row, session, false) });
}
// Drag a device to reorder: with a mouse after a small move, on touch after holding ~0.4 s.
let deviceDrag = null;
function initDeviceDrag() {
  const box = $('device-groups'); let suppressClickUntil = 0;
  const cancelDrag = () => { if (!deviceDrag) return; clearTimeout(deviceDrag.timer); if (deviceDrag.active) endDrag(false); deviceDrag = null; };
  const activate = () => {
    const drag = deviceDrag; if (!drag) return;
    const groups = [...box.children].filter((node) => !node.classList.contains('is-leaving'));
    Object.assign(drag, { active: true, groups, index: groups.indexOf(drag.group), rects: groups.map((node) => node.getBoundingClientRect()) });
    drag.target = drag.index; drag.height = drag.rects[drag.index].height + 1;
    drag.group.classList.add('dragging'); $('shell').classList.add('reordering');
  };
  const endDrag = (commit) => {
    const drag = deviceDrag; suppressClickUntil = performance.now() + 300;
    const { groups, index, target, rects } = drag; const moved = commit && target !== index;
    const offset = target > index ? rects[target].bottom - rects[index].bottom : rects[target].top - rects[index].top;
    drag.group.style.transition = `transform ${MOTION.base}ms ${MOTION.out}`;
    drag.group.style.transform = `translateY(${moved ? offset : 0}px)`;
    setTimeout(() => {
      for (const node of groups) { node.style.transition = 'none'; node.style.transform = ''; }
      drag.group.classList.remove('dragging'); $('shell').classList.remove('reordering');
      if (moved) {
        const visibleIds = groups.map((node) => node._key); const [id] = visibleIds.splice(index, 1); visibleIds.splice(target, 0, id);
        const hidden = state.devices.filter((device) => device.hidden).map((device) => device.id);
        const order = [...visibleIds, ...state.devices.map((device) => device.id).filter((other) => !visibleIds.includes(other))];
        saveDevicePrefs(order, hidden);
      } else {
        renderAll();
        // A hold released in place reveals the row's hide button on touch screens.
        if (drag.touch) { const group = drag.group; group.classList.add('show-actions'); clearTimeout(group._actionsTimer); group._actionsTimer = setTimeout(() => group.classList.remove('show-actions'), 4000); }
      }
      requestAnimationFrame(() => { for (const node of groups) node.style.transition = ''; });
    }, MOTION.base + 10);
  };
  box.addEventListener('pointerdown', (event) => {
    const head = event.target.closest('.dev-head');
    if (!head || event.target.closest('.icon-btn') || event.button > 0 || deviceDrag) return;
    deviceDrag = { id: event.pointerId, group: head.parentElement, x0: event.clientX, y0: event.clientY, active: false, touch: event.pointerType !== 'mouse' };
    if (deviceDrag.touch) deviceDrag.timer = setTimeout(activate, 400);
  });
  window.addEventListener('pointermove', (event) => {
    const drag = deviceDrag; if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0; const dy = event.clientY - drag.y0;
    if (!drag.active) {
      if (drag.touch) { if (Math.hypot(dx, dy) > 8) cancelDrag(); return; }
      if (Math.abs(dy) < 5) return;
      activate();
    }
    const first = drag.rects[0].top; const last = drag.rects.at(-1).bottom;
    const top = Math.min(Math.max(drag.rects[drag.index].top + dy, first - 8), last - drag.height + 8);
    drag.group.style.transform = `translateY(${top - drag.rects[drag.index].top}px) scale(1.02)`;
    const center = top + drag.height / 2; let target = 0;
    drag.rects.forEach((rect, index) => { if (index !== drag.index && center > rect.top + rect.height / 2) target++; });
    drag.target = target;
    drag.groups.forEach((node, index) => {
      if (index === drag.index) return;
      const shift = drag.index < target && index > drag.index && index <= target ? -drag.height : drag.index > target && index < drag.index && index >= target ? drag.height : 0;
      node.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }, { passive: true });
  const finish = (event) => { const drag = deviceDrag; if (!drag || event.pointerId !== drag.id) return; clearTimeout(drag.timer); if (drag.active) endDrag(event.type === 'pointerup'); deviceDrag = null; };
  window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  box.addEventListener('touchmove', (event) => { if (deviceDrag?.active) event.preventDefault(); }, { passive: false });
  box.addEventListener('contextmenu', (event) => { if (deviceDrag) event.preventDefault(); });
  box.addEventListener('click', (event) => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } }, true);
}
async function saveDevicePrefs(order, hidden) {
  const byId = new Map(state.devices.map((device) => [device.id, device]));
  state.devices = order.map((id) => byId.get(id)).filter(Boolean).map((device) => ({ ...device, hidden: hidden.includes(device.id) }));
  renderAll();
  try { const data = await api('/api/prefs', { method: 'PUT', body: { deviceOrder: order, hiddenDevices: hidden } }); if (Array.isArray(data.devices)) { state.devices = data.devices; renderAll(); } }
  catch (error) { toast(messageOf(error), { tone: 'error' }); refreshDevices().catch(() => {}); }
}
function toggleDeviceHidden(id) {
  const hidden = new Set(state.devices.filter((device) => device.hidden).map((device) => device.id));
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  saveDevicePrefs(state.devices.map((device) => device.id), [...hidden]);
}
async function patchSession(id, changes) {
  const session = findSession(id); if (!session) return;
  const local = (value) => ({ ...(Object.hasOwn(value, 'label') ? { label: value.label || '' } : {}), ...(Object.hasOwn(value, 'pinned') ? { pinned: !!value.pinned } : {}) });
  upsertSession({ ...session, ...local(changes) });
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
    const updated = normalizeSession(data.session || data);
    upsertSession({ ...updated, label: updated.label || '', pinned: !!updated.pinned });
  } catch (error) { toast(messageOf(error), { tone: 'error' }); refreshSessions().catch(() => {}); }
}
function togglePin(id) { const session = findSession(id); if (session) { patchSession(id, { pinned: !session.pinned }); toast(session.pinned ? 'Unpinned.' : 'Pinned to the top.'); } }

function pickDevice(id) {
  const device = deviceById(id); if (!device) return;
  if (!online(device)) { toast(`${device.name || device.id} is offline. Start its Anywhere agent, then refresh.`); return; }
  if (state.launching) return;
  if (state.selected?.id === id && state.directory) return;
  const composer = $('composer'); const from = composer.offsetHeight; const opening = $('browser').hidden;
  state.selected = device; state.directory = null; state.shownPath = ''; showError('');
  state.folderFilter = ''; setField($('folder-filter'), '');
  setVisible('choose-hint', false); setVisible('browser', true);
  renderAll();
  browse(device.defaultPath || undefined, { first: true });
  if (opening && !$('new-view').hidden) animateHeight(composer, from);
  const chip = [...$('device-chips').children].find((node) => node._key === id);
  if (chip) chip.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: motionOK() ? 'smooth' : 'auto' });
}

/* ---------- folder browser ---------- */
async function browse(path, { first = false } = {}) {
  if (!state.selected || state.launching) return;
  const deviceId = state.selected.id; const sequence = ++state.browseSequence; const list = $('folder-list');
  state.browsing = true; updateLaunchButton();
  list.classList.add('is-loading'); setAttr(list, 'aria-busy', 'true');
  if (list.children.length) list.style.minHeight = `${list.offsetHeight}px`;
  showFolderMessage('');
  clearTimeout(state.skeletonTimer);
  const skeleton = () => { if (sequence === state.browseSequence && state.browsing) list.replaceChildren(...Array.from({ length: 6 }, () => el('div', 'folder-skel'))); };
  if (first || !list.children.length) skeleton(); else state.skeletonTimer = setTimeout(skeleton, 150);
  try {
    const query = new URLSearchParams({ device: deviceId }); if (path) query.set('path', path);
    const data = await api(`/api/browse?${query.toString()}`, { timeout: 35000 });
    if (sequence !== state.browseSequence || state.selected?.id !== deviceId) return;
    if (!data.path && Array.isArray(data.roots) && data.roots.length) {
      const root = data.roots[0]; const rootPath = typeof root === 'string' ? root : root.path;
      if (rootPath) { state.browsing = false; return await browse(rootPath, { first }); }
    }
    state.directory = { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
    renderFolder();
  } catch (error) {
    if (sequence !== state.browseSequence) return;
    state.directory = null; state.shownPath = '';
    list.replaceChildren(); list.style.minHeight = '';
    setVisible('filter-form', false); setVisible('folder-foot', false);
    showFolderMessage(messageOf(error), true);
    setField($('folder-path'), path || '');
    $('breadcrumbs').replaceChildren(el('span', 'crumb', state.selected?.name || 'Device'));
  } finally {
    if (sequence === state.browseSequence) {
      clearTimeout(state.skeletonTimer); state.browsing = false;
      list.classList.remove('is-loading'); setAttr(list, 'aria-busy', null);
      updateLaunchButton();
    }
  }
}
function showFolderMessage(text, error = false) { const node = $('folder-message'); setText(node, text); setClass(node, `folder-message${error ? ' error' : ''}`); setVisible(node, !!text); }
function isHiddenFolder(entry) { return String(entry.name || '').startsWith('.'); }

let folderRowTemplate = null;
function folderRow(entry, kind) {
  if (!folderRowTemplate) {
    folderRowTemplate = el('button', 'folder-row'); folderRowTemplate.type = 'button';
    folderRowTemplate.append(icon('folder'), el('span', 'folder-name'), el('span', 'folder-tag'), icon('chevron'));
  }
  const row = folderRowTemplate.cloneNode(true);
  if (kind) row.classList.add(kind);
  row.children[1].textContent = entry.name;
  const tag = row.children[2];
  row._tag = kind === 'denied' ? 'No access' : kind === 'project' ? 'Project' : '';
  tag.textContent = row._tag; tag.hidden = !row._tag;
  if (kind === 'denied') row.disabled = true;
  row._path = entry.path || joinPath(state.directory.path, entry.name);
  row._name = String(entry.name).toLowerCase();
  return row;
}
function renderFolder() {
  const directory = state.directory; const list = $('folder-list');
  const from = list.offsetHeight; const previousPath = state.shownPath; state.shownPath = directory.path || '';
  setField($('folder-path'), directory.path || '', true);
  renderBreadcrumbs(directory.path || '');
  const folders = directory.entries.filter((entry) => !entry.type || entry.type === 'directory' || entry.type === 'folder');
  const hiddenCount = folders.filter(isHiddenFolder).length;
  const shown = state.showHidden ? folders : folders.filter((entry) => !isHiddenFolder(entry));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const projects = shown.filter((entry) => (entry.isProject || entry.isGit) && !entry.accessDenied).sort(byName);
  const others = shown.filter((entry) => !(entry.isProject || entry.isGit) && !entry.accessDenied).sort(byName);
  const denied = shown.filter((entry) => entry.accessDenied).sort(byName);
  const grouped = shown.length >= 8 && projects.length > 0 && others.length + denied.length > 0;
  const nodes = [];
  if (grouped) nodes.push(el('div', 'folder-group', 'Projects'));
  for (const entry of projects) nodes.push(folderRow(entry, 'project'));
  if (grouped) nodes.push(el('div', 'folder-group', 'Folders'));
  for (const entry of others) nodes.push(folderRow(entry, ''));
  for (const entry of denied) nodes.push(folderRow(entry, 'denied'));
  list.replaceChildren(...nodes); list.style.minHeight = ''; list.scrollTop = 0;

  const samePlace = previousPath === state.shownPath;
  if (!samePlace) { state.folderFilter = ''; setField($('folder-filter'), ''); }
  setVisible('filter-form', shown.length >= 12);
  if (!shown.length) showFolderMessage(hiddenCount ? 'Only hidden folders here.' : 'No subfolders. You can start Claude right here.');
  else showFolderMessage('');
  if (state.folderFilter) applyFolderFilter();
  const toggle = $('toggle-hidden');
  setVisible(toggle, hiddenCount > 0);
  setText(toggle, state.showHidden ? `Hide ${hiddenCount} hidden` : `Show ${hiddenCount} hidden`);
  setVisible('folder-truncated', !!directory.truncated);
  setVisible('folder-foot', hiddenCount > 0 || !!directory.truncated);
  updateFolderBadges();
  updateLaunchButton();

  if (!samePlace && motionOK()) {
    const trim = (value) => value.replace(/[\\/]+$/, '');
    const separator = state.shownPath.includes('\\') ? '\\' : '/';
    const deeper = !!previousPath && state.shownPath.startsWith(trim(previousPath) + separator);
    const up = !!previousPath && previousPath.startsWith(trim(state.shownPath) + separator);
    animateHeight(list, from);
    [...list.children].slice(0, 9).forEach((node, index) => enter(node, { delay: index * MOTION.stagger, x: deeper ? 12 : up ? -12 : 0, y: deeper || up ? 0 : 4 }));
  }
}
// Filtering animates: rows that stop matching fold away, rows that match again unfold,
// and quick typing or deleting simply retargets the running animations.
function applyFolderFilter() {
  const query = state.folderFilter.trim().toLowerCase(); const list = $('folder-list');
  const animate = motionOK() && isOnScreen(list); let visible = 0; let only = null; let shown = 0;
  for (const node of list.children) {
    if (node.classList.contains('folder-group')) { setProp(node, 'hidden', !!query); continue; }
    if (!node.classList.contains('folder-row')) continue;
    const match = !query || node._name.includes(query);
    if (match) {
      visible++; only = node;
      if (node._folding) { const folding = node._folding; node._folding = null; folding.cancel(); if (animate) unfoldRow(node, 0); }
      else if (node.hidden) { node.hidden = false; if (animate && shown < 14) unfoldRow(node, shown++ * 12); }
    } else if (!node.hidden && !node._folding) {
      if (!animate) { node.hidden = true; continue; }
      const height = node.offsetHeight;
      const folding = play(node, [{ height: `${height}px`, minHeight: '0px', opacity: 1 }, { height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'scale(.98)' }], { id: 'filter', duration: 170, easing: MOTION.inOut, fill: 'forwards' });
      node._folding = folding; node.style.overflow = 'hidden';
      const finish = () => { if (node._folding === folding) { node._folding = null; node.hidden = true; folding.cancel(); } node.style.overflow = ''; };
      if (folding) folding.finished.then(finish, () => {}); else finish();
    }
  }
  if (query && !visible) showFolderMessage(`No folder matches “${state.folderFilter.trim()}”.`);
  else if (state.directory) showFolderMessage('');
  return visible === 1 ? only : null;
}
function unfoldRow(node, delay) {
  const height = node.offsetHeight; node.style.overflow = 'hidden';
  const animation = play(node, [{ height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }, { height: `${height}px`, minHeight: '0px', opacity: 1 }], { id: 'filter', duration: 200, delay, easing: MOTION.out, fill: 'backwards' });
  const done = () => { node.style.overflow = ''; };
  if (animation) animation.finished.then(done, done); else done();
}
function updateFolderBadges() {
  if (!state.selected || !state.directory) return;
  for (const row of $('folder-list').children) {
    if (!row.classList.contains('folder-row')) continue;
    const running = !!activeSessionAt(state.selected.id, row._path);
    row.classList.toggle('running', running);
    const tag = row.children[2]; const text = running ? 'Running' : row._tag;
    setText(tag, text); setProp(tag, 'hidden', !text);
  }
}
function joinPath(path, name) { return String(path || '').replace(/[\\/]+$/, '') + (String(path).includes('\\') ? '\\' : '/') + name; }
function renderBreadcrumbs(path) {
  const crumbs = $('breadcrumbs'); crumbs.replaceChildren();
  const windows = /^[A-Za-z]:/.test(path) || path.includes('\\'); const separator = windows ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const root = windows ? (parts.shift() || '') + separator : '/';
  const segments = [{ name: root, path: root }]; let currentPath = root;
  for (const part of parts) { currentPath = joinPath(currentPath, part); segments.push({ name: part, path: currentPath }); }
  for (const [index, segment] of segments.entries()) {
    if (index > 1 || (index === 1 && windows)) crumbs.append(el('span', 'crumb-sep', '/'));
    const button = el('button', 'crumb', segment.name); button.type = 'button'; button.title = segment.path;
    if (index === segments.length - 1) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => browse(segment.path)); crumbs.append(button);
  }
  requestAnimationFrame(() => { crumbs.scrollTo({ left: crumbs.scrollWidth, behavior: motionOK() ? 'smooth' : 'auto' }); });
}

function updateLaunchButton() {
  const button = $('launch-button');
  const running = state.selected && state.directory?.path ? activeSessionAt(state.selected.id, state.directory.path) : null;
  const ready = !!state.selected && online(state.selected) && !!state.directory?.path && !state.browsing && !state.launching && navigator.onLine;
  setProp(button, 'disabled', running ? state.launching : !ready);
  button.classList.toggle('is-launching', state.launching);
  button.classList.toggle('is-open', !!running && !state.launching);
  setText(button.querySelector('.send-label'), state.launching ? 'Starting…' : running ? 'Open' : 'Start');
  setAttr(button, 'aria-label', running ? `Open the running session in ${folderName(state.directory.path)}` : 'Start Claude in this folder');
  setProp($('folder-path'), 'disabled', !state.selected || state.launching);
  const modes = supportsModes(state.selected); const select = $('mode-select');
  setProp(select, 'disabled', (!!state.selected && !modes) || state.launching || !!running);
  setProp(select, 'value', state.selected ? modeFor(state.selected) : state.mode);
  setProp(select, 'title', state.selected && !modes ? 'This device\'s agent is too old for permission choices; only Ask is available.' : 'Permissions for this session');
  setProp($('folder-up'), 'disabled', state.browsing || state.launching || !state.directory?.parentPath);
}

/* ---------- recents and quick starts ---------- */
const RECENT_KEY = 'anywhere-recent-v2';
function getRecentList() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || 'null');
    if (Array.isArray(list)) return list.filter((item) => item && typeof item.deviceId === 'string' && typeof item.path === 'string');
    const old = JSON.parse(localStorage.getItem('anywhere-recent-folders') || '{}');
    const migrated = [];
    if (old && typeof old === 'object' && !Array.isArray(old)) for (const [deviceId, paths] of Object.entries(old)) if (Array.isArray(paths)) for (const path of paths) if (typeof path === 'string') migrated.push({ deviceId, path, mode: '', ts: 0 });
    return migrated;
  } catch { return []; }
}
function rememberFolder(deviceId, path, mode) {
  const list = getRecentList().filter((item) => !(item.deviceId === deviceId && item.path === path));
  list.unshift({ deviceId, path, mode, ts: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 24))); } catch { /* recent folders are optional */ }
}
function renderRecent() {
  const recent = state.selected ? getRecentList().filter((item) => item.deviceId === state.selected.id).slice(0, 6) : [];
  setVisible('recent', recent.length > 0);
  reconcile($('recent-list'), recent, {
    key: (item) => item.path,
    create: (item) => { const chip = el('button', 'recent-chip'); chip.type = 'button'; chip.append(icon('clock'), el('span')); chip.addEventListener('click', () => browse(chip._key)); return chip; },
    update: (chip, item) => { setText(chip.children[1], folderName(item.path)); setAttr(chip, 'title', item.path); setAttr(chip, 'aria-label', `Browse recent folder ${item.path}`); }
  });
}
function quickStarts(limit = 4) {
  const found = new Map();
  for (const session of visibleSessions()) {
    if (!session.path) continue;
    const key = `${session.deviceId}\n${session.path}`; const active = sessionActive(session);
    const ts = new Date(session.stoppedAt || session.startedAt || session.createdAt || 0).getTime() || 0;
    const previous = found.get(key);
    if (!previous || (active && !previous.active) || (active === previous.active && ts > previous.ts)) found.set(key, { key, deviceId: session.deviceId, path: session.path, label: session.label || '', mode: session.permissionMode || 'default', ts, active, sessionId: session.id });
  }
  for (const item of getRecentList()) {
    const key = `${item.deviceId}\n${item.path}`;
    if (!found.has(key)) found.set(key, { key, deviceId: item.deviceId, path: item.path, mode: item.mode || '', ts: item.ts || 0, active: false, sessionId: '' });
  }
  return [...found.values()].filter((item) => deviceById(item.deviceId)).sort((a, b) => (b.active - a.active) || (b.ts - a.ts)).slice(0, limit);
}
function renderJumpBack() {
  const show = state.route.view === 'new' && !state.selected && state.devicesLoaded && state.sessionsLoaded;
  const items = show ? quickStarts() : [];
  setVisible('jump', items.length > 0);
  reconcile($('jump-list'), items, { key: (item) => item.key, stagger: true, create: createJumpCard, update: updateJumpCard });
}
function createJumpCard() {
  const card = el('button', 'jump-card'); card.type = 'button';
  const iconBox = el('span', 'jump-icon');
  const sub = el('span', 'jump-sub'); sub.append(el('span'), el('span'));
  card.append(iconBox, el('span', 'jump-name'), sub, el('span', 'dot'));
  card.addEventListener('click', () => openQuickStart(card._key));
  return card;
}
function updateJumpCard(card, item) {
  const device = deviceById(item.deviceId); const session = item.active ? findSession(item.sessionId) : null;
  const status = session ? statusOf(session) : null; const type = deviceType(device);
  const cls = status ? (status.cls === 'ready' ? ' running' : status.cls === 'attention' ? ' attention' : '') : '';
  setClass(card, `jump-card${cls}`);
  setProp(card, 'disabled', !item.active && !online(device));
  const iconBox = card.children[0];
  if (iconBox._type !== type) { iconBox._type = type; iconBox.replaceChildren(icon(type)); }
  setText(card.children[1], item.label || folderName(item.path));
  const [label, time] = card.children[2].children;
  setText(label, device?.name || item.deviceId);
  const ts = !status && item.ts ? new Date(item.ts).toISOString() : '';
  setAttr(time, 'data-ts', ts || null); setAttr(time, 'data-fmt', ts ? 'dot-ago' : null); setText(time, ts ? formatTime(ts, 'dot-ago') : '');
  setClass(card.children[3], status ? `dot ${status.cls}`.trim() : 'dot idle');
  setAttr(card, 'aria-label', `${folderName(item.path)} on ${device?.name || item.deviceId}${status ? `, ${status.label}` : ''}`);
  setAttr(card, 'title', item.path);
}
function openQuickStart(key) {
  const item = quickStarts(24).find((candidate) => candidate.key === key); if (!item) return;
  const running = activeSessionAt(item.deviceId, item.path);
  if (running) { navigate(`#/s/${running.id}`); return; }
  askLaunch({ deviceId: item.deviceId, path: item.path, permissionMode: item.mode || state.mode });
}

/* ---------- launch ---------- */
function askLaunch(request) {
  if (!request || state.launching) return;
  const device = deviceById(request.deviceId);
  if (!online(device)) { toast(`${device?.name || request.deviceId} is offline.`); return; }
  request = { ...request, permissionMode: modeFor(device, request.permissionMode || state.mode) };
  state.pendingLaunch = request;
  setText($('trust-device'), `${device?.name || request.deviceId} · ${MODE_LABELS[request.permissionMode]}`);
  setText($('trust-text'), MODE_TEXT[request.permissionMode]);
  $('trust-text').classList.toggle('warn', request.permissionMode === 'bypassPermissions');
  setText($('trust-path'), request.path);
  openDialog($('trust-dialog'));
}

async function launch(request) {
  if (!request || state.launching) return;
  const generation = state.authGeneration;
  const attemptKey = JSON.stringify([request.deviceId, request.path, request.permissionMode]);
  const requestId = state.launchAttempts.get(attemptKey) || crypto.randomUUID();
  state.launchAttempts.set(attemptKey, requestId);
  state.launching = true; showError(''); updateLaunchButton();
  try {
    const data = await api('/api/sessions', { method: 'POST', body: { deviceId: request.deviceId, path: request.path, permissionMode: request.permissionMode, trustConfirmed: true, requestId }, timeout: 60000 });
    if (!current(generation)) return;
    const session = normalizeSession(data.session || data);
    if (!session.id) throw new Error('The server did not return a session. Check the session list before trying again.');
    state.launchAttempts.delete(attemptKey);
    rememberFolder(request.deviceId, request.path, request.permissionMode);
    if (data.reused) toast('Claude is already running in this folder.');
    upsertSession(session);
    if (session.status === 'starting') pollSession(session.id);
    navigate(`#/s/${session.id}`);
  } catch (error) {
    if (error.httpStatus >= 400 && error.httpStatus < 500) state.launchAttempts.delete(attemptKey);
    if (!current(generation)) return;
    const ambiguous = !error.httpStatus || error.httpStatus >= 500;
    showError(messageOf(error) + (ambiguous ? ' The request may still have reached the device: check Active sessions before retrying.' : ''));
  } finally {
    if (current(generation)) { state.launching = false; updateLaunchButton(); }
  }
}

/* ---------- polling ---------- */
function needsPolling(session) { return !!session && (session.status === 'starting' || (session.stopping && sessionActive(session))); }
function pollSession(id, attempt = 0) {
  clearTimeout(state.polls.get(id));
  if (!state.authenticated) { state.polls.delete(id); return; }
  if (attempt > 180) { state.polls.delete(id); state.sessionChecks.set(id, { ...state.sessionChecks.get(id), paused: true }); renderAll(); return; }
  const generation = state.authGeneration;
  const timer = setTimeout(async () => {
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (!current(generation)) return;
      state.sessionChecks.delete(id);
      const before = findSession(id);
      const session = normalizeSession(data.session || data);
      upsertSession(session);
      if (before?.stopping && session.status === 'stopped') toast('Session stopped.');
      if (needsPolling(session)) pollSession(id, attempt + 1); else state.polls.delete(id);
    } catch (error) {
      if (!current(generation)) return;
      if (error.httpStatus === 404) { state.polls.delete(id); state.sessions = state.sessions.filter((item) => item.id !== id); renderAll(); return; }
      state.sessionChecks.set(id, { error: messageOf(error) }); renderAll();
      if (needsPolling(findSession(id))) pollSession(id, attempt + 1); else state.polls.delete(id);
    }
  }, attempt < 10 ? 1500 : 5000);
  state.polls.set(id, timer);
}

async function checkSessionNow(id) {
  if (!state.authenticated || state.sessionChecks.get(id)?.checking) return;
  const generation = state.authGeneration;
  state.sessionChecks.set(id, { ...state.sessionChecks.get(id), checking: true }); renderAll();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (!current(generation)) return;
    state.sessionChecks.delete(id);
    const session = normalizeSession(data.session || data); upsertSession(session);
    if (needsPolling(session)) pollSession(id);
  } catch (error) {
    if (!current(generation)) return;
    state.sessionChecks.set(id, { error: messageOf(error) });
    if (needsPolling(findSession(id))) pollSession(id);
  } finally { if (current(generation)) renderAll(); }
}

async function refreshSessions() {
  const generation = state.authGeneration;
  const data = await api('/api/sessions');
  if (!current(generation)) return;
  state.sessions = (Array.isArray(data.sessions) ? data.sessions : []).map(normalizeSession);
  state.sessionsLoaded = true;
  for (const session of state.sessions) state.sessionChecks.delete(session.id);
  for (const session of state.sessions) if (needsPolling(session) && !state.polls.has(session.id)) pollSession(session.id);
  renderAll();
}
function refreshAll() { return Promise.allSettled([refreshDevices(), refreshSessions()]); }

/* ---------- trust confirmation ---------- */
async function confirmNativeTrust(id, nonce) {
  const generation = state.authGeneration;
  const session = findSession(id); const prompt = session && trustPrompt(session); const key = `${id}:${nonce}`;
  if (!prompt || prompt.nonce !== nonce || state.confirmingTrust.has(key) || state.submittedTrust.get(id) === nonce) return;
  state.confirmingTrust.add(key); state.trustErrors.delete(key); renderAll();
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { nonce, trustConfirmed: true } });
    if (!current(generation)) return;
    state.submittedTrust.set(id, nonce);
    pollSession(id);
  } catch (error) { if (current(generation)) state.trustErrors.set(key, messageOf(error)); }
  finally { state.confirmingTrust.delete(key); if (current(generation)) renderAll(); }
}

/* ---------- stop, remove, clear, share ---------- */
function askStop(id) {
  const session = findSession(id); if (!session) return;
  state.pendingStop = session.id;
  setText($('stop-device'), session.deviceName || deviceName(session.deviceId));
  setText($('stop-path'), session.path || '');
  openDialog($('stop-dialog'));
}
async function stopSession(id) {
  const session = findSession(id); if (!session || state.busy.has(id)) return;
  const generation = state.authGeneration;
  state.busy.add(id); state.actionErrors.delete(id);
  upsertSession({ ...session, stopping: true, stopError: '' });
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} });
    if (!current(generation)) return;
    const updated = normalizeSession(data.session || data); upsertSession(updated);
    if (updated.status === 'stopped') toast('Session stopped.'); else pollSession(id);
  } catch (error) {
    if (!current(generation)) return;
    state.actionErrors.set(id, messageOf(error));
    upsertSession({ ...findSession(id), stopping: false });
  } finally { state.busy.delete(id); if (current(generation)) renderAll(); }
}
// Removing waits a few seconds so it can be undone; the request is sent at once if the app is hidden.
function removeSession(id) {
  if (state.busy.has(id) || state.pendingRemovals.has(id)) return;
  const viewing = state.route.id === id; state.actionErrors.delete(id);
  state.pendingRemovals.set(id, setTimeout(() => commitRemoval(id), 5000));
  toast('Removed from the list.', { key: `rm:${id}`, duration: 5000, action: { label: 'Undo', run: () => undoRemoval(id) } });
  if (viewing) navigate('#/'); else renderAll();
}
function undoRemoval(id) {
  if (!state.pendingRemovals.has(id) || state.busy.has(id)) return;
  clearTimeout(state.pendingRemovals.get(id)); state.pendingRemovals.delete(id); renderAll();
}
async function commitRemoval(id, { keepalive = false } = {}) {
  if (!state.pendingRemovals.has(id) || state.busy.has(id)) return;
  clearTimeout(state.pendingRemovals.get(id));
  const generation = state.authGeneration; state.busy.add(id); dismissToastKey(`rm:${id}`);
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive });
    if (!current(generation)) return;
    clearTimeout(state.polls.get(id)); state.polls.delete(id);
    state.sessions = state.sessions.filter((item) => item.id !== id);
  } catch (error) {
    if (current(generation)) { state.actionErrors.set(id, messageOf(error)); toast(messageOf(error), { tone: 'error', action: { label: 'View', run: () => navigate(`#/s/${id}`) } }); }
  } finally { state.pendingRemovals.delete(id); state.busy.delete(id); if (current(generation)) renderAll(); }
}
function clearHistory() {
  if (state.pendingClear) return;
  const ids = new Set(visibleSessions().filter((session) => !sessionActive(session)).map((session) => session.id)); if (!ids.size) return;
  const viewing = ids.has(state.route.id);
  state.pendingClear = { ids, timer: setTimeout(() => commitClear(), 5000), committing: false };
  toast(`Cleared ${ids.size} finished ${ids.size === 1 ? 'session' : 'sessions'}.`, { key: 'clear', duration: 5000, action: { label: 'Undo', run: undoClear } });
  if (viewing) navigate('#/'); else renderAll();
}
function undoClear() { if (!state.pendingClear || state.pendingClear.committing) return; clearTimeout(state.pendingClear.timer); state.pendingClear = null; renderAll(); }
async function commitClear({ keepalive = false } = {}) {
  const pending = state.pendingClear; if (!pending || pending.committing) return;
  pending.committing = true; clearTimeout(pending.timer); dismissToastKey('clear');
  const generation = state.authGeneration;
  try { await api('/api/sessions/clear', { method: 'POST', body: {}, keepalive }); if (current(generation)) await refreshSessions(); }
  catch (error) { if (current(generation)) toast(messageOf(error), { tone: 'error' }); }
  finally { if (state.pendingClear === pending) state.pendingClear = null; if (current(generation)) renderAll(); }
}
function flushRemovals() {
  for (const id of [...state.pendingRemovals.keys()]) commitRemoval(id, { keepalive: true });
  if (state.pendingClear) commitClear({ keepalive: true });
}
async function copyLink(url) {
  if (!url) return;
  try { await navigator.clipboard.writeText(url); toast('Link copied.'); }
  catch { window.prompt('Copy this link', url); }
}
function shareLink(id) {
  const session = findSession(id); if (!session?.url || !canShare()) return;
  navigator.share({ title: `Claude · ${folderName(session.path)}`, text: `Claude Code on ${session.deviceName || deviceName(session.deviceId)}`, url: session.url })
    .catch((error) => { if (error?.name !== 'AbortError') toast('Sharing isn’t available here.'); });
}

/* ---------- rendering ---------- */
function renderAll() {
  if (!state.authenticated) return;
  renderDeviceChips(); renderSideDevices(); renderSidebarSessions(); renderRecent(); renderJumpBack(); updateFolderBadges(); updateLaunchButton();
  const isSession = state.route.view === 'session';
  if (isSession) renderSessionView(); else setTopbarTitle('New session');
  for (const link of document.querySelectorAll('.new-session')) link.classList.toggle('current', !isSession);
  $('shell').classList.toggle('is-home', !isSession);
  const plus = $('topbar-new'); const visibility = isSession ? 'visible' : 'hidden';
  if (plus.style.visibility !== visibility) plus.style.visibility = visibility;
  syncAttention();
  tickTimes();
}

// Claude can wait at most 10 minutes for a trust answer, so surface it wherever you are.
function syncAttention() {
  const waiting = visibleSessions().filter((session) => trustPrompt(session));
  setVisible('menu-badge', waiting.length > 0);
  const title = waiting.length ? 'Needs you · Anywhere' : 'Anywhere';
  if (document.title !== title) document.title = title;
  const keys = new Set();
  for (const session of waiting) {
    const key = `ask:${session.id}:${session.trustPending.nonce}`; keys.add(key);
    if (state.route.id === session.id) { dismissToastKey(key); continue; }
    if (!findToast(key)) toast(`Claude is asking on ${session.deviceName || deviceName(session.deviceId)}`, { key, persistent: true, spark: true, action: { label: 'Review', run: () => navigate(`#/s/${session.id}`) } });
  }
  for (const node of [...$('toasts').children]) if (node._key?.startsWith('ask:') && !keys.has(node._key)) dismissToast(node);
}

function renderSidebarSessions() {
  const sessions = visibleSessions();
  const pinned = sessions.filter((session) => session.pinned);
  const history = sessions.filter((session) => !sessionActive(session) && !session.pinned);
  for (const key of ['pinned', 'history']) setAttr(document.querySelector(`[data-collapse="${key}"]`), 'aria-expanded', String(!isCollapsed(key)));
  setVisible('pinned-group', pinned.length > 0);
  setVisible('pinned-list', !isCollapsed('pinned'));
  reconcile($('pinned-list'), isCollapsed('pinned') ? [] : pinned, { key: (session) => session.id, create: createSideSession, update: (row, session) => updateSideSession(row, session, true) });
  setVisible('history-group', history.length > 0);
  setVisible('history-list', !isCollapsed('history'));
  reconcile($('history-list'), isCollapsed('history') ? [] : history.slice(0, 30), { key: (session) => session.id, create: createSideSession, update: (row, session) => updateSideSession(row, session, true) });
}
function createSideSession() {
  const row = el('div', 'side-row');
  const item = el('a', 'side-item');
  const main = el('span', 'side-item-main'); const sub = el('span', 'side-item-sub');
  sub.append(el('span'), el('span'));
  main.append(el('span', 'side-item-title'), sub);
  item.append(main, el('span', 'dot'));
  row.append(item, iconButton('pin', 'side-pin', 'Pin', () => togglePin(row._key)));
  return row;
}
function updateSideSession(row, session, withDevice) {
  const status = statusOf(session); const selected = state.route.id === session.id; const active = sessionActive(session);
  const [item, pin] = row.children;
  setAttr(item, 'href', `#/s/${session.id}`);
  setClass(item, `side-item${selected ? ' current' : ''}${active ? '' : ' muted'}`);
  setAttr(item, 'aria-current', selected ? 'page' : null);
  const [main, dot] = item.children; const [title, sub] = main.children; const [text, time] = sub.children;
  setText(title, sessionTitle(session)); setAttr(title, 'title', session.path || null);
  setText(text, withDevice ? `${session.deviceName || deviceName(session.deviceId)} · ${status.label}` : status.label);
  const when = active ? '' : (session.stoppedAt || session.createdAt || '');
  setAttr(time, 'data-ts', when || null); setAttr(time, 'data-fmt', when ? 'dot-ago' : null);
  setText(time, when ? formatTime(when, 'dot-ago') : '');
  setClass(dot, `dot ${status.cls}`.trim());
  setClass(pin, `icon-btn xs side-pin${session.pinned ? ' on' : ''}`);
  const label = session.pinned ? 'Unpin' : 'Pin to the top'; setAttr(pin, 'aria-label', label); setAttr(pin, 'title', label);
}

/* ---------- session page ---------- */
// The page is split into regions that are rebuilt only when their content changes,
// so polling every few seconds never restarts animations or steals a tap.
const sv = { id: null, sig: '', witnessed: false, status: '', hadOpen: false, refs: null, placeholder: '' };

function sessionModel(session) {
  const name = session.deviceName || deviceName(session.deviceId);
  const device = deviceById(session.deviceId);
  const status = statusOf(session); const prompt = trustPrompt(session); const issue = sessionIssue(session);
  const active = sessionActive(session); const busy = state.busy.has(session.id); const ready = sessionReady(session);
  const mode = MODE_LABELS[session.permissionMode] ? session.permissionMode : 'default';
  const started = session.startedAt || session.createdAt || '';
  const vm = {
    title: sessionTitle(session), pinned: !!session.pinned, path: session.path || '', status, deviceName: name, deviceType: deviceType(device || { name }),
    mode, modeLabel: MODE_LABELS[mode], modeText: MODE_TEXT[mode],
    time: { fmt: ready ? 'for' : 'started', ts: started },
    stage: { kind: 'none', key: 'none' }, actions: [], notes: [], details: []
  };
  if (session.stopping && active) vm.stage = { kind: 'stopping', key: 'stopping', text: `Stopping Claude on ${name}…` };
  else if (session.status === 'starting' || (ready && sv.witnessed)) vm.stage = launchModel(session, { name, prompt, issue, ready });
  else if (session.status === 'failed') vm.stage = { kind: 'end', key: 'end:failed', tone: 'error', title: 'Claude couldn’t start', text: session.error || 'Claude is no longer running for this session.' };
  else if (session.status === 'offline') vm.stage = { kind: 'end', key: 'end:offline', tone: '', title: 'This session has ended', text: session.error || 'Claude is no longer running for this session.' };
  else if (session.status === 'stopped') vm.stage = { kind: 'end', key: 'end:stopped', tone: '', title: 'Stopped', text: '', stoppedAt: session.stoppedAt || '' };

  if (ready && !session.stopping) {
    vm.actions.push({ id: 'open', label: 'Open in Claude', icon: 'open', cls: 'btn-primary', url: session.url });
    vm.actions.push({ id: 'copy', label: 'Copy link', icon: 'copy', cls: 'btn-ghost' });
    if (canShare()) vm.actions.push({ id: 'share', label: 'Share', icon: 'share', cls: 'btn-ghost' });
  }
  if (active) {
    const canStop = session.canStop !== false && session.deviceOnline !== false;
    vm.actions.push({ id: 'stop', label: session.stopping ? 'Stopping…' : 'Stop', icon: 'stop', cls: 'btn-danger-ghost grow', disabled: !canStop || !!session.stopping || busy || !navigator.onLine });
    if (session.deviceOnline === false) vm.actions.push({ id: 'remove', label: 'Remove', icon: 'trash', cls: 'btn-ghost', disabled: busy });
  } else {
    vm.actions.push({ id: 'again', label: 'Start again', icon: 'restart', cls: 'btn-primary', disabled: !online(device) || state.launching || !navigator.onLine });
    vm.actions.push({ id: 'remove', label: 'Remove', icon: 'trash', cls: 'btn-ghost grow', disabled: busy });
  }

  if (active && session.deviceOnline === false) vm.notes.push({ text: `${name} is offline, so it can't be stopped from here. Removing it only hides it from this list.` });
  else if (active && session.canStop === false) vm.notes.push({ text: `The Anywhere agent on ${name} is an older version that can't stop sessions. Update it on that device to enable Stop.` });
  if (!active && !online(device)) vm.notes.push({ text: `${name} is offline. Wake it to start this folder again.` });
  if (session.stopError) vm.notes.push({ text: session.stopError, error: true });
  const actionError = state.actionErrors.get(session.id); if (actionError) vm.notes.push({ text: actionError, error: true });

  vm.details.push(['Device', `${name} (${deviceKind(device || { name })})`], ['Permissions', MODE_LABELS[mode]]);
  if (started) vm.details.push(['Started', fullTime(started)]);
  if (session.stoppedAt) vm.details.push(['Stopped', fullTime(session.stoppedAt)]);
  if (ready) vm.details.push(['Link', session.url]);
  return vm;
}
function launchModel(session, { name, prompt, issue, ready }) {
  const acknowledged = !!(session.startedAt || session.pid || prompt || ready);
  const steps = [
    { label: `Reach ${name}`, state: acknowledged ? 'done' : issue ? 'attention' : 'active' },
    { label: `Start Claude in ${folderName(session.path)}`, state: ready ? 'done' : !acknowledged ? 'pending' : (prompt || issue) ? 'attention' : 'active' },
    { label: 'Get the Claude link', state: ready ? 'done' : 'pending' }
  ];
  let sub = { kind: 'none', key: 'none' };
  if (prompt) {
    const key = `${session.id}:${prompt.nonce}`;
    sub = { kind: 'trust', key: `trust:${prompt.nonce}`, sessionId: session.id, nonce: prompt.nonce, promptKind: prompt.kind, path: prompt.path, message: prompt.message, device: name, submitted: state.submittedTrust.get(session.id) === prompt.nonce, sending: state.confirmingTrust.has(key), error: state.trustErrors.get(key) || '', online: navigator.onLine };
  } else if (issue) {
    sub = { kind: 'issue', key: `issue:${issue.label}`, sessionId: session.id, title: issue.title, message: issue.message, checking: !!state.sessionChecks.get(session.id)?.checking, online: navigator.onLine };
  }
  return { kind: 'launch', key: 'launch', ready, title: ready ? `Claude is ready on ${name}` : `Starting Claude on ${name}`, createdAt: session.createdAt || '', steps, sub };
}

function renderSlot(host, key, part, data, first) {
  if (host._key !== key) {
    const refs = part?.build ? part.build(data) : null;
    host.replaceChildren(...(refs?.root ? [refs.root] : []));
    host._key = key; host._refs = refs;
    if (!first && refs?.root) enter(refs.root);
  }
  if (part?.update && host._refs) part.update(host._refs, data, first);
}
function runAction(id) {
  const session = findSession(sv.id); if (!session) return;
  if (id === 'copy') copyLink(session.url);
  else if (id === 'share') shareLink(session.id);
  else if (id === 'stop') askStop(session.id);
  else if (id === 'remove') removeSession(session.id);
  else if (id === 'again') askLaunch({ deviceId: session.deviceId, path: session.path, permissionMode: session.permissionMode || 'default' });
}
const ACTIONS_PART = {
  build(actions) {
    const root = el('div', 's-actions');
    for (const action of actions) {
      let node;
      if (action.id === 'open') { node = el('a', `btn ${action.cls}`, action.label); node.href = action.url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      else { node = el('button', `btn ${action.cls}`, action.label); node.type = 'button'; node.disabled = !!action.disabled; node.addEventListener('click', () => runAction(action.id)); }
      withIcon(node, action.icon); node.dataset.action = action.id; root.append(node);
    }
    return { root };
  }
};
const NOTES_PART = {
  build(notes) {
    if (!notes.length) return null;
    const root = el('div');
    for (const note of notes) { const node = el('p', `s-note${note.error ? ' error' : ''}`, note.text); if (note.error) node.setAttribute('role', 'alert'); root.append(node); }
    return { root };
  }
};
const DETAILS_PART = {
  build(details) {
    const root = el('dl', 's-details');
    for (const [label, value] of details) root.append(el('dt', '', label), el('dd', '', value));
    return { root };
  }
};
const LAUNCH_SUBS = {
  none: { build: () => null },
  trust: {
    build(data) {
      const root = el('div', 'trust-panel'); const head = el('div', 'trust-title');
      head.append(el('span', 'spark'), el('span', '', `Claude is asking on ${data.device}`));
      const button = el('button', 'btn btn-primary btn-block'); button.type = 'button';
      const { sessionId, nonce } = data;
      button.addEventListener('click', () => confirmNativeTrust(sessionId, nonce));
      const note = el('p', 's-note', 'Waiting for Claude to continue. This page updates by itself.');
      const error = el('p', 's-note error'); error.setAttribute('role', 'alert');
      root.append(head, el('p', '', data.message), el('code', 'code-block', data.path), button, note, error);
      return { root, button, note, error };
    },
    update(refs, data) {
      setText(refs.button, data.submitted ? 'Confirmation sent' : data.sending ? 'Sending…' : data.promptKind === 'folder' ? 'Trust folder and continue' : 'Enable and continue');
      setProp(refs.button, 'disabled', data.submitted || data.sending || !data.online);
      setVisible(refs.note, data.submitted);
      setText(refs.error, data.error); setVisible(refs.error, !!data.error);
    }
  },
  issue: {
    build(data) {
      const root = el('div', 'issue-panel'); const title = el('div', 'trust-title'); const message = el('p');
      const button = el('button', 'btn btn-ghost'); button.type = 'button'; withIcon(button, 'restart');
      const label = el('span'); button.append(label);
      const { sessionId } = data; button.addEventListener('click', () => checkSessionNow(sessionId));
      root.append(title, message, button);
      return { root, title, message, button, label };
    },
    update(refs, data) {
      setText(refs.title, data.title); setText(refs.message, data.message);
      setText(refs.label, data.checking ? 'Checking…' : 'Check status');
      setProp(refs.button, 'disabled', data.checking || !data.online);
    }
  }
};
function landSpark(spark, animate) {
  const spin = spark.getAnimations().find((animation) => animation.animationName === 'spin');
  const angle = spin && typeof spin.currentTime === 'number' ? ((spin.currentTime % 1600) / 1600) * 360 : 0;
  spark.classList.remove('spark-spin');
  if (animate) play(spark, [{ transform: `rotate(${angle}deg) scale(1)` }, { transform: 'rotate(360deg) scale(1.25)', offset: 0.7 }, { transform: 'rotate(360deg) scale(1)' }], { id: 'land', duration: MOTION.lazy });
}
function celebrateStep(step) {
  const mark = step.querySelector('.step-mark');
  play(mark, [{ transform: 'scale(.6)' }, { transform: 'scale(1.18)', offset: 0.6 }, { transform: 'scale(1)' }], { id: 'pop', duration: MOTION.slow });
  const path = mark.querySelector('path');
  if (path) play(path, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { id: 'draw', duration: MOTION.slow, delay: 60, fill: 'backwards' });
}
const STAGES = {
  none: { build: () => null },
  stopping: {
    build(data) {
      const root = el('div', 's-card'); const head = el('div', 's-card-head');
      head.append(el('span', 'spark spark-spin'), el('span', '', data.text));
      root.append(head, el('p', '', 'This usually takes a few seconds.'));
      return { root };
    }
  },
  end: {
    build(data) { const root = el('div', `s-card${data.tone ? ` ${data.tone}` : ''}`); const text = el('p'); root.append(el('div', 's-card-head', data.title), text); return { root, text }; },
    update(refs, data) {
      if (data.key !== 'end:stopped') { setText(refs.text, data.text); return; }
      if (refs.text._ts === data.stoppedAt) return;
      refs.text._ts = data.stoppedAt;
      const parts = [document.createTextNode('You stopped this session')];
      if (data.stoppedAt) parts.push(document.createTextNode(' '), timeNode(data.stoppedAt, 'ago'));
      parts.push(document.createTextNode('. Start it again to get a fresh link.'));
      refs.text.replaceChildren(...parts);
    }
  },
  launch: {
    build(data) {
      const root = el('div', 's-card launch-card'); const head = el('div', 'launch-head');
      const spark = el('span', 'spark launch-spark spark-spin'); const title = el('span', 'launch-title'); const elapsed = timeNode(data.createdAt, 'secs', 'launch-elapsed');
      head.append(spark, title, elapsed);
      const list = el('ol', 'timeline');
      const steps = data.steps.map(() => { const step = el('li', 'step'); const mark = el('span', 'step-mark'); mark.append(icon('check')); step.append(mark, el('span', 'step-label')); list.append(step); return step; });
      const sub = el('div', 'launch-sub');
      root.append(head, list, sub);
      return { root, spark, title, elapsed, steps, sub };
    },
    update(refs, data, first) {
      setText(refs.title, data.title);
      setVisible(refs.elapsed, !data.ready);
      const spinning = refs.spark.classList.contains('spark-spin');
      if (!data.ready && !spinning) refs.spark.classList.add('spark-spin');
      if (data.ready && spinning) landSpark(refs.spark, !first);
      data.steps.forEach((step, index) => {
        const node = refs.steps[index];
        setText(node.children[1], step.label);
        if (node.dataset.state !== step.state) { const was = node.dataset.state; node.dataset.state = step.state; if (!first && was && step.state === 'done') celebrateStep(node); }
      });
      renderSlot(refs.sub, data.sub.key, LAUNCH_SUBS[data.sub.kind], data.sub, first);
    }
  }
};

function mountSession(session) {
  const refs = {};
  const head = el('div', 's-head'); const titles = el('div', 's-titles'); const meta = el('div', 's-meta');
  refs.title = el('h1', 'serif s-title');
  refs.pill = el('span', 'pill'); refs.pillDot = el('span', 'dot'); refs.pillLabel = el('span', 'pill-label'); refs.pill.append(refs.pillDot, refs.pillLabel);
  refs.device = el('span'); refs.mode = el('span'); refs.time = el('span');
  meta.append(refs.pill, refs.device, refs.mode, refs.time); titles.append(refs.title, meta);
  refs.pin = iconButton('pin', 's-tool', 'Pin to the top', () => togglePin(sv.id));
  refs.rename = iconButton('pencil', 's-tool', 'Rename', startRename);
  const tools = el('div', 's-tools'); tools.append(refs.pin, refs.rename);
  head.append(titles, tools);
  refs.path = el('code', 'code-block s-path');
  refs.stage = el('div'); refs.actions = el('div'); refs.notes = el('div'); refs.details = el('div');
  $('session-view').replaceChildren(head, refs.path, refs.stage, refs.actions, refs.notes, refs.details);
  Object.assign(sv, { id: session.id, sig: '', witnessed: session.status === 'starting', status: '', hadOpen: false, refs, placeholder: '', renaming: false });
}
function patchHead(vm, first) {
  const refs = sv.refs;
  setText(refs.title, vm.title);
  setClass(refs.pin, `icon-btn xs s-tool${vm.pinned ? ' on' : ''}`); setAttr(refs.pin, 'aria-pressed', String(vm.pinned));
  const pinLabel = vm.pinned ? 'Unpin' : 'Pin to the top'; setAttr(refs.pin, 'aria-label', pinLabel); setAttr(refs.pin, 'title', pinLabel);
  setText(refs.path, vm.path); setAttr(refs.path, 'title', vm.path);
  const pillClass = `pill ${vm.status.cls}`.trim();
  if (refs.pill.className !== pillClass) {
    const wasReady = refs.pill.classList.contains('ready');
    setClass(refs.pill, pillClass); setClass(refs.pillDot, `dot ${vm.status.cls}`.trim());
    if (!first && vm.status.cls === 'ready' && !wasReady) ping(refs.pillDot);
  }
  if (refs.pillLabel.textContent !== vm.status.label) {
    setText(refs.pillLabel, vm.status.label);
    if (!first) play(refs.pillLabel, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { id: 'label', duration: MOTION.base });
  }
  const deviceKey = `${vm.deviceType}|${vm.deviceName}`;
  if (refs.device._key !== deviceKey) { refs.device._key = deviceKey; refs.device.replaceChildren(icon(vm.deviceType), document.createTextNode(vm.deviceName)); }
  if (refs.mode._key !== vm.mode) { refs.mode._key = vm.mode; refs.mode.replaceChildren(icon(MODE_ICONS[vm.mode]), document.createTextNode(vm.modeLabel)); setAttr(refs.mode, 'title', vm.modeText); }
  const timeKey = `${vm.time.fmt}|${vm.time.ts}`;
  if (refs.time._key !== timeKey) { refs.time._key = timeKey; refs.time.replaceChildren(...(vm.time.ts ? [icon('clock'), timeNode(vm.time.ts, vm.time.fmt)] : [])); setVisible(refs.time, !!vm.time.ts); }
}
function startRename() {
  const session = findSession(sv.id); if (!session || sv.renaming || !sv.refs) return;
  sv.renaming = true;
  const title = sv.refs.title; const original = sessionTitle(session); const folder = folderName(session.path);
  const input = el('input', 'serif s-title s-title-input'); input.value = original; input.maxLength = 60;
  input.setAttribute('aria-label', 'Session name'); input.enterKeyHint = 'done'; input.placeholder = folder;
  title.hidden = true; title.after(input); smoothInput(input); input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return; done = true; sv.renaming = false;
    const value = input.value.trim(); input.closest('.smooth-field').remove(); title.hidden = false;
    if (keep && value !== original) { patchSession(session.id, { label: value === folder ? '' : value }); toast(value && value !== folder ? 'Renamed.' : 'Name reset to the folder name.'); }
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
}
function renderSessionView() {
  const view = $('session-view');
  if (!state.sessionsLoaded) {
    if (sv.placeholder !== 'loading') { Object.assign(sv, { id: null, placeholder: 'loading' }); const box = el('div', 's-loading'); box.append(el('div', 's-skel s-skel-title'), el('div', 's-skel s-skel-meta'), el('div', 's-skel s-skel-block')); view.replaceChildren(box); setTopbarTitle('Session'); }
    return;
  }
  const session = visibleSessions().find((item) => item.id === state.route.id);
  if (!session) {
    if (sv.placeholder !== 'missing') {
      Object.assign(sv, { id: null, placeholder: 'missing' });
      const box = el('div', 's-missing'); box.append(el('span', 'spark spark-lg'), el('h1', 'serif s-title', 'Session not found'), el('p', 's-note', 'It may have been removed from the list.'));
      const back = el('a', 'btn btn-ghost', 'New session'); back.href = '#/'; back.addEventListener('click', (event) => { event.preventDefault(); newSession(); });
      box.append(back); view.replaceChildren(box); setTopbarTitle('Session');
    }
    return;
  }
  if (sv.id !== session.id) mountSession(session);
  if (session.status === 'starting') sv.witnessed = true;
  const vm = sessionModel(session);
  const signature = JSON.stringify(vm);
  if (signature === sv.sig) return;
  const first = !sv.sig; sv.sig = signature;
  setTopbarTitle(vm.title);
  patchHead(vm, first);
  renderSlot(sv.refs.stage, vm.stage.key, STAGES[vm.stage.kind], vm.stage, first);
  renderSlot(sv.refs.actions, JSON.stringify(vm.actions), ACTIONS_PART, vm.actions, first);
  const hasOpen = vm.actions.some((action) => action.id === 'open');
  if (hasOpen && !sv.hadOpen && !first) { const open = sv.refs.actions.querySelector('[data-action="open"]'); if (open) setTimeout(() => ring(open), 250); }
  sv.hadOpen = hasOpen;
  renderSlot(sv.refs.notes, JSON.stringify(vm.notes), NOTES_PART, vm.notes, first);
  renderSlot(sv.refs.details, JSON.stringify(vm.details), DETAILS_PART, vm.details, true);
  if (!first && vm.status.label !== sv.status) setText($('session-live'), `${vm.title}: ${vm.status.label}`);
  sv.status = vm.status.label;
}

/* ---------- add and remove devices ---------- */
const enrollment = { os: 'linux', deviceId: '', command: '', timer: 0 };
function openAddDevice() {
  clearTimeout(enrollment.timer); Object.assign(enrollment, { deviceId: '', command: '' });
  setVisible('add-step-1', true); setVisible('add-step-2', false); setVisible('add-device-error', false);
  setField($('new-device-name'), ''); closeDrawer(); openDialog($('add-device-dialog'));
  setTimeout(() => $('new-device-name').focus(), 80);
}
function pickOs(os) {
  enrollment.os = os;
  for (const option of document.querySelectorAll('.os-option')) setAttr(option, 'aria-checked', String(option.dataset.os === os));
}
async function createEnrollment() {
  const name = $('new-device-name').value.trim();
  if (!name) { setText($('add-device-error'), 'Give the device a name.'); setVisible('add-device-error', true); $('new-device-name').focus(); return; }
  const button = $('create-enrollment'); button.disabled = true; setVisible('add-device-error', false);
  try {
    const data = await api('/api/enrollments', { method: 'POST', body: { name, os: enrollment.os } });
    const windows = enrollment.os === 'windows';
    Object.assign(enrollment, { deviceId: data.deviceId, command: windows ? data.commands.windows : data.commands.unix });
    setText($('enroll-intro'), windows ? `On ${name}, open PowerShell and run:` : `On ${name}, open a terminal${enrollment.os === 'wsl' ? ' in WSL' : ''} and run:`);
    setText($('enroll-command'), enrollment.command);
    setClass($('enroll-wait'), 'enroll-wait');
    setText($('enroll-wait').lastElementChild, 'Waiting for the device… The command works once and expires in 30 minutes.');
    setClass($('enroll-wait').firstElementChild, 'dot starting');
    const from = $('add-device-dialog').offsetHeight;
    setVisible('add-step-1', false); setVisible('add-step-2', true);
    animateHeight($('add-device-dialog'), from); enter($('add-step-2'), { y: 8 });
    waitForEnrollment(data.deviceId, name);
  } catch (error) { setText($('add-device-error'), messageOf(error)); setVisible('add-device-error', true); }
  finally { button.disabled = false; }
}
function waitForEnrollment(id, name) {
  clearTimeout(enrollment.timer);
  enrollment.timer = setTimeout(async () => {
    if (!$('add-device-dialog').open || enrollment.deviceId !== id) return;
    try { await refreshDevices(); } catch { /* keep waiting */ }
    const device = deviceById(id);
    if (device && online(device)) {
      setClass($('enroll-wait'), 'enroll-wait done'); setClass($('enroll-wait').firstElementChild, 'dot online');
      setText($('enroll-wait').lastElementChild, `${name} is connected.`);
      toast(`${name} is ready.`);
      return;
    }
    waitForEnrollment(id, name);
  }, 3000);
}
async function forgetDevice(id) {
  const device = deviceById(id); if (!device) return;
  if (!window.confirm(`Remove ${device.name || id}? Its agent will be disconnected; add it again to use it.`)) return;
  try { const data = await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); state.devices = data.devices || state.devices.filter((item) => item.id !== id); renderAll(); toast(`${device.name || id} removed.`); }
  catch (error) { toast(messageOf(error), { tone: 'error' }); }
}

/* ---------- drawer ---------- */
function drawerOpen() { return $('shell').classList.contains('drawer-open'); }
function openDrawer() {
  if (drawerOpen()) return;
  $('shell').classList.add('drawer-open'); setAttr($('open-sidebar'), 'aria-expanded', 'true');
  if (narrowScreen.matches) { $('main-col').inert = true; setTimeout(() => $('close-sidebar').focus({ preventScroll: true }), 60); }
}
function closeDrawer({ restoreFocus = false } = {}) {
  if (!drawerOpen()) return;
  $('shell').classList.remove('drawer-open'); setAttr($('open-sidebar'), 'aria-expanded', 'false'); $('main-col').inert = false;
  if (restoreFocus) $('open-sidebar').focus({ preventScroll: true });
}
// Follow the finger: drag the drawer closed, or swipe in from the left edge in the Home Screen app.
function initDrawerGestures() {
  const shell = $('shell'); const side = $('sidebar'); const scrim = $('scrim'); let drag = null; let suppressUntil = 0;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const begin = (event, mode) => {
    if (!narrowScreen.matches || event.pointerType === 'mouse') return;
    drag = { id: event.pointerId, mode, x0: event.clientX, y0: event.clientY, width: side.offsetWidth, locked: false, samples: [[event.timeStamp, event.clientX]] };
  };
  $('edge-swipe').addEventListener('pointerdown', (event) => { if (!drawerOpen()) begin(event, 'open'); });
  side.addEventListener('pointerdown', (event) => { if (drawerOpen()) begin(event, 'close'); });
  scrim.addEventListener('pointerdown', (event) => { if (drawerOpen()) begin(event, 'close'); });
  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x0; const dy = event.clientY - drag.y0;
    if (!drag.locked) {
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { drag = null; return; }
      drag.locked = true; shell.classList.add('dragging');
    }
    const x = drag.mode === 'open' ? clamp(dx - drag.width, -drag.width, 0) : clamp(dx, -drag.width, 0);
    side.style.transform = `translate3d(${x}px, 0, 0)`; scrim.style.opacity = String(1 + x / drag.width);
    drag.samples.push([event.timeStamp, event.clientX]); if (drag.samples.length > 5) drag.samples.shift();
  }, { passive: true });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const gesture = drag; drag = null; if (!gesture.locked) return;
    const [t0, x0] = gesture.samples[0]; const [t1, x1] = gesture.samples.at(-1);
    const velocity = (x1 - x0) / Math.max(1, t1 - t0); const dx = event.clientX - gesture.x0;
    const open = event.type === 'pointercancel' ? gesture.mode === 'close'
      : gesture.mode === 'open' ? dx > gesture.width * 0.35 || velocity > 0.4 : !(dx < -gesture.width * 0.35 || velocity < -0.4);
    shell.classList.remove('dragging'); side.style.transform = ''; scrim.style.opacity = '';
    suppressUntil = event.timeStamp + 350;
    if (open) openDrawer(); else closeDrawer();
  };
  window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  document.addEventListener('click', (event) => { if (event.timeStamp < suppressUntil) { event.preventDefault(); event.stopPropagation(); } }, true);
}

function networkChanged() { setVisible('offline-banner', !navigator.onLine); updateLaunchButton(); renderAll(); }
function showInstall() { setVisible('native-install', !!state.installPrompt); closeDrawer(); openDialog($('install-dialog')); }

/* ---------- events ---------- */
for (const dialog of document.querySelectorAll('dialog.dialog')) {
  dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); closeDialog(dialog, event.submitter?.value || 'cancel'); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(dialog, 'cancel'); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog, 'cancel'); });
}
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('login-submit').disabled = true; $('login-submit').textContent = 'Connecting…'; setVisible('login-error', false);
  try {
    await api('/api/login', { method: 'POST', body: { token: $('access-token').value.trim() } });
    $('access-token').value = '';
    await loadStatus();
    await openWorkspace();
  } catch (error) { $('login-error').textContent = messageOf(error); setVisible('login-error', true); play($('login-form'), [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 320 }); }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Continue'; }
});
$('logout-button').addEventListener('click', async () => { flushRemovals(); try { await api('/api/logout', { method: 'POST', body: {} }); showLogin(); } catch (error) { showError(messageOf(error)); } });
for (const toggle of document.querySelectorAll('[data-collapse]')) toggle.addEventListener('click', () => toggleCollapsed(toggle.dataset.collapse));
$('refresh-folders').addEventListener('click', () => { if (state.directory?.path) browse(state.directory.path); });
$('folder-up').addEventListener('click', () => { if (state.directory?.parentPath) browse(state.directory.parentPath); });
$('folder-list').addEventListener('click', (event) => { const row = event.target.closest('.folder-row'); if (row && !row.disabled && row._path) browse(row._path); });
$('path-form').addEventListener('submit', (event) => { event.preventDefault(); const path = $('folder-path').value.trim(); if (path) browse(path); });
$('folder-filter').addEventListener('input', () => { state.folderFilter = $('folder-filter').value; applyFolderFilter(); });
$('filter-form').addEventListener('submit', (event) => { event.preventDefault(); const only = applyFolderFilter(); if (only) browse(only._path); });
$('toggle-hidden').addEventListener('click', () => { state.showHidden = !state.showHidden; writeFlag('anywhere-show-hidden', state.showHidden); if (state.directory) renderFolder(); });
$('launch-button').addEventListener('click', () => {
  if ($('launch-button').disabled || !state.selected || !state.directory?.path) return;
  const running = activeSessionAt(state.selected.id, state.directory.path);
  if (running) { navigate(`#/s/${running.id}`); return; }
  askLaunch({ deviceId: state.selected.id, path: state.directory.path, permissionMode: modeFor(state.selected) });
});
$('mode-select').addEventListener('change', () => { state.mode = $('mode-select').value; });
$('trust-dialog').addEventListener('close', () => { const request = state.pendingLaunch; state.pendingLaunch = null; if ($('trust-dialog').returnValue === 'start') launch(request); });
$('stop-dialog').addEventListener('close', () => { const id = state.pendingStop; state.pendingStop = null; if ($('stop-dialog').returnValue === 'stop' && id) stopSession(id); });
$('clear-history').addEventListener('click', clearHistory);
$('add-device').addEventListener('click', openAddDevice);
$('create-enrollment').addEventListener('click', createEnrollment);
$('new-device-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); createEnrollment(); } });
for (const option of document.querySelectorAll('.os-option')) option.addEventListener('click', () => pickOs(option.dataset.os));
$('copy-enroll').addEventListener('click', () => copyLink(enrollment.command).then(() => setText($('copy-enroll'), 'Copied')));
$('add-device-dialog').addEventListener('close', () => { clearTimeout(enrollment.timer); setText($('copy-enroll'), 'Copy command'); });
document.querySelectorAll('a[href="#/"]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); newSession(); }));
$('open-sidebar').addEventListener('click', openDrawer);
$('close-sidebar').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
$('scrim').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
$('install-button').addEventListener('click', showInstall);
$('native-install').addEventListener('click', async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; closeDialog($('install-dialog'), 'close'); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drawerOpen()) closeDrawer({ restoreFocus: true }); });
document.addEventListener('touchstart', () => {}, { passive: true });
window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; });
window.addEventListener('appinstalled', () => { state.installPrompt = null; toast('Anywhere is on your Home Screen.'); });
window.addEventListener('online', networkChanged); window.addEventListener('offline', networkChanged);
window.addEventListener('pagehide', flushRemovals);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushRemovals(); return; }
  if (!state.authenticated) return;
  updateGreeting(); tickTimes(); refreshAll();
});
setInterval(() => { if (!document.hidden && state.authenticated && navigator.onLine) refreshAll(); }, 20000);
setInterval(tickTimes, 1000);
document.documentElement.classList.toggle('standalone', navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches);
initDrawerGestures();
initDeviceDrag();
for (const id of ['folder-path', 'folder-filter', 'new-device-name']) smoothInput($(id));
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('/sw.js').catch(() => {});
networkChanged(); boot();
