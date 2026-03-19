/**
 * Ameen Chat — Real-time messaging with Socket.io
 */

let currentToken = localStorage.getItem('ameen_token');
const REFRESH_TOKEN = localStorage.getItem('ameen_refresh_token');
const ME = JSON.parse(localStorage.getItem('ameen_user') || 'null');

// Guard: redirect if not logged in
if (!currentToken || !ME) window.location.href = '/';

const TOKEN = currentToken; // alias for Socket.io auth (set once on connect)
const API = '';
let socket;
let activeConvId = null;
let typingTimer = null;
let conversations = {};
let unreadCounts = {};
let cryptoKeys = null; // { publicKey, privateKey }

// ── Auto Token Refresh ────────────────────────────────────────────
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) return;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: REFRESH_TOKEN })
    });
    if (res.ok) {
      const { token } = await res.json();
      currentToken = token;
      localStorage.setItem('ameen_token', token);
    } else {
      // Refresh token invalid — logout
      logout();
    }
  } catch {}
}
// Refresh every 12 minutes (access token expires in 15m)
setInterval(refreshAccessToken, 12 * 60 * 1000);


// ── Initialization ────────────────────────────────────────────
async function init() {
  // Setup UI with user info
  document.getElementById('my-name').textContent = ME.displayName;
  document.getElementById('my-avatar').src = ME.avatar;

  // Generate crypto keys
  try {
    cryptoKeys = await AmeenCrypto.generateKeyPair();
  } catch (e) {
    console.warn('Crypto unavailable, using plain mode');
  }

  // Connect socket
  socket = io({ auth: { token: TOKEN } });
  setupSocketListeners();

  // Load conversations
  loadConversations();

  // Register service worker & enable push
  registerPush();
}

// ── Push Notifications ────────────────────────────────────────
async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    // Get VAPID public key
    const res = await fetch('/api/push/vapid-public-key');
    const { key } = await res.json();

    // Check existing subscription
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
    }

    // Send subscription to server
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify(sub)
    });
    console.log('🔔 Push notifications enabled');
  } catch (e) {
    console.warn('Push registration failed:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Socket Listeners ──────────────────────────────────────────
function setupSocketListeners() {
  socket.on('connect', () => console.log('Connected to Ameen server'));
  socket.on('connect_error', (err) => {
    if (err.message === 'Auth failed') { logout(); }
  });

  socket.on('message:new', (msg) => {
    if (msg.convId === activeConvId) {
      appendMessage(msg);
      scrollToBottom();
      socket.emit('message:read', { convId: msg.convId, messageId: msg.id });
    } else {
      // Increment unread
      unreadCounts[msg.convId] = (unreadCounts[msg.convId] || 0) + 1;
      updateConvItem(msg.convId, msg);
      showToast(`رسالة جديدة من ${msg.senderName}`);
    }
    // Update sidebar
    updateConvLastMessage(msg.convId, msg);
  });

  socket.on('user:online', ({ userId }) => {
    updateUserOnlineStatus(userId, true);
  });

  socket.on('user:offline', ({ userId }) => {
    updateUserOnlineStatus(userId, false);
  });

  socket.on('user:typing', ({ userId, convId }) => {
    if (convId === activeConvId && userId !== ME.id) {
      showTyping();
    }
  });

  socket.on('message:read', ({ convId }) => {
    if (convId === activeConvId) {
      document.querySelectorAll('.msg-status').forEach(el => {
        el.textContent = '✓✓';
        el.style.color = '#00D4AA';
      });
    }
  });

  socket.on('conversation:ready', ({ convId, otherUser }) => {
    openConversation(convId, otherUser);
    loadConversations();
  });

  socket.on('conversation:new', () => {
    loadConversations();
  });

  // ── WebRTC Call Events ──
  socket.on('call:incoming', (data) => {
    AmeenCall.handleIncomingCall(data);
  });

  socket.on('call:answered', ({ answer }) => {
    AmeenCall.handleAnswer(answer);
  });

  socket.on('call:ice-candidate', ({ candidate }) => {
    AmeenCall.handleIceCandidate(candidate);
  });

  socket.on('call:rejected', () => {
    AmeenCall.endCall(false);
    showToast('❌ تم رفض المكالمة');
  });

  socket.on('call:ended', () => {
    AmeenCall.endCall(false);
    showToast('📞 انتهت المكالمة');
  });

  socket.on('call:error', ({ message }) => {
    showToast('❌ ' + message);
  });
}

// ── Conversations ─────────────────────────────────────────────
async function loadConversations() {
  try {
    const res = await apiGet('/api/conversations');
    const list = await res.json();
    conversations = {};
    list.forEach(c => { conversations[c.id] = c; });
    renderConvList(list);
  } catch (e) {
    console.error(e);
  }
}

function renderConvList(list) {
  const container = document.getElementById('conv-list');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">لا توجد محادثات بعد<br/>ابحث عن مستخدم للبدء</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(conv => {
    const el = document.createElement('div');
    el.className = `conv-item${conv.id === activeConvId ? ' active' : ''}`;
    el.id = `conv-${conv.id}`;

    let lastText = 'ابدأ المحادثة';
    if (conv.lastMessage) {
      const t = conv.lastMessage.type;
      lastText = t === 'image' ? '📷 صورة'
        : t === 'file' ? '📎 ملف'
        : conv.lastMessage.content.substring(0, 40);
    }
    const time = conv.lastMessage ? formatTime(conv.lastMessage.timestamp) : '';
    const unread = unreadCounts[conv.id];

    if (conv.type === 'direct') {
      const other = conv.otherUser;
      if (!other) return;
      el.onclick = () => openConversation(conv.id, { ...other, isOnline: conv.isOnline });
      el.innerHTML = `
        <div class="avatar-wrap">
          <img class="avatar ${conv.isOnline ? 'online' : ''}" src="${other.avatar}" alt="${other.displayName}" />
          ${conv.isOnline ? '<div class="online-dot"></div>' : ''}
        </div>
        <div class="conv-info">
          <div class="conv-name">${escHtml(other.displayName)}</div>
          <div class="conv-last">${escHtml(lastText)}</div>
        </div>
        <div class="conv-meta">
          <div class="conv-time">${time}</div>
          ${unread ? `<div class="unread-badge">${unread}</div>` : ''}
        </div>
      `;
    } else {
      const badge = conv.type === 'channel' ? '📢' : '👥';
      const badgeLabel = conv.type === 'channel' ? 'قناة' : 'مجموعة';
      const badgeCls = conv.type === 'channel' ? 'channel-badge' : 'group-badge';
      const avatarSrc = conv.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(conv.name || 'G')}&backgroundColor=6c63ff`;
      const memberCount = conv.memberCount || conv.members?.length || 0;
      el.onclick = () => openGroupConversation(conv);
      el.innerHTML = `
        <div class="avatar-wrap">
          <img class="avatar" src="${avatarSrc}" alt="${conv.name}" />
        </div>
        <div class="conv-info">
          <div class="conv-name">${badge} ${escHtml(conv.name)} <span class="${badgeCls}">${badgeLabel}</span></div>
          <div class="conv-last">${escHtml(lastText)}</div>
        </div>
        <div class="conv-meta">
          <div class="conv-time">${time}</div>
          <div style="font-size:0.7rem;color:var(--text-muted)">${memberCount} 👤</div>
          ${unread ? `<div class="unread-badge">${unread}</div>` : ''}
        </div>
      `;
    }
    container.appendChild(el);
  });
}


function updateConvLastMessage(convId, msg) {
  const el = document.getElementById(`conv-${convId}`);
  if (el) {
    const lastEl = el.querySelector('.conv-last');
    const timeEl = el.querySelector('.conv-time');
    if (lastEl) lastEl.textContent = msg.content.substring(0, 40);
    if (timeEl) timeEl.textContent = formatTime(msg.timestamp);
    const unread = unreadCounts[convId];
    let badge = el.querySelector('.unread-badge');
    if (unread) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'unread-badge';
        el.querySelector('.conv-meta').appendChild(badge);
      }
      badge.textContent = unread;
    }
    // Move to top
    el.parentElement.prepend(el);
  } else {
    loadConversations();
  }
}

function updateConvItem(convId, msg) {
  updateConvLastMessage(convId, msg);
}

// ── Search ────────────────────────────────────────────────────
function toggleSearch() {
  const area = document.getElementById('search-area');
  area.classList.toggle('hidden');
  if (!area.classList.contains('hidden')) {
    document.getElementById('search-input').focus();
  } else {
    document.getElementById('search-results').innerHTML = '';
  }
}

async function searchUsers(q) {
  if (!q.trim()) { document.getElementById('search-results').innerHTML = ''; return; }
  try {
    const res = await apiGet(`/api/users/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    users.forEach(user => {
      const el = document.createElement('div');
      el.className = 'search-result-item';
      el.innerHTML = `
        <img class="avatar" src="${user.avatar}" alt="${user.displayName}" style="width:34px;height:34px" />
        <div>
          <div class="name">${escHtml(user.displayName)}</div>
          <div class="username">@${escHtml(user.username)}</div>
        </div>
      `;
      el.onclick = () => {
        startChatWithUser(user);
        toggleSearch();
      };
      container.appendChild(el);
    });
    if (users.length === 0) container.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.82rem;text-align:center">لا نتائج</div>';
  } catch (e) { console.error(e); }
}

function startChatWithUser(otherUser) {
  socket.emit('conversation:join', { targetUserId: otherUser.id });
}

// ── Open Conversation ─────────────────────────────────────────
async function openConversation(convId, otherUser) {
  activeConvId = convId;
  unreadCounts[convId] = 0;

  // Update sidebar active state
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  const convEl = document.getElementById(`conv-${convId}`);
  if (convEl) { convEl.classList.add('active'); const badge = convEl.querySelector('.unread-badge'); if(badge) badge.remove(); }

  // Update header
  document.getElementById('chat-avatar').src = otherUser.avatar;
  document.getElementById('chat-name').textContent = otherUser.displayName;
  document.getElementById('chat-status').textContent = otherUser.isOnline ? '● متصل الآن' : 'غير متصل';

  // Show chat UI
  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('messages-area').classList.remove('hidden');
  document.getElementById('message-input-area').classList.remove('hidden');

  // Mobile: hide sidebar
  if (window.innerWidth <= 700) {
    document.getElementById('sidebar').classList.add('slide-out');
  }

  // Load messages
  await loadMessages(convId);
  document.getElementById('msg-input').focus();
}

async function loadMessages(convId) {
  const list = document.getElementById('messages-list');
  list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:20px">تحميل...</div>';
  try {
    const res = await apiGet(`/api/conversations/${convId}/messages`);
    const msgs = await res.json();
    list.innerHTML = '';
    if (msgs.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:0.82rem;padding:20px">🔐 المحادثة مشفرة — ابدأ بالكتابة</div>';
      return;
    }
    let lastDate = null;
    msgs.forEach(msg => {
      const msgDate = new Date(msg.timestamp).toLocaleDateString('ar');
      if (msgDate !== lastDate) {
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.textContent = msgDate;
        list.appendChild(div);
        lastDate = msgDate;
      }
      appendMessage(msg, false);
    });
    scrollToBottom(false);
  } catch (e) {
    list.innerHTML = '<div style="text-align:center;color:var(--error);padding:20px">خطأ في تحميل الرسائل</div>';
  }
}

function appendMessage(msg, animate = true) {
  const list = document.getElementById('messages-list');
  const empty = list.querySelector('div[style*="text-align:center"]');
  if (empty) empty.remove();

  const isOut = msg.senderId === ME.id;
  const group = document.createElement('div');
  group.className = `msg-group ${isOut ? 'out' : 'in'}`;
  group.style.animation = animate ? '' : 'none';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Render based on message type
  if (msg.type === 'image') {
    bubble.classList.add('msg-bubble-image');
    bubble.innerHTML = `
      <img src="${msg.content}" alt="صورة" class="chat-image" onclick="viewImage(this.src)" loading="lazy" />
    `;
  } else if (msg.type === 'file') {
    // Parse JSON file data stored in content
    let fileData = {};
    try { fileData = JSON.parse(msg.content); } catch { fileData = { url: msg.content, name: 'ملف' }; }
    const icon = getFileIcon(fileData.name || '');
    const size = fileData.size ? formatFileSize(fileData.size) : '';
    bubble.classList.add('msg-bubble-file');
    bubble.innerHTML = `
      <a href="${fileData.url}" target="_blank" download class="file-card">
        <div class="file-icon">${icon}</div>
        <div class="file-info">
          <div class="file-name">${escHtml(fileData.name || 'ملف')}</div>
          <div class="file-size">${size}</div>
        </div>
        <div class="file-dl">⬇️</div>
      </a>
    `;
  } else {
    bubble.textContent = msg.content;
  }

  // Sender name for groups
  if (msg.senderName && !isOut) {
    const name = document.createElement('div');
    name.className = 'msg-sender-name';
    name.textContent = msg.senderName;
    group.appendChild(name);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `
    <span class="msg-time">${formatTime(msg.timestamp)}</span>
    ${isOut ? '<span class="msg-status">✓</span>' : ''}
    <span class="e2e-badge">🔐</span>
  `;

  group.appendChild(bubble);
  group.appendChild(meta);
  list.appendChild(group);
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { pdf: '📄', mp4: '🎬', mp3: '🎵', zip: '🗜️', doc: '📝', docx: '📝', txt: '📋' };
  return icons[ext] || '📎';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function viewImage(src) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  overlay.innerHTML = `<img src="${src}" style="max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.8)" />`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// ── Sending ───────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !activeConvId) return;
  input.value = '';
  input.style.height = 'auto';

  socket.emit('message:send', {
    convId: activeConvId,
    content,
    type: 'text'
  });
}

function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Auto-resize textarea
  const ta = e.target;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function handleTyping() {
  if (!activeConvId) return;
  socket.emit('message:typing', { convId: activeConvId });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {}, 2000);
  // Resize textarea
  const ta = document.getElementById('msg-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ── File Attachment ───────────────────────────────────────────
function attachFile() {
  if (!activeConvId) return showToast('📎 افتح محادثة أولاً');
  document.getElementById('file-input').click();
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file || !activeConvId) return;
  event.target.value = '';

  const isImage = file.type.startsWith('image/');
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) return showToast('❌ الملف أكبر من 10MB');

  showToast('⏫ جارٍ رفع الملف...');

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}` },
      body: formData
    });

    if (!res.ok) throw new Error('فشل الرفع');
    const data = await res.json();

    // Send as message via socket
    socket.emit('message:send', {
      convId: activeConvId,
      content: isImage ? data.url : JSON.stringify({ url: data.url, name: data.name, size: data.size }),
      type: isImage ? 'image' : 'file'
    });

    showToast(`✅ تم إرسال: ${file.name}`);
  } catch (e) {
    showToast('❌ فشل رفع الملف');
  }
}

// ── Typing Indicator ──────────────────────────────────────────
let typingTimeout = null;
function showTyping() {
  const el = document.getElementById('typing-indicator');
  el.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Online Status ─────────────────────────────────────────────
function updateUserOnlineStatus(userId, isOnline) {
  // Update status in chat header if active
  const activeConv = Object.values(conversations).find(c =>
    c.type === 'direct' && c.members && c.members.includes(userId) && c.members.includes(ME.id)
  );
  if (activeConv && activeConv.id === activeConvId) {
    document.getElementById('chat-status').textContent = isOnline ? '● متصل الآن' : 'غير متصل';
  }
  // Update sidebar avatar
  document.querySelectorAll('.conv-item').forEach(el => {
    const convId = el.id.replace('conv-', '');
    const conv = conversations[convId];
    if (conv && conv.otherUser?.id === userId) {
      const avatar = el.querySelector('.avatar');
      const dot = el.querySelector('.online-dot');
      if (isOnline) {
        avatar?.classList.add('online');
        if (!dot) {
          const d = document.createElement('div');
          d.className = 'online-dot';
          el.querySelector('.avatar-wrap')?.appendChild(d);
        }
      } else {
        avatar?.classList.remove('online');
        dot?.remove();
      }
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────
function closeChat() {
  document.getElementById('sidebar').classList.remove('slide-out');
  activeConvId = null;
  document.getElementById('welcome-screen').classList.remove('hidden');
  document.getElementById('chat-header').classList.add('hidden');
  document.getElementById('messages-area').classList.add('hidden');
  document.getElementById('message-input-area').classList.add('hidden');
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
}

function scrollToBottom(smooth = true) {
  const area = document.getElementById('messages-area');
  area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ── Groups ─────────────────────────────────────────────────────
let selectedGroupType = 'group';
const selectedGroupMembers = new Map(); // id -> user object

function openGroupModal() {
  document.getElementById('group-modal').classList.remove('hidden');
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-member-search').value = '';
  document.getElementById('group-member-results').innerHTML = '';
  selectedGroupMembers.clear();
  renderSelectedMembers();
  setGroupType('group');
}

function closeGroupModal() {
  document.getElementById('group-modal').classList.add('hidden');
}

function closeGroupModalOutside(e) {
  if (e.target.id === 'group-modal') closeGroupModal();
}

function setGroupType(type) {
  selectedGroupType = type;
  document.getElementById('tab-group').classList.toggle('active', type === 'group');
  document.getElementById('tab-channel').classList.toggle('active', type === 'channel');
  document.getElementById('modal-type-hint').textContent =
    type === 'group'
      ? 'في المجموعة يمكن للجميع الإرسال'
      : 'في القناة فقط المسؤول يرسل، الأعضاء يشاهدون فقط';
}

async function searchGroupMembers(q) {
  if (!q.trim()) { document.getElementById('group-member-results').innerHTML = ''; return; }
  try {
    const res = await apiGet(`/api/users/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const container = document.getElementById('group-member-results');
    container.innerHTML = '';
    users.forEach(user => {
      if (selectedGroupMembers.has(user.id)) return;
      const el = document.createElement('div');
      el.className = 'group-member-result-item';
      el.innerHTML = `
        <img class="avatar" src="${user.avatar}" alt="" style="width:32px;height:32px" />
        <div>
          <div style="font-size:0.88rem;font-weight:600">${escHtml(user.displayName)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">@${escHtml(user.username)}</div>
        </div>
      `;
      el.onclick = () => { selectGroupMember(user); document.getElementById('group-member-search').value = ''; container.innerHTML = ''; };
      container.appendChild(el);
    });
  } catch (e) {}
}

function selectGroupMember(user) {
  selectedGroupMembers.set(user.id, user);
  renderSelectedMembers();
}

function removeGroupMember(userId) {
  selectedGroupMembers.delete(userId);
  renderSelectedMembers();
}

function renderSelectedMembers() {
  const container = document.getElementById('selected-members');
  container.innerHTML = '';
  selectedGroupMembers.forEach((user, id) => {
    const chip = document.createElement('div');
    chip.className = 'member-chip';
    chip.innerHTML = `<span>${escHtml(user.displayName)}</span><button onclick="removeGroupMember('${id}')">×</button>`;
    container.appendChild(chip);
  });
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) return showToast('❌ أدخل اسم المجموعة');

  const btn = document.querySelector('.create-group-btn');
  btn.textContent = 'جارٍ الإنشاء...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({
        name,
        type: selectedGroupType,
        memberIds: [...selectedGroupMembers.keys()]
      })
    });
    const group = await res.json();
    closeGroupModal();
    await loadConversations();
    openGroupConversation(group);
    showToast(`✅ تم إنشاء ${selectedGroupType === 'group' ? 'المجموعة' : 'القناة'}: ${name}`);
  } catch (e) {
    showToast('❌ فشل الإنشاء، حاول مرة أخرى');
  } finally {
    btn.textContent = 'إنشاء'; btn.disabled = false;
  }
}

function openGroupConversation(group) {
  activeConvId = group.id;
  const badge = group.type === 'channel' ? '📢' : '👥';
  const avatarSrc = group.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(group.name || 'G')}&backgroundColor=6c63ff`;

  document.getElementById('chat-avatar').src = avatarSrc;
  document.getElementById('chat-name').textContent = `${badge} ${group.name}`;
  document.getElementById('chat-status').textContent = `${group.memberCount || group.members?.length || 0} أعضاء`;

  // Hide call buttons for groups
  document.getElementById('audio-call-btn').style.display = 'none';
  document.getElementById('video-call-btn').style.display = 'none';

  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('messages-area').classList.remove('hidden');
  document.getElementById('message-input-area').classList.remove('hidden');

  loadMessages(group.id);
}

// ── Calls ─────────────────────────────────────────────────────
function initiateCall(callType) {
  if (!activeConvId) return;
  // Find the other user in the active conversation
  const conv = Object.values(conversations).find(c => c.id === activeConvId);
  if (!conv || !conv.otherUser) return showToast('لا يمكن بدء المكالمة');
  const { id, displayName, avatar } = conv.otherUser;
  // Let the server decide if user is online — it sends call:error if not
  AmeenCall.startCall(id, displayName, avatar, callType);
}

function logout() {
  localStorage.removeItem('ameen_token');
  localStorage.removeItem('ameen_user');
  window.location.href = '/';
}

async function apiGet(url) {
  return fetch(API + url, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
}

// Start
init();
