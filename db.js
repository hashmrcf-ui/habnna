/**
 * db.js — SQLite database layer for Ameen Messenger
 * All data is stored permanently in ameen.db
 */

const Database = require('better-sqlite3');
const path = require('path');

// Use Railway volume mount path if available, otherwise local directory
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, 'ameen.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar      TEXT,
    hashed_pw   TEXT NOT NULL,
    status      TEXT DEFAULT 'متاح',
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL DEFAULT 'direct',
    name       TEXT,
    avatar     TEXT,
    admin_id   TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conv_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role    TEXT DEFAULT 'member',
    joined_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (conv_id, user_id),
    FOREIGN KEY (conv_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    conv_id       TEXT NOT NULL,
    sender_id     TEXT NOT NULL,
    sender_name   TEXT,
    content       TEXT NOT NULL,
    type          TEXT DEFAULT 'text',
    encrypted_key TEXT,
    status        TEXT DEFAULT 'sent',
    timestamp     INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (conv_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
`);

// ── User Queries ─────────────────────────────────────────────────
const userQueries = {
  create: db.prepare(`
    INSERT INTO users (id, username, display_name, avatar, hashed_pw, status)
    VALUES (@id, @username, @display_name, @avatar, @hashed_pw, @status)
  `),
  findByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  findById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  search: db.prepare(`
    SELECT id, username, display_name, avatar, status, created_at
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `),
  getMany: db.prepare(`SELECT id, username, display_name, avatar, status, created_at FROM users WHERE id IN (SELECT value FROM json_each(?))`)
};

// ── Conversation Queries ─────────────────────────────────────────
const convQueries = {
  create: db.prepare(`INSERT INTO conversations (id, type, name, avatar, admin_id) VALUES (@id, @type, @name, @avatar, @admin_id)`),
  addMember: db.prepare(`INSERT OR IGNORE INTO conversation_members (conv_id, user_id, role) VALUES (?, ?, ?)`),
  removeMember: db.prepare(`DELETE FROM conversation_members WHERE conv_id = ? AND user_id = ?`),
  getMembers: db.prepare(`SELECT user_id, role FROM conversation_members WHERE conv_id = ?`),
  getUserConvs: db.prepare(`
    SELECT c.*, cm.user_id
    FROM conversations c
    JOIN conversation_members cm ON c.id = cm.conv_id
    WHERE cm.conv_id IN (
      SELECT conv_id FROM conversation_members WHERE user_id = ?
    )
  `),
  findDirect: db.prepare(`
    SELECT cm1.conv_id FROM conversation_members cm1
    JOIN conversation_members cm2 ON cm1.conv_id = cm2.conv_id
    JOIN conversations c ON c.id = cm1.conv_id
    WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.type = 'direct'
    LIMIT 1
  `),
  isMember: db.prepare(`SELECT 1 FROM conversation_members WHERE conv_id = ? AND user_id = ?`),
  getById: db.prepare(`SELECT * FROM conversations WHERE id = ?`)
};

// ── Message Queries ───────────────────────────────────────────────
const msgQueries = {
  insert: db.prepare(`
    INSERT INTO messages (id, conv_id, sender_id, sender_name, content, type, encrypted_key, status, timestamp)
    VALUES (@id, @conv_id, @sender_id, @sender_name, @content, @type, @encrypted_key, @status, @timestamp)
  `),
  getByConv: db.prepare(`
    SELECT * FROM messages WHERE conv_id = ? ORDER BY timestamp ASC LIMIT 100
  `),
  getLast: db.prepare(`SELECT * FROM messages WHERE conv_id = ? ORDER BY timestamp DESC LIMIT 1`),
  updateStatus: db.prepare(`UPDATE messages SET status = ? WHERE id = ?`)
};

// ── High-level DB Functions ───────────────────────────────────────

function createUser({ id, username, displayName, avatar, hashedPw, status }) {
  userQueries.create.run({ id, username, display_name: displayName, avatar, hashed_pw: hashedPw, status });
  return getUserById(id);
}

function getUserByUsername(username) {
  const row = userQueries.findByUsername.get(username);
  return row ? mapUser(row) : null;
}

function getUserById(id) {
  const row = userQueries.findById.get(id);
  return row ? mapUser(row) : null;
}

function searchUsers(query, excludeId) {
  const q = `%${query}%`;
  return userQueries.search.all(q, q, excludeId).map(mapUser);
}

function findDirectConv(userId1, userId2) {
  const row = convQueries.findDirect.get(userId1, userId2);
  return row ? row.conv_id : null;
}

function createConversation({ id, type = 'direct', name = null, members = [], adminId = null, avatar = null }) {
  const tx = db.transaction(() => {
    convQueries.create.run({ id, type, name, avatar, admin_id: adminId });
    const adminRole = adminId;
    members.forEach(uid => convQueries.addMember.run(id, uid, uid === adminRole ? 'admin' : 'member'));
  });
  tx();
  return id;
}

function addConvMember(convId, userId) {
  convQueries.addMember.run(convId, userId, 'member');
}

function removeConvMember(convId, userId) {
  convQueries.removeMember.run(convId, userId);
}

function getConversationMembers(convId) {
  return convQueries.getMembers.all(convId).map(r => r.user_id);
}

function getGroupInfo(convId, viewerUserId) {
  const conv = convQueries.getById.get(convId);
  if (!conv) return null;
  const memberRows = convQueries.getMembers.all(convId);
  const members = memberRows.map(r => ({
    ...safeUser(getUserById(r.user_id)),
    role: r.role
  })).filter(Boolean);
  const lastMsg = msgQueries.getLast.get(convId);
  return {
    id: conv.id,
    type: conv.type,
    name: conv.name,
    avatar: conv.avatar,
    adminId: conv.admin_id,
    members,
    memberIds: members.map(m => m.id),
    memberCount: members.length,
    createdAt: conv.created_at,
    lastMessage: lastMsg ? mapMessage(lastMsg) : null
  };
}

function isConvMember(convId, userId) {
  return !!convQueries.isMember.get(convId, userId);
}

function getUserConversations(userId) {
  const myConvIds = db.prepare(
    `SELECT DISTINCT conv_id FROM conversation_members WHERE user_id = ?`
  ).all(userId).map(r => r.conv_id);

  return myConvIds.map(convId => {
    const conv = convQueries.getById.get(convId);
    if (!conv) return null;
    const members = getConversationMembers(convId);
    const lastMsg = msgQueries.getLast.get(convId);

    if (conv.type === 'direct') {
      const otherMemberId = members.find(m => m !== userId);
      const otherUser = otherMemberId ? safeUser(getUserById(otherMemberId)) : null;
      return {
        id: conv.id, type: conv.type, name: conv.name,
        members, createdAt: conv.created_at, otherUser,
        lastMessage: lastMsg ? mapMessage(lastMsg) : null
      };
    } else {
      // group or channel
      return getGroupInfo(convId, userId);
    }
  }).filter(Boolean);
}

function insertMessage({ id, convId, senderId, senderName, content, type, encryptedKey, status, timestamp }) {
  msgQueries.insert.run({
    id,
    conv_id: convId,
    sender_id: senderId,
    sender_name: senderName,
    content,
    type: type || 'text',
    encrypted_key: encryptedKey || null,
    status: status || 'sent',
    timestamp: timestamp || Date.now()
  });
}

function getMessages(convId) {
  return msgQueries.getByConv.all(convId).map(mapMessage);
}

function updateMessageStatus(msgId, status) {
  msgQueries.updateStatus.run(status, msgId);
}

// ── Mappers ───────────────────────────────────────────────────────
function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    hashedPw: row.hashed_pw,
    status: row.status,
    createdAt: row.created_at
  };
}

function safeUser(user) {
  if (!user) return null;
  const { hashedPw, ...safe } = user;
  return safe;
}

function mapMessage(row) {
  return {
    id: row.id,
    convId: row.conv_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    type: row.type,
    encryptedKey: row.encrypted_key,
    status: row.status,
    timestamp: row.timestamp
  };
}

module.exports = {
  createUser, getUserByUsername, getUserById, searchUsers,
  findDirectConv, createConversation, addConvMember, removeConvMember,
  getConversationMembers, isConvMember, getUserConversations,
  getGroupInfo, insertMessage, getMessages, updateMessageStatus, safeUser
};
