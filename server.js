const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('crypto');
const path = require('path');
const db = require('./db');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Routes ──────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

  if (db.getUserByUsername(username.toLowerCase()))
    return res.status(409).json({ error: 'اسم المستخدم محجوز' });

  const hashedPw = await bcrypt.hash(password, 10);
  const userId = uuidv4();
  const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(displayName)}&backgroundColor=1a1a2e`;

  const user = db.createUser({ id: userId, username: username.toLowerCase(), displayName, avatar, hashedPw, status: 'متاح' });
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: db.safeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const valid = await bcrypt.compare(password, user.hashedPw);
  if (!valid) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { ...db.safeUser(user), isOnline: true } });
});

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

    const members = db.getConversationMembers(convId);
    const anyRecipientOnline = members.some(m => m !== userId && onlineUsers.has(m));

    const msg = {
      id: uuidv4(),
      convId,
      senderId: userId,
      senderName: db.getUserById(userId)?.displayName,
      content,
      type,
      encryptedKey: encryptedKey || null,
      status: anyRecipientOnline ? 'delivered' : 'sent',
      timestamp: Date.now()
    };

    db.insertMessage(msg);
    io.to(convId).emit('message:new', msg);
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
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'رمز غير صالح' });
  }
}

server.listen(PORT, () => {
  console.log(`🔐 Ameen Messenger running on http://localhost:${PORT}`);
  console.log(`🗄️  Database: ameen.db (SQLite — persistent storage)`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
