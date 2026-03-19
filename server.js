const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const webpush = require('web-push');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

// ── Security Logging ────────────────────────────────────────────
const LOG_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'security.log')
  : path.join(__dirname, 'security.log');

function secLog(event, data) {
  const entry = `[${new Date().toISOString()}] ${event} ${JSON.stringify(data)}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  if (process.env.NODE_ENV !== 'production') console.log('[SEC]', event, data);
}

// ── File Upload Config ────────────────────────────────────────────
const UPLOADS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'uploads')
  : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

// File MIME type magic bytes validation
const ALLOWED_MAGIC = [
  { mime: 'image/jpeg',   bytes: [0xFF,0xD8,0xFF] },
  { mime: 'image/png',    bytes: [0x89,0x50,0x4E,0x47] },
  { mime: 'image/gif',    bytes: [0x47,0x49,0x46] },
  { mime: 'image/webp',   bytes: [0x52,0x49,0x46,0x46] },
  { mime: 'application/pdf', bytes: [0x25,0x50,0x44,0x46] },
];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /^(image\/(jpeg|jpg|png|gif|webp)|application\/pdf|audio\/mpeg|video\/mp4|application\/(zip|msword|vnd\.openxmlformats|octet-stream)|text\/plain)$/;
    const extOk = /^\.(jpg|jpeg|png|gif|webp|pdf|mp3|mp4|zip|doc|docx|txt)$/i.test(path.extname(file.originalname));
    if (!extOk) return cb(new Error('نوع الملف غير مدعوم'), false);
    cb(null, true);
  }
});

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'ameen_secure_secret_2024_!@#';
const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// Online users: userId -> socketId
const onlineUsers = new Map();

// ── Security Middleware ─────────────────────────────────────────
// Helmet — HTTP security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdn.socket.io'],
      scriptSrcAttr: ["'unsafe-inline'"],   // Allow onclick, onsubmit, etc.
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:        ["'self'", 'data:', 'https://api.dicebear.com'],
      connectSrc:    ["'self'", 'wss:', 'ws:'],
      mediaSrc:      ["'self'", 'blob:'],
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── Rate Limiters ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 5,                    // 5 attempts per minute
  message: { error: 'محاولات كثيرة جداً. انتظر دقيقة.' },
  handler: (req, res, next, options) => {
    secLog('RATE_LIMIT_AUTH', { ip: req.ip, path: req.path });
    res.status(429).json(options.message);
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'تجاوزت حد رفع الملفات. انتظر.' },
  handler: (req, res, next, options) => {
    secLog('RATE_LIMIT_UPLOAD', { ip: req.ip, userId: req.userId });
    res.status(429).json(options.message);
  }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'طلبات كثيرة. انتظر لحظة.' }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

// ── Input Validation Helpers ─────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const PASSWORD_MIN = 8;
const MSG_MAX = 4000;

function sanitizeText(s) {
  return String(s).replace(/[<>]/g, '');
}

// ── Auth Routes ──────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

  if (!USERNAME_RE.test(username))
    return res.status(400).json({ error: 'اسم المستخدم 3-30 حرفاً (أحرف وأرقام و_)' });
  if (password.length < PASSWORD_MIN)
    return res.status(400).json({ error: `كلمة المرور ${PASSWORD_MIN} أحرف على الأقل` });

  const cleanDisplay = sanitizeText(displayName).substring(0, 50).trim();
  if (!cleanDisplay) return res.status(400).json({ error: 'اسم العرض غير صالح' });

  if (db.getUserByUsername(username.toLowerCase()))
    return res.status(409).json({ error: 'اسم المستخدم محجوز' });

  const hashedPw = await bcrypt.hash(password, 12);
  const userId = uuidv4();
  const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(cleanDisplay)}&backgroundColor=1a1a2e`;

  const user = db.createUser({ id: userId, username: username.toLowerCase(), displayName: cleanDisplay, avatar, hashedPw, status: 'متاح' });
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  secLog('REGISTER', { userId, username: username.toLowerCase(), ip: req.ip });
  res.json({ token, user: db.safeUser(user) });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });

  const user = db.getUserByUsername(username.toLowerCase());
  if (!user) {
    secLog('LOGIN_FAIL', { username, ip: req.ip });
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const valid = await bcrypt.compare(password, user.hashedPw);
  if (!valid) {
    secLog('LOGIN_FAIL', { username, ip: req.ip });
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '15m' });

  // Issue refresh token
  const refreshToken = require('crypto').randomBytes(40).toString('hex');
  const refreshHash  = require('crypto').createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  db.saveRefreshToken(user.id, refreshHash, refreshExpiry);

  secLog('LOGIN_OK', { userId: user.id, ip: req.ip });
  res.json({ token, refreshToken, user: { ...db.safeUser(user), isOnline: true } });
});

// ── Refresh Token Route ───────────────────────────────────────────
app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refresh token مفقود' });

  const hash = require('crypto').createHash('sha256').update(refreshToken).digest('hex');
  const record = db.getRefreshToken(hash);
  if (!record) return res.status(401).json({ error: 'جلسة منتهية أو ملغاة' });

  const user = db.getUserById(record.user_id);
  if (!user) return res.status(401).json({ error: 'مستخدم غير موجود' });

  const newToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '15m' });
  res.json({ token: newToken });
});

// ── Logout All Devices ────────────────────────────────────────────
app.post('/api/auth/logout-all', authMiddleware, (req, res) => {
  db.revokeAllUserTokens(req.userId);
  secLog('LOGOUT_ALL', { userId: req.userId, ip: req.ip });
  res.json({ ok: true });
});

// ── 2FA Setup ────────────────────────────────────────────────────
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');

app.post('/api/auth/2fa/setup', authMiddleware, async (req, res) => {
  const user = db.getUserById(req.userId);
  const secret = speakeasy.generateSecret({ name: `آمين ماسنجر (${user.username})`, length: 20 });
  db.setTotpSecret(req.userId, secret.base32);
  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
  res.json({ secret: secret.base32, qr: qrDataUrl });
});

app.post('/api/auth/2fa/enable', authMiddleware, (req, res) => {
  const { code } = req.body;
  const user = db.getUserById(req.userId);
  if (!user?.totpSecret) return res.status(400).json({ error: 'ابدأ الإعداد أولاً' });

  const valid = speakeasy.totp.verify({ secret: user.totpSecret, encoding: 'base32', token: code, window: 1 });
  if (!valid) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });

  db.enableTotp(req.userId);
  secLog('2FA_ENABLED', { userId: req.userId });
  res.json({ ok: true });
});

app.post('/api/auth/2fa/disable', authMiddleware, (req, res) => {
  const { code } = req.body;
  const user = db.getUserById(req.userId);
  if (!user?.totpEnabled) return res.status(400).json({ error: '2FA غير مفعّل' });

  const valid = speakeasy.totp.verify({ secret: user.totpSecret, encoding: 'base32', token: code, window: 1 });
  if (!valid) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });

  db.disableTotp(req.userId);
  secLog('2FA_DISABLED', { userId: req.userId });
  res.json({ ok: true });
});

// Cleanup expired refresh tokens every 6 hours
setInterval(() => db.cleanExpiredTokens(), 6 * 60 * 60 * 1000);

app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const results = db.searchUsers(q, req.userId).map(u => ({
    ...db.safeUser(u),
    isOnline: onlineUsers.has(u.id)
  }));
  res.json(results);
});

app.get('/api/conversations', authMiddleware, (req, res) => {
  const convs = db.getUserConversations(req.userId).map(c => ({
    ...c,
    isOnline: c.otherUser ? onlineUsers.has(c.otherUser.id) : false
  }));
  convs.sort((a, b) => (b.lastMessage?.timestamp || b.createdAt) - (a.lastMessage?.timestamp || a.createdAt));
  res.json(convs);
});

app.post('/api/conversations', authMiddleware, (req, res) => {
  const { targetUserId } = req.body;
  const existing = db.findDirectConv(req.userId, targetUserId);
  if (existing) return res.json({ convId: existing, existing: true });

  const convId = uuidv4();
  db.createConversation({ id: convId, type: 'direct', members: [req.userId, targetUserId] });
  res.json({ convId, existing: false });
});

// ── Group & Channel Routes ──────────────────────────────────────
app.post('/api/groups', authMiddleware, (req, res) => {
  const { name, type = 'group', memberIds = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'اسم المجموعة مطلوب' });

  const convId = uuidv4();
  const members = [req.userId, ...memberIds.filter(id => id !== req.userId)];
  const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=6c63ff`;

  db.createConversation({ id: convId, type, name: name.trim(), members, adminId: req.userId, avatar });

  // Notify all online members via socket
  members.forEach(uid => {
    const sid = onlineUsers.get(uid);
    if (sid && uid !== req.userId) {
      io.to(sid).emit('conversation:new', { convId });
    }
  });

  const conv = db.getGroupInfo(convId, req.userId);
  res.json(conv);
});

app.get('/api/groups/:convId', authMiddleware, (req, res) => {
  if (!db.isConvMember(req.params.convId, req.userId))
    return res.status(403).json({ error: 'غير مصرح' });
  res.json(db.getGroupInfo(req.params.convId, req.userId));
});

app.post('/api/groups/:convId/members', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!db.isConvMember(req.params.convId, req.userId))
    return res.status(403).json({ error: 'غير مصرح' });
  db.addConvMember(req.params.convId, userId);
  // Notify new member
  const sid = onlineUsers.get(userId);
  if (sid) io.to(sid).emit('conversation:new', { convId: req.params.convId });
  res.json({ ok: true });
});

app.delete('/api/groups/:convId/members/me', authMiddleware, (req, res) => {
  db.removeConvMember(req.params.convId, req.userId);
  res.json({ ok: true });
});

app.get('/api/conversations/:convId/messages', authMiddleware, (req, res) => {
  if (!db.isConvMember(req.params.convId, req.userId))
    return res.status(403).json({ error: 'غير مصرح' });
  res.json(db.getMessages(req.params.convId));
});

// ── File Upload Route ─────────────────────────────────────────────
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
  const isVolume = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const urlPath = isVolume
    ? `/api/files/${req.file.filename}`
    : `/uploads/${req.file.filename}`;
  res.json({
    url: urlPath,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype
  });
});

// Serve uploaded files from Railway volume if needed
app.get('/api/files/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Serve uploads from public when running locally
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ── Web Push / Push Notifications ────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BBDxpN94WcxUIR8RyFlgBUKMjMdvHDbibG7V7-AwLRAGJRG58CBDkR_nJeUkFsNELRs-0htGItr7gWYxac03Oxo';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'Ap-CspK1scGRA61X7FerQvDDyoVVLFCeu-UDHUFBNcM';

webpush.setVapidDetails('mailto:ameen@messenger.app', VAPID_PUBLIC, VAPID_PRIVATE);

// userId -> Set of push subscriptions
const pushSubs = new Map();

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const subs = pushSubs.get(req.userId) || new Set();
  subs.add(JSON.stringify(sub));
  pushSubs.set(req.userId, subs);
  res.json({ ok: true });
});

app.delete('/api/push/unsubscribe', authMiddleware, (req, res) => {
  pushSubs.delete(req.userId);
  res.json({ ok: true });
});

async function sendPushToUser(userId, payload) {
  const subs = pushSubs.get(userId);
  if (!subs || subs.size === 0) return;
  for (const subStr of subs) {
    try {
      await webpush.sendNotification(JSON.parse(subStr), JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) subs.delete(subStr);
    }
  }
}

// ── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()) + 's',
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    onlineUsers: onlineUsers.size,
    timestamp: new Date().toISOString()
  });
});

// ── Account Deletion (GDPR) ───────────────────────────────────────
app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body;
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });

  const valid = await bcrypt.compare(password || '', user.hashedPw);
  if (!valid) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });

  db.revokeAllUserTokens(req.userId);
  db.deleteUserAccount(req.userId);
  secLog('ACCOUNT_DELETED', { userId: req.userId, ip: req.ip });

  const sid = onlineUsers.get(req.userId);
  if (sid) io.to(sid).emit('force:logout', { reason: 'account_deleted' });
  onlineUsers.delete(req.userId);

  res.json({ ok: true, message: 'تم حذف حسابك نهائياً' });
});

// ── Automated Backup (every 6 hours) ─────────────────────────────
const DB_PATH = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'ameen.db');
const BACKUP_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'backups')
  : path.join(__dirname, 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function runBackup() {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BACKUP_DIR, `ameen-${date}.db`);
  fs.copyFile(DB_PATH, dest, (err) => {
    if (err) { secLog('BACKUP_FAIL', { error: err.message }); return; }
    secLog('BACKUP_OK', { file: `ameen-${date}.db` });
    // Keep only last 12 backups (3 days)
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
      files.slice(12).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} });
    } catch {}
  });
}

setInterval(runBackup, 6 * 60 * 60 * 1000);
setTimeout(runBackup, 10000); // First backup 10s after startup

// ── Socket.io ────────────────────────────────────────────────────
io.use((socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch {
    next(new Error('Auth failed'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  onlineUsers.set(userId, socket.id);
  io.emit('user:online', { userId });

  // Join all user's conversation rooms
  const convs = db.getUserConversations(userId);
  convs.forEach(c => socket.join(c.id));

  // ── Send Message ──
  socket.on('message:send', ({ convId, content, type = 'text', encryptedKey }) => {
    if (!db.isConvMember(convId, userId)) return;

    // Validate message content
    if (typeof content !== 'string' || !content.trim()) return;
    if (type === 'text' && content.length > MSG_MAX) return;
    const safeContent = type === 'text' ? sanitizeText(content).trim() : content;

    const members = db.getConversationMembers(convId);
    const anyRecipientOnline = members.some(m => m !== userId && onlineUsers.has(m));

    const msg = {
      id: uuidv4(),
      convId,
      senderId: userId,
      senderName: db.getUserById(userId)?.displayName,
      content: safeContent,
      type,
      encryptedKey: encryptedKey || null,
      status: anyRecipientOnline ? 'delivered' : 'sent',
      timestamp: Date.now()
    };

    db.insertMessage(msg);
    io.to(convId).emit('message:new', msg);

    // Send push to offline members
    const sender = db.getUserById(userId);
    const senderName = sender?.displayName || 'رسالة جديدة';
    const preview = type === 'image' ? '📷 صورة'
      : type === 'file' ? '📎 ملف'
      : safeContent.length > 60 ? safeContent.substring(0, 60) + '…' : safeContent;
    for (const memberId of members) {
      if (memberId !== userId && !onlineUsers.has(memberId)) {
        sendPushToUser(memberId, {
          title: senderName,
          body: preview,
          url: '/app.html',
          convId,
          tag: `msg-${convId}`
        }).catch(() => {});
      }
    }
  });

  // ── Typing ──
  socket.on('message:typing', ({ convId }) => {
    socket.to(convId).emit('user:typing', { userId, convId });
  });

  // ── Read Receipt ──
  socket.on('message:read', ({ convId, messageId }) => {
    if (messageId) db.updateMessageStatus(messageId, 'read');
    socket.to(convId).emit('message:read', { userId, convId, messageId });
  });

  // ── Join / Create Conversation ──
  socket.on('conversation:join', ({ targetUserId }) => {
    let convId = db.findDirectConv(userId, targetUserId);

    if (!convId) {
      convId = uuidv4();
      db.createConversation({ id: convId, type: 'direct', members: [userId, targetUserId] });
    }

    socket.join(convId);

    // Also put the other user in the room if online
    const otherSocketId = onlineUsers.get(targetUserId);
    if (otherSocketId) {
      io.to(otherSocketId).socketsJoin(convId);
      io.to(otherSocketId).emit('conversation:new', { convId });
    }

    const otherUser = db.getUserById(targetUserId);
    socket.emit('conversation:ready', {
      convId,
      otherUser: { ...db.safeUser(otherUser), isOnline: onlineUsers.has(targetUserId) }
    });
  });

  // ── WebRTC Call Signaling ──
  socket.on('call:offer', ({ targetUserId, offer, callType }) => {
    const targetSocketId = onlineUsers.get(targetUserId);
    if (!targetSocketId) {
      socket.emit('call:error', { message: 'المستخدم غير متصل' });
      return;
    }
    const caller = db.getUserById(userId);
    io.to(targetSocketId).emit('call:incoming', {
      callerId: userId,
      callerName: caller?.displayName,
      callerAvatar: caller?.avatar,
      offer,
      callType // 'audio' | 'video'
    });
  });

  socket.on('call:answer', ({ callerId, answer }) => {
    const callerSocketId = onlineUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call:answered', { answer });
    }
  });

  socket.on('call:ice-candidate', ({ targetUserId, candidate }) => {
    const targetSocketId = onlineUsers.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:ice-candidate', { candidate });
    }
  });

  socket.on('call:reject', ({ callerId }) => {
    const callerSocketId = onlineUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call:rejected', { rejectedBy: userId });
    }
  });

  socket.on('call:end', ({ targetUserId }) => {
    const targetSocketId = onlineUsers.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:ended', { endedBy: userId });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('user:offline', { userId });
  });
});

// ── Auth Middleware ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصادق' });
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch {
    return res.status(401).json({ error: 'رمز غير صالح' });
  }
  // DB checks outside JWT try-catch so DB errors don't cause false 401s
  try {
    if (db.isUserBanned(userId)) {
      secLog('BANNED_ACCESS', { userId, ip: req.ip });
      return res.status(403).json({ error: 'تم حظر حسابك. تواصل مع الإدارة.' });
    }
    db.updateLastSeen(userId);
  } catch { /* ignore DB errors silently */ }
  req.userId = userId;
  next();
}

// ── Admin Auth Middleware ──────────────────────────────────────────
const ADMIN_JWT_SECRET = (process.env.ADMIN_PASSWORD || 'admin_secret') + '_jwt';

function adminAuthMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح للأدمن' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    next();
  } catch {
    secLog('ADMIN_UNAUTH', { ip: req.ip });
    res.status(401).json({ error: 'صلاحيات الأدمن غير صحيحة' });
  }
}

// ── Admin Routes ─────────────────────────────────────────────────
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.post('/api/admin/login', adminLimiter, (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'لم يتم ضبط ADMIN_PASSWORD في المتغيرات' });
  if ((password || '').trim() !== ADMIN_PASSWORD) {
    secLog('ADMIN_LOGIN_FAIL', { ip: req.ip });
    return res.status(401).json({ error: 'كلمة مرور الأدمن غير صحيحة' });
  }
  const token = jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '2h' });
  secLog('ADMIN_LOGIN', { ip: req.ip });
  res.json({ token });
});

app.get('/api/admin/stats', adminAuthMiddleware, (req, res) => {
  const stats = db.getStats();
  const mem = process.memoryUsage();
  res.json({
    ...stats,
    onlineUsers: onlineUsers.size,
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(mem.rss / 1024 / 1024)
  });
});

app.get('/api/admin/users', adminAuthMiddleware, (req, res) => {
  const users = db.getAllUsers().map(u => ({
    ...u,
    isOnline: onlineUsers.has(u.id)
  }));
  res.json(users);
});

app.post('/api/admin/users/:id/ban', adminAuthMiddleware, (req, res) => {
  const { reason } = req.body;
  db.banUser(req.params.id, reason);
  // Force logout
  const sid = onlineUsers.get(req.params.id);
  if (sid) io.to(sid).emit('force:logout', { reason: 'banned' });
  onlineUsers.delete(req.params.id);
  db.revokeAllUserTokens(req.params.id);
  secLog('ADMIN_BAN', { targetId: req.params.id, reason, ip: req.ip });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', adminAuthMiddleware, (req, res) => {
  db.unbanUser(req.params.id);
  secLog('ADMIN_UNBAN', { targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/force-logout', adminAuthMiddleware, (req, res) => {
  const sid = onlineUsers.get(req.params.id);
  if (sid) io.to(sid).emit('force:logout', { reason: 'admin_action' });
  onlineUsers.delete(req.params.id);
  db.revokeAllUserTokens(req.params.id);
  secLog('ADMIN_FORCE_LOGOUT', { targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', adminAuthMiddleware, (req, res) => {
  const sid = onlineUsers.get(req.params.id);
  if (sid) io.to(sid).emit('force:logout', { reason: 'account_deleted' });
  onlineUsers.delete(req.params.id);
  db.deleteUserAccount(req.params.id);
  secLog('ADMIN_DELETE_USER', { targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/admin/conversations', adminAuthMiddleware, (req, res) => {
  res.json(db.getAllConversations());
});

app.delete('/api/admin/conversations/:id', adminAuthMiddleware, (req, res) => {
  db.deleteConversationById(req.params.id);
  secLog('ADMIN_DELETE_CONV', { convId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/admin/logs', adminAuthMiddleware, (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ logs: [] });
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).reverse().slice(0, 500);
    res.json({ logs: lines });
  } catch {
    res.status(500).json({ error: 'خطأ في قراءة السجلات' });
  }
});

app.post('/api/admin/backup', adminAuthMiddleware, (req, res) => {
  runBackup();
  res.json({ ok: true, message: 'تم بدء النسخة الاحتياطية' });
});

// ── Security Monitoring Routes ────────────────────────────────────

// Get all messages containing dangerous keywords (auto-flagged)
app.get('/api/admin/monitor/flagged', adminAuthMiddleware, (req, res) => {
  const flagged = db.getFlaggedMessages();
  secLog('ADMIN_VIEW_FLAGGED', { count: flagged.length, ip: req.ip });
  res.json(flagged);
});

// Search messages by any keyword
app.get('/api/admin/monitor/search', adminAuthMiddleware, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'كلمة البحث قصيرة جداً' });
  const results = db.searchMessages(q.trim(), 100);
  secLog('ADMIN_SEARCH', { keyword: q, ip: req.ip });
  res.json(results);
});

// Get full user activity/investigation report
app.get('/api/admin/monitor/user/:id', adminAuthMiddleware, (req, res) => {
  const report = db.getUserActivity(req.params.id);
  if (!report) return res.status(404).json({ error: 'المستخدم غير موجود' });
  secLog('ADMIN_USER_REPORT', { targetId: req.params.id, ip: req.ip });
  res.json(report);
});

// Get current keyword list
app.get('/api/admin/monitor/keywords', adminAuthMiddleware, (req, res) => {
  res.json({ keywords: db.DANGEROUS_KEYWORDS });
});

server.listen(PORT, () => {
  console.log(`🔐 Ameen Messenger running on http://localhost:${PORT}`);
  console.log(`🗄️  Database: ameen.db (SQLite — persistent storage)`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
