const CONNECT_TIMEOUT_MS = 15000;
const IMAGES_TIMEOUT_MS = 35000;

const FORMATTER_LABELS = { 1: '1PO', 2: '2PO', 3: '3PO' };

const state = {
  all: [],
  filtered: [],
  index: 0,
  mode: 'grid',
  gridScrollTop: 0,
  activeFormatters: new Set(),
  activeSaleCategories: new Set(),
  activeTypes: new Set(),
};

const el = (id) => document.getElementById(id);

function formatterLabel(value) {
  return FORMATTER_LABELS[value] || null;
}

function dedupeBySrc(items) {
  const bySrc = new Map();
  for (const item of items) {
    const existing = bySrc.get(item.src);
    if (!existing || item.key < existing.key) {
      bySrc.set(item.src, item);
    }
  }
  return Array.from(bySrc.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const img = entry.target;
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        thumbObserver.unobserve(img);
      }
    });
  },
  { rootMargin: '300px' }
);

async function connect() {
  const uri = el('uri-input').value.trim();
  el('connect-error').textContent = '';

  if (!uri) {
    el('connect-error').textContent = 'Please paste a connection URI.';
    return;
  }

  el('connect-btn').disabled = true;
  el('connect-btn').textContent = 'Connecting...';

  try {
    const res = await fetchWithTimeout(
      '/connect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri }),
      },
      CONNECT_TIMEOUT_MS
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connection failed.');

    el('uri-input').value = '';
    el('connect-screen').classList.add('hidden');
    el('app-screen').classList.remove('hidden');
  } catch (err) {
    el('connect-error').textContent =
      err.name === 'AbortError'
        ? `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s. Check the URI and that the database is reachable, then try again.`
        : err.message;
    return;
  } finally {
    el('connect-btn').disabled = false;
    el('connect-btn').textContent = 'Connect';
  }

  await loadImagesWithFeedback();
}

function setLoading(text, isError) {
  const status = el('loading-status-grid');
  const textEl = el('loading-text-grid');
  status.classList.remove('hidden');
  status.classList.toggle('error', Boolean(isError));
  el('thumbnail-grid').classList.add('hidden');
  textEl.textContent = text;
}

function clearLoading() {
  el('loading-status-grid').classList.add('hidden');
  el('thumbnail-grid').classList.remove('hidden');
}

async function loadImagesWithFeedback() {
  let seconds = 0;
  setLoading('Loading images...');
  const tick = setInterval(() => {
    seconds += 1;
    el('loading-text-grid').textContent = `Loading images... (${seconds}s)`;
  }, 1000);

  try {
    await loadImages();
    clearLoading();
  } catch (err) {
    const msg =
      err.name === 'AbortError'
        ? `Loading images timed out after ${IMAGES_TIMEOUT_MS / 1000}s. The "managers" collection may be very large, or the connection stalled — check the server's terminal window for query timing.`
        : err.message;
    setLoading(msg, true);
  } finally {
    clearInterval(tick);
  }
}

async function loadImages() {
  const res = await fetchWithTimeout('/api/images', {}, IMAGES_TIMEOUT_MS);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load images.');

  state.all = data.results;
  state.filtered = state.all;
  state.index = 0;
  state.mode = 'grid';
  state.activeFormatters.clear();
  state.activeSaleCategories.clear();
  state.activeTypes.clear();
  el('filter-input').value = '';
  document.querySelectorAll('.formatter-btn').forEach((btn) => btn.classList.remove('active'));
  el('hide-duplicates-checkbox').checked = false;
  clearEmptyFilterHint();

  if (data.truncated) {
    el('truncated-banner').textContent =
      `Showing first ${state.all.length} results — more matched, list was truncated.`;
    el('truncated-banner').classList.remove('hidden');
  }

  if (state.all.length === 0) {
    await runDiagnostics();
  } else {
    el('diagnostics').classList.add('hidden');
  }

  el('viewer-screen').classList.add('hidden');
  el('grid-screen').classList.remove('hidden');
  renderGrid();
}

async function runDiagnostics() {
  const box = el('diagnostics');
  try {
    const res = await fetchWithTimeout('/api/debug', {}, IMAGES_TIMEOUT_MS);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Diagnostics failed.');

    const lines = [];
    lines.push(`No matches found. Diagnostics for database "${data.dbName}":`);
    lines.push(`Collections found: ${data.collectionNames.join(', ') || '(none)'}`);
    if (!data.hasCollection) {
      lines.push(`⚠ No collection named "managers" exists in this database.`);
    } else {
      lines.push(
        `"managers" collection: ${data.totalDocs} documents total, ${data.popupDocs} with an _id starting with "popup:".`
      );
      if (data.sampleManagerEntries.length) {
        data.sampleManagerEntries.forEach((entry, i) => {
          lines.push(
            `  [${i}] _id=${entry._id} keys=[${entry.topLevelKeys.join(', ')}] designList shape=${entry.designListShape}`
          );
        });
      } else {
        lines.push(`⚠ No documents with a "popup:" _id found.`);
      }
    }
    box.textContent = lines.join('\n');
    box.classList.remove('hidden');
  } catch (err) {
    box.textContent = `Diagnostics failed: ${err.message}`;
    box.classList.remove('hidden');
  }
}

function renderGrid() {
  const container = el('thumbnail-grid');
  container.innerHTML = '';
  thumbObserver.disconnect();

  state.filtered.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'thumb';
    card.title = `${item.key}\n${item.src}`;

    const img = document.createElement('img');
    img.dataset.src = item.src;
    img.alt = item.key;
    card.appendChild(img);

    const badgeLabel = formatterLabel(item.poTier);
    if (badgeLabel) {
      const badge = document.createElement('div');
      badge.className = 'thumb-badge';
      badge.textContent = badgeLabel;
      card.appendChild(badge);
    }

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = item.key;
    card.appendChild(label);

    card.addEventListener('click', () => openViewer(i));
    container.appendChild(card);
    thumbObserver.observe(img);
  });

  el('counter').textContent = `${state.filtered.length} image${state.filtered.length === 1 ? '' : 's'}`;
}

function openViewer(index) {
  state.gridScrollTop = window.scrollY;
  state.mode = 'viewer';
  state.index = index;
  el('grid-screen').classList.add('hidden');
  el('viewer-screen').classList.remove('hidden');
  renderViewerImage();
}

function backToGrid() {
  state.mode = 'grid';
  el('viewer-screen').classList.add('hidden');
  el('grid-screen').classList.remove('hidden');
  renderGrid();
  window.scrollTo(0, state.gridScrollTop);
}

function applyFilter() {
  const rawText = el('filter-input').value;
  const q = rawText.trim().toLowerCase();
  const activeFormatters = state.activeFormatters;
  const activeSaleCategories = state.activeSaleCategories;
  const activeTypes = state.activeTypes;
  const hideDuplicates = el('hide-duplicates-checkbox').checked;

  // Capture the exact item being viewed (by reference) before recomputing,
  // so we can try to keep showing it after the filter changes rather than
  // jumping to whatever lands at index 0 of the new results.
  const previousItem = state.mode === 'viewer' ? state.filtered[state.index] : null;

  const base = hideDuplicates ? dedupeBySrc(state.all) : state.all;

  state.filtered = base.filter((r) => {
    if (
      q &&
      !r.key.toLowerCase().includes(q) &&
      !r.src.toLowerCase().includes(q) &&
      !(r.monitorName && r.monitorName.toLowerCase().includes(q))
    ) {
      return false;
    }
    if (activeFormatters.size > 0 && !activeFormatters.has(r.poTier)) {
      return false;
    }
    if (activeSaleCategories.size > 0 && !activeSaleCategories.has(r.saleCategory)) {
      return false;
    }
    if (activeTypes.size > 0 && !activeTypes.has(r.popupType)) {
      return false;
    }
    return true;
  });

  if (state.filtered.length === 0) {
    scheduleEmptyFilterCheck(rawText);
  } else {
    clearEmptyFilterHint();
  }

  if (state.mode === 'viewer') {
    const newIndex = previousItem ? state.filtered.indexOf(previousItem) : -1;
    if (newIndex === -1) {
      // The popup being viewed no longer matches — nothing sensible to keep
      // showing, so drop back to the (now up-to-date) grid instead.
      backToGrid();
    } else {
      state.index = newIndex;
      renderViewerImage();
    }
  } else {
    state.index = 0;
    renderGrid();
  }
}

let emptyHintDebounce = null;
let emptyHintController = null;

function clearEmptyFilterHint() {
  clearTimeout(emptyHintDebounce);
  if (emptyHintController) emptyHintController.abort();
  const hint = el('filter-empty-hint');
  hint.textContent = '';
  hint.classList.add('hidden');
}

function scheduleEmptyFilterCheck(rawText) {
  clearTimeout(emptyHintDebounce);
  if (emptyHintController) emptyHintController.abort();

  const id = rawText.trim();
  const hint = el('filter-empty-hint');
  hint.textContent = '';
  hint.classList.add('hidden');

  if (!id.startsWith('popup:')) return;

  emptyHintDebounce = setTimeout(async () => {
    emptyHintController = new AbortController();
    try {
      const res = await fetch(`/api/explain/${encodeURIComponent(id)}`, {
        signal: emptyHintController.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.found) return;

      const collision = (data.srcCollisions || []).find((c) => c.totalOwners > 1);
      if (collision) {
        hint.textContent = `shared with ${collision.totalOwners - 1} other popup(s): ${collision.sharedWithOtherDocs.join(', ')}`;
        hint.classList.remove('hidden');
      }
    } catch (err) {
      // ignore aborts and errors — stay silent per terse-output requirement
    }
  }, 350);
}

function toggleFormatter(value) {
  if (state.activeFormatters.has(value)) {
    state.activeFormatters.delete(value);
  } else {
    state.activeFormatters.add(value);
  }
  document.querySelectorAll('.formatter-btn[data-formatter]').forEach((btn) => {
    const btnValue = Number(btn.dataset.formatter);
    btn.classList.toggle('active', state.activeFormatters.has(btnValue));
  });
  applyFilter();
}

function toggleSaleCategory(value) {
  if (state.activeSaleCategories.has(value)) {
    state.activeSaleCategories.delete(value);
  } else {
    state.activeSaleCategories.add(value);
  }
  document.querySelectorAll('.formatter-btn[data-sale-category]').forEach((btn) => {
    btn.classList.toggle('active', state.activeSaleCategories.has(btn.dataset.saleCategory));
  });
  applyFilter();
}

function toggleType(value) {
  if (state.activeTypes.has(value)) {
    state.activeTypes.delete(value);
  } else {
    state.activeTypes.add(value);
  }
  document.querySelectorAll('.formatter-btn[data-type]').forEach((btn) => {
    btn.classList.toggle('active', state.activeTypes.has(btn.dataset.type));
  });
  applyFilter();
}

function renderViewerImage() {
  const total = state.filtered.length;
  el('counter').textContent = `${total ? state.index + 1 : 0} / ${total}`;

  const current = state.filtered[state.index];
  if (!current) {
    el('main-image').src = '';
    el('cap-key').textContent = '';
    el('copy-id-btn').classList.add('hidden');
    el('cap-name').textContent = '';
    el('cap-type').textContent = '';
    el('cap-formatter').textContent = '';
    el('cap-sale-category').textContent = '';
    el('cap-src').textContent = total === 0 ? 'No matches.' : '';
    el('doc-content').textContent = '';
    return;
  }

  el('main-image').src = current.src;
  el('main-image').alt = current.key;
  el('cap-key').textContent = current.key;
  el('copy-id-btn').classList.remove('hidden');
  el('copy-id-btn').classList.remove('copied');
  el('copy-id-btn').textContent = 'Copy';
  el('copy-id-btn').dataset.id = current.key;
  el('cap-name').textContent = current.monitorName || '(none)';
  el('cap-type').textContent = current.popupType || '(none)';
  el('cap-formatter').textContent = formatterLabel(current.poTier) || '(none)';
  el('cap-sale-category').textContent = current.saleCategory || '(none)';
  el('cap-src').textContent = current.src;

  const next = state.filtered[state.index + 1];
  if (next) {
    const preload = new Image();
    preload.src = next.src;
  }

  loadFullDocument(current.id);
}

let docFetchController = null;

async function loadFullDocument(id) {
  const pre = el('doc-content');
  pre.textContent = 'Loading...';

  if (docFetchController) docFetchController.abort();
  docFetchController = new AbortController();

  try {
    const res = await fetch(`/api/manager/${encodeURIComponent(id)}`, {
      signal: docFetchController.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load document.');
    pre.textContent = JSON.stringify(data.doc, null, 2);
  } catch (err) {
    if (err.name === 'AbortError') return;
    pre.textContent = `Failed to load full document: ${err.message}`;
  }
}

function move(delta) {
  if (state.mode !== 'viewer' || !state.filtered.length) return;
  state.index = Math.min(Math.max(state.index + delta, 0), state.filtered.length - 1);
  renderViewerImage();
}

async function copyTextToButton(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
  } catch (err) {
    btn.textContent = 'Failed';
  }

  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('copied');
  }, 1500);
}

function copyId() {
  const btn = el('copy-id-btn');
  copyTextToButton(btn.dataset.id, btn);
}

function isNextIdModalOpen() {
  return !el('next-id-modal-backdrop').classList.contains('hidden');
}

function openNextIdModal() {
  el('next-id-modal-backdrop').classList.remove('hidden');
  el('next-id-body').textContent = 'Loading...';
  fetchNextAvailableId();
}

function closeNextIdModal() {
  el('next-id-modal-backdrop').classList.add('hidden');
}

async function fetchNextAvailableId() {
  const body = el('next-id-body');
  try {
    const res = await fetchWithTimeout('/api/next-available-id', {}, IMAGES_TIMEOUT_MS);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch next available id.');

    body.innerHTML = '';

    const nextRow = document.createElement('div');
    nextRow.className = 'modal-next-id';

    const label = document.createElement('span');
    label.textContent = data.next;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyTextToButton(data.next, copyBtn));

    nextRow.appendChild(label);
    nextRow.appendChild(copyBtn);
    body.appendChild(nextRow);

    if (data.upcoming && data.upcoming.length) {
      const upcoming = document.createElement('div');
      upcoming.className = 'modal-upcoming';
      upcoming.textContent = `Also available next: ${data.upcoming.join(', ')}`;
      body.appendChild(upcoming);
    }
  } catch (err) {
    body.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'modal-error';
    errEl.textContent = err.name === 'AbortError' ? 'Request timed out.' : err.message;
    body.appendChild(errEl);
  }
}

el('connect-btn').addEventListener('click', connect);
el('filter-input').addEventListener('input', applyFilter);
el('back-btn').addEventListener('click', backToGrid);
el('copy-id-btn').addEventListener('click', copyId);
el('hide-duplicates-checkbox').addEventListener('change', applyFilter);
el('next-id-btn').addEventListener('click', openNextIdModal);
el('next-id-close-btn').addEventListener('click', closeNextIdModal);
el('next-id-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === el('next-id-modal-backdrop')) closeNextIdModal();
});

document.querySelectorAll('.formatter-btn[data-formatter]').forEach((btn) => {
  btn.addEventListener('click', () => toggleFormatter(Number(btn.dataset.formatter)));
});

document.querySelectorAll('.formatter-btn[data-sale-category]').forEach((btn) => {
  btn.addEventListener('click', () => toggleSaleCategory(btn.dataset.saleCategory));
});

document.querySelectorAll('.formatter-btn[data-type]').forEach((btn) => {
  btn.addEventListener('click', () => toggleType(btn.dataset.type));
});

document.addEventListener('keydown', (e) => {
  if (isNextIdModalOpen()) {
    if (e.key === 'Escape') closeNextIdModal();
    return;
  }
  if (document.activeElement === el('filter-input')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    move(1);
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    move(-1);
  }
  if (e.key === 'Escape' && state.mode === 'viewer') {
    backToGrid();
  }
});

async function login() {
  const password = el('login-password-input').value;
  el('login-error').textContent = '';
  el('login-btn').disabled = true;
  el('login-btn').textContent = 'Logging in...';

  try {
    const res = await fetchWithTimeout(
      '/api/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      },
      CONNECT_TIMEOUT_MS
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');

    el('login-password-input').value = '';
    el('login-screen').classList.add('hidden');
    el('connect-screen').classList.remove('hidden');
  } catch (err) {
    el('login-error').textContent =
      err.name === 'AbortError' ? 'Login request timed out.' : err.message;
  } finally {
    el('login-btn').disabled = false;
    el('login-btn').textContent = 'Log In';
  }
}

async function logout() {
  try {
    await fetchWithTimeout('/api/logout', { method: 'POST' }, CONNECT_TIMEOUT_MS);
  } catch (err) {
    // proceed regardless — reloading will re-check session state either way
  }
  window.location.reload();
}

async function boot() {
  try {
    const res = await fetchWithTimeout('/api/session', {}, CONNECT_TIMEOUT_MS);
    const data = await res.json();

    if (data.authEnabled) {
      el('logout-btn').classList.remove('hidden');
    }

    if (data.authEnabled && !data.authenticated) {
      el('login-screen').classList.remove('hidden');
    } else {
      el('connect-screen').classList.remove('hidden');
    }
  } catch (err) {
    // If the session check itself fails, fall back to the connect screen —
    // matches pre-auth behavior rather than leaving the page blank.
    el('connect-screen').classList.remove('hidden');
  }
}

el('login-btn').addEventListener('click', login);
el('login-password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
el('logout-btn').addEventListener('click', logout);

boot();
