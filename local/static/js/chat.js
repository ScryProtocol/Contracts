// ─── State ────────────────────────────────────────────────────────────
let currentConvo = ACTIVE_CONVO;
let isStreaming = false;
let activeBackendId = null;
let searchEnabled = false;
let thinkEnabled = false;

const $messages = document.getElementById('chat-messages');
const $input = document.getElementById('chat-input');
const $form = document.getElementById('chat-form');
const $modelSelect = document.getElementById('model-select');
const $personalitySelect = document.getElementById('personality-select');
const $backendSelect = document.getElementById('backend-select');
const $searchInput = document.getElementById('search-input');
const $searchResults = document.getElementById('search-results');
const $btnSend = document.getElementById('btn-send');

// ─── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadBackends().then(() => loadModels());
    scrollToBottom();
    renderMarkdownAll();

    // Sidebar toggle (mobile)
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    // New chat
    document.getElementById('btn-new-chat')?.addEventListener('click', () => {
        window.location.href = '/chat';
    });

    // Personality cards on empty state
    document.querySelectorAll('.personality-card').forEach(card => {
        card.addEventListener('click', () => {
            $personalitySelect.value = card.dataset.personality;
            $input.focus();
        });
    });

    // Search / Think toggles
    document.getElementById('toggle-search')?.addEventListener('click', () => {
        searchEnabled = !searchEnabled;
        document.getElementById('toggle-search').classList.toggle('active', searchEnabled);
    });
    document.getElementById('toggle-think')?.addEventListener('click', () => {
        thinkEnabled = !thinkEnabled;
        document.getElementById('toggle-think').classList.toggle('active', thinkEnabled);
    });

    // Delete conversation buttons
    document.querySelectorAll('.convo-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.dataset.id;
            if (!confirm('Delete this conversation?')) return;
            await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
            if (currentConvo == id) {
                window.location.href = '/chat';
            } else {
                btn.closest('.convo-item').remove();
            }
        });
    });
});

// ─── Load models from Ollama ──────────────────────────────────────────
let cachedModels = [];

async function loadModels() {
    try {
        const params = activeBackendId ? `?backend_id=${activeBackendId}` : '';
        const res = await fetch(`/api/models${params}`);
        const data = await res.json();
        cachedModels = data.models || [];
        currentBackendKind = data.kind || 'ollama';
        if (cachedModels.length > 0) {
            $modelSelect.innerHTML = '';
            cachedModels.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name;
                if (ACTIVE_CONVO === null && m.name === DEFAULT_MODEL) opt.selected = true;
                $modelSelect.appendChild(opt);
            });
        } else if (data.error) {
            $modelSelect.innerHTML = `<option value="">${data.error}</option>`;
        } else {
            $modelSelect.innerHTML = `<option value="">No models found</option>`;
        }
    } catch {
        $modelSelect.innerHTML = `<option value="">Connection error</option>`;
    }
}

let currentBackendKind = 'ollama';

// ─── Backends ─────────────────────────────────────────────────────────
async function loadBackends() {
    try {
        const res = await fetch('/api/backends');
        const data = await res.json();
        const backends = data.backends || [];
        $backendSelect.innerHTML = '';
        backends.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = `${b.name} (${b.kind})`;
            if (b.is_default) { opt.selected = true; activeBackendId = b.id; }
            $backendSelect.appendChild(opt);
        });
        if (!activeBackendId && backends.length) activeBackendId = backends[0].id;
    } catch {
        $backendSelect.innerHTML = '<option value="">Error</option>';
    }
}

$backendSelect?.addEventListener('change', () => {
    activeBackendId = parseInt($backendSelect.value);
    loadModels();
});

// ─── Auto-resize textarea ─────────────────────────────────────────────
$input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
});

// ─── Send message ─────────────────────────────────────────────────────
$form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
});

$input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

async function sendMessage() {
    const text = $input.value.trim();
    if (!text || isStreaming) return;

    const model = $modelSelect.value;
    const personality = $personalitySelect.value;

    if (!model) {
        alert('No model selected. Make sure your backend is running with at least one model available.');
        return;
    }

    // Clear empty state
    const emptyState = $messages.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Add user message to UI
    appendMessage('user', text);
    $input.value = '';
    $input.style.height = 'auto';

    // Start streaming
    isStreaming = true;
    $btnSend.disabled = true;

    const assistantEl = appendMessage('assistant', '', true);
    const contentEl = assistantEl.querySelector('.message-content');

    const $status = document.getElementById('chat-status');

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversation_id: currentConvo,
                message: text,
                model: model,
                personality: personality,
                backend_id: activeBackendId,
                search: searchEnabled,
                think: thinkEnabled,
            }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = JSON.parse(line.slice(6));

                if (data.error) {
                    contentEl.textContent = `Error: ${data.error}`;
                    $status.classList.add('hidden');
                    break;
                }

                // Status updates (searching / reading / generating / imagegen)
                if (data.status) {
                    $status.classList.remove('hidden');
                    if (data.status === 'searching') {
                        $status.innerHTML = '<span class="status-dot"></span> Searching the web...';
                    } else if (data.status === 'reading') {
                        $status.innerHTML = `<span class="status-dot"></span> Reading ${escapeHtml(data.url || '')}...`;
                    } else if (data.status === 'imagegen') {
                        $status.innerHTML = '<span class="status-dot"></span> Crafting image prompt...';
                    } else if (data.status === 'generating_image') {
                        $status.innerHTML = '<span class="status-dot"></span> Generating image...';
                    } else if (data.status === 'image_error') {
                        $status.innerHTML = `<span class="status-dot" style="background:#ef4444"></span> Image gen failed: ${escapeHtml(data.message || '')}`;
                        setTimeout(() => $status.classList.add('hidden'), 5000);
                    } else if (data.status === 'generating') {
                        $status.classList.add('hidden');
                    }
                }

                // Search results - show as cards above the response
                if (data.search_results) {
                    const srDiv = document.createElement('div');
                    srDiv.className = 'search-results-bar';
                    srDiv.innerHTML = `<div class="sr-label">Sources</div><div class="sr-cards">${
                        data.search_results.map(r =>
                            `<a class="sr-card" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">
                                <div class="sr-card-title">${escapeHtml(r.title)}</div>
                                <div class="sr-card-url">${escapeHtml((r.url || '').replace(/^https?:\/\//, '').split('/')[0])}</div>
                            </a>`
                        ).join('')
                    }</div>`;
                    assistantEl.querySelector('.message-body').insertBefore(srDiv, contentEl);
                    scrollToBottom();
                }

                // Inline images from chat image generation
                if (data.images) {
                    const imgContainer = document.createElement('div');
                    imgContainer.className = 'chat-images';
                    data.images.forEach(img => {
                        const imgEl = document.createElement('img');
                        imgEl.src = img.url;
                        imgEl.alt = img.prompt || 'Generated image';
                        imgEl.className = 'chat-inline-image';
                        imgEl.addEventListener('click', () => window.open(img.url, '_blank'));
                        imgContainer.appendChild(imgEl);
                    });
                    assistantEl.querySelector('.message-body').insertBefore(imgContainer, contentEl);
                    $status.classList.add('hidden');
                    scrollToBottom();
                }

                if (data.token) {
                    fullText += data.token;
                    contentEl.textContent = fullText;
                    scrollToBottom();
                }

                if (data.done) {
                    currentConvo = data.conversation_id;
                    history.replaceState(null, '', `/chat/${data.conversation_id}`);
                    updateSidebar(data.conversation_id, data.title);
                    renderMarkdown(contentEl);
                    $status.classList.add('hidden');
                }
            }
        }
    } catch (err) {
        contentEl.textContent = `Error: ${err.message}`;
        $status.classList.add('hidden');
    }

    // Remove typing indicator
    assistantEl.querySelector('.typing-indicator')?.remove();
    isStreaming = false;
    $btnSend.disabled = false;
    $input.focus();
}

// ─── Append message to chat ───────────────────────────────────────────
function appendMessage(role, content, streaming = false) {
    const personality = $personalitySelect.value;
    const personalityData = getPersonalityData(personality);
    const username = document.querySelector('.user-name')?.textContent || 'U';

    const div = document.createElement('div');
    div.className = `message message-${role}`;
    div.innerHTML = `
        <div class="message-inner">
            <div class="message-avatar">${role === 'user' ? username[0].toUpperCase() : personalityData.icon}</div>
            <div class="message-body">
                <div class="message-role">${role === 'user' ? 'You' : personalityData.name}</div>
                <div class="message-content">${escapeHtml(content)}</div>
                ${streaming ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : ''}
            </div>
        </div>
    `;
    $messages.appendChild(div);
    scrollToBottom();
    return div;
}

function getPersonalityData(key) {
    const options = $personalitySelect.options;
    for (let i = 0; i < options.length; i++) {
        if (options[i].value === key) {
            const text = options[i].textContent.trim();
            return { icon: text.split(' ')[0], name: text.split(' ').slice(1).join(' ') };
        }
    }
    return { icon: '🤖', name: 'Assistant' };
}

// ─── Sidebar helpers ──────────────────────────────────────────────────
function updateSidebar(convoId, title) {
    const list = document.getElementById('convo-list');
    let existing = list.querySelector(`[data-id="${convoId}"]`);
    if (existing) {
        existing.querySelector('.convo-title').textContent = title;
        list.prepend(existing);
    } else {
        const a = document.createElement('a');
        a.href = `/chat/${convoId}`;
        a.className = 'convo-item active';
        a.dataset.id = convoId;
        a.innerHTML = `
            <span class="convo-title">${escapeHtml(title)}</span>
            <button class="btn-icon convo-delete" data-id="${convoId}" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;
        a.querySelector('.convo-delete').addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm('Delete this conversation?')) return;
            await fetch(`/api/conversations/${convoId}`, { method: 'DELETE' });
            window.location.href = '/chat';
        });
        list.querySelectorAll('.convo-item').forEach(i => i.classList.remove('active'));
        list.prepend(a);
    }
}

// ─── Search ───────────────────────────────────────────────────────────
let searchTimeout;
$searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = $searchInput.value.trim();
    if (q.length < 2) {
        $searchResults.classList.add('hidden');
        return;
    }
    searchTimeout = setTimeout(() => doSearch(q), 300);
});

$searchInput.addEventListener('blur', () => {
    setTimeout(() => $searchResults.classList.add('hidden'), 200);
});

async function doSearch(q) {
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.results.length === 0) {
            $searchResults.innerHTML = '<div class="search-result-item"><span class="search-result-title">No results found</span></div>';
        } else {
            $searchResults.innerHTML = data.results.map(r => `
                <div class="search-result-item" onclick="window.location.href='/chat/${r.conversation_id}'">
                    <div class="search-result-title">${escapeHtml(r.title)}</div>
                    <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
                    <div class="search-result-date">${r.date}</div>
                </div>
            `).join('');
        }
        $searchResults.classList.remove('hidden');
    } catch { }
}

// ─── Simple Markdown rendering ────────────────────────────────────────
function renderMarkdown(el) {
    let text = el.textContent;
    // Think blocks → collapsible
    text = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, content) => {
        return `<details class="think-block"><summary>Thinking</summary><div class="think-content">${content.trim()}</div></details>`;
    });
    // Code blocks
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strip [IMG: ...] tags (images displayed separately above)
    text = text.replace(/\[IMG:\s*[^\]]+\]/g, '');
    // Images (must be before links)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="chat-inline-image" onclick="window.open(this.src,\'_blank\')" style="cursor:pointer">');
    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    el.innerHTML = text;
}

function renderMarkdownAll() {
    document.querySelectorAll('.message-assistant .message-content').forEach(renderMarkdown);
}

// ─── Utilities ────────────────────────────────────────────────────────
function scrollToBottom() {
    $messages.scrollTop = $messages.scrollHeight;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Model Manager ────────────────────────────────────────────────────
const $modal = document.getElementById('model-modal');
const $modalList = document.getElementById('modal-model-list');
const $pullInput = document.getElementById('pull-input');
const $pullStatus = document.getElementById('pull-status');

document.getElementById('btn-manage-models')?.addEventListener('click', () => {
    $modal.classList.remove('hidden');
    renderModelList();
});

document.getElementById('modal-close')?.addEventListener('click', () => {
    $modal.classList.add('hidden');
});

$modal?.addEventListener('click', (e) => {
    if (e.target === $modal) $modal.classList.add('hidden');
});

function renderModelList() {
    if (cachedModels.length === 0) {
        $modalList.innerHTML = '<div class="model-loading">No models found. Pull one above.</div>';
        return;
    }
    $modalList.innerHTML = cachedModels.map(m => `
        <div class="model-item">
            <div class="model-info">
                <div class="model-name">${escapeHtml(m.name)}</div>
                <div class="model-meta">${m.params ? m.params + ' · ' : ''}${m.size}${m.family ? ' · ' + m.family : ''}</div>
            </div>
            <div class="model-actions">
                <button class="btn-model-delete" data-name="${escapeHtml(m.name)}" title="Delete model">Delete</button>
            </div>
        </div>
    `).join('');

    $modalList.querySelectorAll('.btn-model-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            if (!confirm(`Delete model "${name}"? You'll need to pull it again to use it.`)) return;
            btn.textContent = '...';
            try {
                await fetch(`/api/models/${encodeURIComponent(name)}`, { method: 'DELETE' });
                await loadModels();
                renderModelList();
            } catch {
                btn.textContent = 'Error';
            }
        });
    });
}

document.getElementById('btn-pull')?.addEventListener('click', pullModel);
$pullInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pullModel();
});

async function pullModel() {
    const name = $pullInput.value.trim();
    if (!name) return;

    const $btn = document.getElementById('btn-pull');
    $btn.disabled = true;
    $btn.textContent = 'Pulling...';
    $pullStatus.classList.remove('hidden');
    $pullStatus.innerHTML = `Pulling <strong>${escapeHtml(name)}</strong>...<div class="pull-progress"><div class="pull-progress-bar" id="pull-bar" style="width:0%"></div></div>`;

    try {
        const res = await fetch('/api/models/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const $bar = document.getElementById('pull-bar');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = JSON.parse(line.slice(6));
                if (data.error) {
                    $pullStatus.innerHTML = `<span style="color:#ef4444">Error: ${escapeHtml(data.error)}</span>`;
                    $btn.disabled = false;
                    $btn.textContent = 'Pull';
                    return;
                }
                if (data.status) {
                    const pct = data.percent || 0;
                    $pullStatus.innerHTML = `${escapeHtml(data.status)} ${pct > 0 ? pct + '%' : ''}<div class="pull-progress"><div class="pull-progress-bar" style="width:${pct}%"></div></div>`;
                }
                if (data.done) {
                    $pullStatus.innerHTML = `<span style="color:#10a37f">Successfully pulled <strong>${escapeHtml(name)}</strong></span>`;
                    $pullInput.value = '';
                    await loadModels();
                    renderModelList();
                }
            }
        }
    } catch (err) {
        $pullStatus.innerHTML = `<span style="color:#ef4444">Error: ${escapeHtml(err.message)}</span>`;
    }

    $btn.disabled = false;
    $btn.textContent = 'Pull';
}

// ─── Backend Manager ──────────────────────────────────────────────────
const $backendModal = document.getElementById('backend-modal');
const $backendList = document.getElementById('backend-list');
const $backendEditModal = document.getElementById('backend-edit-modal');

document.getElementById('btn-manage-backends')?.addEventListener('click', () => {
    $backendModal.classList.remove('hidden');
    renderBackendList();
});
document.getElementById('backend-modal-close')?.addEventListener('click', () => {
    $backendModal.classList.add('hidden');
});
$backendModal?.addEventListener('click', (e) => {
    if (e.target === $backendModal) $backendModal.classList.add('hidden');
});

document.getElementById('btn-add-backend')?.addEventListener('click', async () => {
    const kind = document.getElementById('backend-kind').value;
    await fetch('/api/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
    });
    await loadBackends();
    renderBackendList();
});

async function renderBackendList() {
    try {
        const res = await fetch('/api/backends');
        const data = await res.json();
        const backends = data.backends || [];
        if (!backends.length) {
            $backendList.innerHTML = '<div class="model-loading">No backends. Add one above.</div>';
            return;
        }
        $backendList.innerHTML = backends.map(b => `
            <div class="model-item">
                <div class="model-info">
                    <div class="model-name">${escapeHtml(b.name)} ${b.is_default ? '<span style="color:var(--accent); font-size:11px;">DEFAULT</span>' : ''}</div>
                    <div class="model-meta">${b.kind} · ${escapeHtml(b.base_url)}${b.has_key ? ' · key set' : ''}</div>
                </div>
                <div class="model-actions" style="gap:4px;">
                    <button class="btn-model-delete" data-action="edit" data-id="${b.id}" style="color:var(--text-secondary)">Edit</button>
                    <button class="btn-model-delete" data-action="default" data-id="${b.id}" ${b.is_default ? 'disabled style="opacity:.3"' : ''}>Set Default</button>
                    <button class="btn-model-delete" data-action="delete" data-id="${b.id}">Delete</button>
                </div>
            </div>
        `).join('');

        $backendList.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this backend?')) return;
                await fetch(`/api/backends/${btn.dataset.id}`, { method: 'DELETE' });
                await loadBackends();
                loadModels();
                renderBackendList();
            });
        });

        $backendList.querySelectorAll('[data-action="default"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await fetch(`/api/backends/${btn.dataset.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ is_default: true }),
                });
                activeBackendId = parseInt(btn.dataset.id);
                await loadBackends();
                loadModels();
                renderBackendList();
            });
        });

        $backendList.querySelectorAll('[data-action="edit"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const b = backends.find(x => x.id == btn.dataset.id);
                document.getElementById('be-id').value = b.id;
                document.getElementById('be-name').value = b.name;
                document.getElementById('be-url').value = b.base_url;
                document.getElementById('be-key').value = '';
                document.getElementById('be-status').classList.add('hidden');
                $backendEditModal.classList.remove('hidden');
            });
        });
    } catch {}
}

document.getElementById('be-close')?.addEventListener('click', () => {
    $backendEditModal.classList.add('hidden');
});
$backendEditModal?.addEventListener('click', (e) => {
    if (e.target === $backendEditModal) $backendEditModal.classList.add('hidden');
});

document.getElementById('be-save')?.addEventListener('click', async () => {
    const id = document.getElementById('be-id').value;
    const body = {
        name: document.getElementById('be-name').value,
        base_url: document.getElementById('be-url').value,
    };
    const key = document.getElementById('be-key').value;
    if (key) body.api_key = key;
    await fetch(`/api/backends/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    $backendEditModal.classList.add('hidden');
    await loadBackends();
    loadModels();
    renderBackendList();
});

document.getElementById('be-test')?.addEventListener('click', async () => {
    const id = document.getElementById('be-id').value;
    const $status = document.getElementById('be-status');
    $status.classList.remove('hidden');
    $status.textContent = 'Testing...';
    $status.style.color = 'var(--text-secondary)';
    try {
        const res = await fetch(`/api/backends/${id}/test`);
        const data = await res.json();
        if (data.ok) {
            $status.textContent = 'Connected!';
            $status.style.color = 'var(--accent)';
        } else {
            $status.textContent = 'Failed: ' + data.error;
            $status.style.color = '#ef4444';
        }
    } catch (e) {
        $status.textContent = 'Error: ' + e.message;
        $status.style.color = '#ef4444';
    }
});
