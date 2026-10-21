const PRODUCTION_ORIGINS = new Set([
  "https://sundollworld.com",
  "https://sundollworld.pages.dev",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const MAX_BYTES = 8192;
const RATE_WINDOW_MS = 30_000;
const RATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_SALT = "sundollworld.com/message-board-rate-limit/v1\n";
const IDENTITY_ISSUER = "https://pl.sundollworld.com";
const IDENTITY_AUDIENCE = "sundollworld-message-board";
const SESSION_VALIDATION_URL = `${IDENTITY_ISSUER}/api/account/site-session/validate`;
const IDENTITY_TTL_SECONDS = 300;
const SESSION_TIMEOUT_MS = 4000;
const ACCOUNT_KEY = /^[0-9a-f]{64}$/;
const PUBLIC_ID = /^board_[0-9a-f]{32}$/;
const PUBLIC_COLUMNS = "id, nickname, body, created_at, status";
const MESSAGE_LIST_COLUMNS = `m.id, m.nickname, m.body, m.created_at, m.status,
  a.account_key, a.public_id,
  ((SELECT COUNT(*) FROM message_likes l WHERE l.message_id = m.id) + (SELECT COUNT(*) FROM board_message_likes l WHERE l.message_id = m.id)) AS like_count,
  (SELECT COUNT(*) FROM message_replies r WHERE r.parent_id = m.id AND r.status = 'published') AS reply_count,
  EXISTS (SELECT 1 FROM board_message_likes l WHERE l.message_id = m.id AND l.account_key = ?1) AS liked`;
const STORED_SUBMISSION = `SELECT ${PUBLIC_COLUMNS}, NULL AS parent_id, NULL AS target_reply_id, NULL AS target_nickname, 'message' AS record_type,
  (SELECT account_key FROM board_authors WHERE record_id = messages.id AND record_type = 'message') AS account_key,
  (SELECT public_id FROM board_authors WHERE record_id = messages.id AND record_type = 'message') AS public_id FROM messages WHERE request_id = ?1
  UNION ALL SELECT ${PUBLIC_COLUMNS}, parent_id, (SELECT target_reply_id FROM reply_targets WHERE reply_id = message_replies.id) AS target_reply_id, (SELECT target_nickname FROM reply_targets WHERE reply_id = message_replies.id) AS target_nickname, 'reply' AS record_type,
  (SELECT account_key FROM board_authors WHERE record_id = message_replies.id AND record_type = 'reply') AS account_key,
  (SELECT public_id FROM board_authors WHERE record_id = message_replies.id AND record_type = 'reply') AS public_id FROM message_replies WHERE request_id = ?1 LIMIT 1`;

class InputError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function allowedOrigin(origin, env) {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  const previews = String(env.ALLOWED_PREVIEW_ORIGINS || "").split(",");
  for (const value of previews) {
    const candidate = value.trim();
    if (candidate !== origin) continue;
    try {
      const url = new URL(candidate);
      if (url.origin === candidate && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    } catch {}
  }
  return false;
}

function responseHeaders(origin, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  });
  if (allowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  }
  return headers;
}

function jsonResponse(data, status, origin, env, extraHeaders = {}) {
  const headers = responseHeaders(origin, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, String(value));
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(status, code, message, origin, env, retryAfter) {
  const data = { ok: false, error: { code, message } };
  const headers = {};
  if (retryAfter !== undefined) {
    data.retryAfter = retryAfter;
    headers["Retry-After"] = retryAfter;
  }
  return jsonResponse(data, status, origin, env, headers);
}

function publicMessage(row, identity) {
  return { id: row.id, nickname: row.nickname, authorId: row.public_id || null, owned: Boolean(identity && row.account_key === identity.sub), body: row.body, createdAt: row.created_at, status: row.status };
}

function listedMessage(row, identity) {
  return { ...publicMessage(row, identity), likeCount: Number(row.like_count || 0), replyCount: Number(row.reply_count || 0), liked: Boolean(row.liked) };
}

function publicReply(row, identity) {
  return { ...publicMessage(row, identity), parentId: row.parent_id, ...(row.target_reply_id ? { targetReplyId: row.target_reply_id, targetNickname: row.target_nickname } : {}) };
}

function readCursor(url) {
  const cursors = url.searchParams.getAll("cursor");
  if (cursors.length > 1) throw new InputError(400, "INVALID_CURSOR", "留言页码无效，请重新打开留言板。");
  return cursors.length ? decodeCursor(cursors[0]) : null;
}

function invalidText(text) {
  return text.includes("\u0000") || Array.from(text).some(character => {
    const point = character.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff;
  });
}

function decodeTokenPart(part) {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Invalid token encoding");
  const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - part.length % 4) % 4));
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== part) throw new Error("Invalid token encoding");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function readIdentity(request, env, required) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    if (required) throw new InputError(401, "ACCOUNT_REQUIRED", "请先登录邮箱账号。");
    return null;
  }
  const secret = typeof env.BOARD_IDENTITY_SECRET === "string" ? new TextEncoder().encode(env.BOARD_IDENTITY_SECRET) : null;
  if (!secret || secret.length < 32) throw new Error("Identity configuration unavailable");
  const match = authorization.match(/^Bearer ([A-Za-z0-9_.-]{1,4096})$/);
  try {
    if (!match) throw new Error();
    const ticket = match[1];
    const parts = ticket.split(".");
    if (parts.length !== 3) throw new Error();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = JSON.parse(decoder.decode(decodeTokenPart(parts[0])));
    const identity = JSON.parse(decoder.decode(decodeTokenPart(parts[1])));
    if (!header || header.alg !== "HS256" || header.typ !== "JWT" || header.crit !== undefined) throw new Error();
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = decodeTokenPart(parts[2]);
    if (signature.length !== 32 || !await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
    const now = Math.floor(Date.now() / 1000);
    if (!identity || identity.v !== 1 || identity.iss !== IDENTITY_ISSUER || identity.aud !== IDENTITY_AUDIENCE || typeof identity.sub !== "string" || !ACCOUNT_KEY.test(identity.sub) || typeof identity.sid !== "string" || !ACCOUNT_KEY.test(identity.sid) || typeof identity.publicId !== "string" || !PUBLIC_ID.test(identity.publicId)) throw new Error();
    if (!Number.isSafeInteger(identity.iat) || !Number.isSafeInteger(identity.exp) || identity.iat <= 0 || identity.iat > now + 30 || identity.exp <= now || identity.exp <= identity.iat || identity.exp - identity.iat > IDENTITY_TTL_SECONDS) throw new Error();
    if (typeof identity.nickname !== "string" || identity.nickname !== identity.nickname.trim() || invalidText(identity.nickname) || Array.from(identity.nickname).length < 1 || Array.from(identity.nickname).length > 24) throw new Error();
    return { ...identity, ticket };
  } catch {
    throw new InputError(401, "ACCOUNT_SESSION_INVALID", "登录状态已失效，请重新登录。");
  }
}

async function requireActiveSession(identity) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
  try {
    const response = await fetch(SESSION_VALIDATION_URL, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket: identity.ticket }),
    });
    if (response.status === 401) throw new InputError(401, "ACCOUNT_SESSION_INVALID", "登录状态已失效，请重新登录。");
    if (!response.ok) {
      console.warn("board-session-check-status", response.status);
      throw new Error("Session validation unavailable");
    }
    const data = await response.json();
    if (data?.ok !== true || data.active !== true) throw new Error("Session validation unavailable");
  } catch (error) {
    if (error instanceof InputError) throw error;
    console.warn("board-session-check-failure", error?.name || "Error");
    throw new Error("Session validation unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function encodeCursor(row) {
  return btoa(JSON.stringify({ t: row.created_at, i: row.id })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor) {
  if (!cursor || cursor.length > 160 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InputError(400, "INVALID_CURSOR", "留言页码无效，请重新打开留言板。");
  try {
    const value = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4)));
    if (!value || typeof value.t !== "string" || typeof value.i !== "string" || !UUID.test(value.i)) throw new Error();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.t)) throw new Error();
    const date = new Date(value.t);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.t || value.i !== value.i.toLowerCase()) throw new Error();
    return value;
  } catch {
    throw new InputError(400, "INVALID_CURSOR", "留言页码无效，请重新打开留言板。");
  }
}

async function listMessages(url, db, origin, env, identity) {
  const cursor = readCursor(url);
  const account = identity?.sub ?? null;
  const records = "messages m LEFT JOIN board_authors a ON a.record_id = m.id AND a.record_type = 'message'";
  let query;
  if (cursor) {
    query = db.prepare(`SELECT ${MESSAGE_LIST_COLUMNS} FROM ${records} WHERE m.status = 'published' AND (m.created_at < ?2 OR (m.created_at = ?2 AND m.id < ?3)) ORDER BY m.created_at DESC, m.id DESC LIMIT ?4`).bind(account, cursor.t, cursor.i, PAGE_SIZE + 1);
  } else {
    query = db.prepare(`SELECT ${MESSAGE_LIST_COLUMNS} FROM ${records} WHERE m.status = 'published' ORDER BY m.created_at DESC, m.id DESC LIMIT ?2`).bind(account, PAGE_SIZE + 1);
  }
  const result = await query.all();
  if (result.success === false || !Array.isArray(result.results)) throw new Error("Read unavailable");
  const rows = result.results.slice(0, PAGE_SIZE);
  return jsonResponse({ ok: true, messages: rows.map(row => listedMessage(row, identity)), nextCursor: result.results.length > PAGE_SIZE ? encodeCursor(rows[rows.length - 1]) : null }, 200, origin, env);
}

async function requirePublishedParent(db, parentId) {
  const row = await db.prepare("SELECT id FROM messages WHERE id = ?1 AND status = 'published' LIMIT 1").bind(parentId).first();
  if (!row) throw new InputError(404, "MESSAGE_NOT_FOUND", "这条留言已不可用。");
}

async function listReplies(url, db, parentId, origin, env, identity) {
  const cursor = readCursor(url);
  const account = identity?.sub ?? null;
  const records = "message_replies r LEFT JOIN reply_targets t ON t.reply_id = r.id LEFT JOIN board_authors a ON a.record_id = r.id AND a.record_type = 'reply'";
  const columns = `r.id, r.nickname, r.body, r.created_at, r.status, r.parent_id, a.account_key, a.public_id,
    t.target_reply_id, t.target_nickname,
    ((SELECT COUNT(*) FROM reply_likes l WHERE l.reply_id = r.id) + (SELECT COUNT(*) FROM board_reply_likes l WHERE l.reply_id = r.id)) AS like_count,
    EXISTS (SELECT 1 FROM board_reply_likes l WHERE l.reply_id = r.id AND l.account_key = ?5) AS liked`;
  let query;
  if (cursor) {
    query = db.prepare(`SELECT ${columns} FROM ${records} WHERE r.parent_id = ?1 AND r.status = 'published' AND (r.created_at > ?2 OR (r.created_at = ?2 AND r.id > ?3)) ORDER BY r.created_at ASC, r.id ASC LIMIT ?4`).bind(parentId, cursor.t, cursor.i, PAGE_SIZE + 1, account);
  } else {
    query = db.prepare(`SELECT ${columns} FROM ${records} WHERE r.parent_id = ?1 AND r.status = 'published' AND (?2 IS NULL OR r.created_at > ?2 OR (r.created_at = ?2 AND r.id > ?3)) ORDER BY r.created_at ASC, r.id ASC LIMIT ?4`).bind(parentId, null, null, PAGE_SIZE + 1, account);
  }
  const result = await db.batch([
    db.prepare("SELECT id FROM messages WHERE id = ?1 AND status = 'published' LIMIT 1").bind(parentId),
    query,
  ]);
  if (!Array.isArray(result) || result.length !== 2 || result.some((entry) => entry.success === false || !Array.isArray(entry.results))) throw new Error("Read unavailable");
  if (!result[0].results.length) throw new InputError(404, "MESSAGE_NOT_FOUND", "这条留言已不可用。");
  const rows = result[1].results.slice(0, PAGE_SIZE);
  return jsonResponse({ ok: true, replies: rows.map(row => ({ ...publicReply(row, identity), likeCount: Number(row.like_count || 0), liked: Boolean(row.liked) })), nextCursor: result[1].results.length > PAGE_SIZE ? encodeCursor(rows[rows.length - 1]) : null }, 200, origin, env);
}

async function readBody(request) {
  const type = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new InputError(415, "UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 提交留言。");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new InputError(413, "BODY_TOO_LARGE", "留言请求过大。");
  if (!request.body) throw new InputError(400, "INVALID_JSON", "留言内容无效。");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new InputError(413, "BODY_TOO_LARGE", "留言请求过大。");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, "INVALID_JSON", "留言内容无效。");
  } finally {
    reader.releaseLock();
  }
}

function validateMessage(data, identity) {
  if (typeof data.body !== "string") throw new InputError(400, "INVALID_MESSAGE", "请填写留言。");
  const nickname = identity.nickname;
  const body = data.body.trim();
  if (invalidText(nickname) || invalidText(body)) throw new InputError(400, "INVALID_TEXT", "留言包含无法保存的字符，请修改后再试。");
  if (Array.from(nickname).length < 1 || Array.from(nickname).length > 24) throw new InputError(400, "INVALID_NICKNAME", "昵称需为 1–24 个字。");
  if (Array.from(body).length < 1 || Array.from(body).length > 500) throw new InputError(400, "INVALID_BODY", "留言需为 1–500 个字。");
  if (data.requestId !== undefined && (typeof data.requestId !== "string" || !UUID.test(data.requestId))) throw new InputError(400, "INVALID_REQUEST_ID", "提交编号无效，请重新提交。");
  if (data.targetReplyId !== undefined && data.targetReplyId !== null && (typeof data.targetReplyId !== "string" || !UUID.test(data.targetReplyId))) throw new InputError(400, "INVALID_REPLY_TARGET", "回复对象无效。");
  return { targetReplyId: data.targetReplyId?.toLowerCase() ?? null, nickname, body, requestId: data.requestId === undefined ? crypto.randomUUID() : data.requestId.toLowerCase() };
}

async function rateHash(request) {
  const address = (request.headers.get("CF-Connecting-IP") || "unknown").trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RATE_SALT + address));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function storedResponse(row, input, parentId, deduplicated, origin, env, identity) {
  const isReply = parentId !== null;
  if (row.record_type !== (isReply ? "reply" : "message") || row.parent_id !== parentId || row.account_key !== identity.sub || row.body !== input.body || (row.target_reply_id ?? null) !== input.targetReplyId) throw new InputError(409, "REQUEST_ID_CONFLICT", "提交编号已用于另一条留言，请重新提交。");
  const data = isReply ? { reply: publicReply(row, identity) } : { message: publicMessage(row, identity) };
  return jsonResponse({ ok: true, ...data, status: row.status, deduplicated, deletionEnabled: true }, deduplicated ? 200 : 201, origin, env);
}

async function storeMessage(request, db, origin, env, identity, parentId = null) {
  const input = validateMessage(await readBody(request), identity);
  const review = String(env.REVIEW_REQUIRED ?? "true").trim().toLowerCase();
  if (review !== "true" && review !== "false") throw new Error("Review configuration unavailable");
  if (parentId !== null) await requirePublishedParent(db, parentId);
  if (parentId === null && input.targetReplyId) throw new InputError(400, "INVALID_REPLY_TARGET", "留言不能指定回复对象。");
  const existing = await db.prepare(STORED_SUBMISSION).bind(input.requestId).first();
  if (existing) return storedResponse(existing, input, parentId, true, origin, env, identity);

  if (input.targetReplyId) {
    const target = await db.prepare("SELECT id FROM message_replies WHERE id = ?1 AND parent_id = ?2 AND status = 'published'").bind(input.targetReplyId, parentId).first();
    if (!target) throw new InputError(404, "REPLY_NOT_FOUND", "这条回复已不可用。");
  }
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const status = review === "true" ? "pending" : "published";
  const id = crypto.randomUUID();
  const hash = await rateHash(request);
  const insertion = parentId === null
    ? db.prepare("INSERT INTO messages (id, request_id, nickname, body, created_at, status) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM rate_limits WHERE request_id = ?2 AND ip_hash = ?7 AND created_at = ?8) AND NOT EXISTS (SELECT 1 FROM message_replies WHERE request_id = ?2) ON CONFLICT(request_id) DO NOTHING").bind(id, input.requestId, input.nickname, input.body, createdAt, status, hash, now)
    : db.prepare("INSERT INTO message_replies (id, request_id, parent_id, nickname, body, created_at, status) SELECT ?1, ?2, ?9, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM rate_limits WHERE request_id = ?2 AND ip_hash = ?7 AND created_at = ?8) AND NOT EXISTS (SELECT 1 FROM messages WHERE request_id = ?2) AND EXISTS (SELECT 1 FROM messages WHERE id = ?9 AND status = 'published') AND (?10 IS NULL OR EXISTS (SELECT 1 FROM message_replies WHERE id = ?10 AND parent_id = ?9 AND status = 'published')) ON CONFLICT(request_id) DO NOTHING").bind(id, input.requestId, input.nickname, input.body, createdAt, status, hash, now, parentId, input.targetReplyId);
  // D1 batch is one transaction: a failed save rolls back its rate-limit slot.
  const result = await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?1").bind(now),
    db.prepare("INSERT INTO rate_limits (request_id, ip_hash, created_at, expires_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM messages WHERE request_id = ?1) AND NOT EXISTS (SELECT 1 FROM message_replies WHERE request_id = ?1) AND NOT EXISTS (SELECT 1 FROM rate_limits WHERE ip_hash = ?2 AND created_at > ?5) AND (?6 IS NULL OR EXISTS (SELECT 1 FROM messages WHERE id = ?6 AND status = 'published')) AND (?7 IS NULL OR EXISTS (SELECT 1 FROM message_replies WHERE id = ?7 AND parent_id = ?6 AND status = 'published')) ON CONFLICT(request_id) DO NOTHING").bind(input.requestId, hash, now, now + RATE_RETENTION_MS, now - RATE_WINDOW_MS, parentId, input.targetReplyId),
    insertion,
    // Only the row inserted by this transaction may acquire an account author.
    db.prepare(`INSERT INTO board_authors (record_id, record_type, account_key, public_id) SELECT id, ?2, ?3, ?4 FROM ${parentId === null ? "messages" : "message_replies"} WHERE request_id = ?1 AND id = ?5 ON CONFLICT(record_id) DO NOTHING`).bind(input.requestId, parentId === null ? "message" : "reply", identity.sub, identity.publicId, id),
    db.prepare("INSERT INTO reply_targets (reply_id, target_reply_id, target_nickname) SELECT r.id, t.id, t.nickname FROM message_replies r JOIN message_replies t ON t.id = ?2 AND t.parent_id = r.parent_id AND t.status = 'published' WHERE r.request_id = ?1 AND r.id = ?3 ON CONFLICT(reply_id) DO NOTHING").bind(input.requestId, input.targetReplyId, id),
    db.prepare(STORED_SUBMISSION).bind(input.requestId),
  ]);
  if (!Array.isArray(result) || result.length !== 6 || result.some((entry) => entry.success === false)) throw new Error("Save unavailable");
  const row = result[5].results?.[0];
  if (row) return storedResponse(row, input, parentId, row.id !== id, origin, env, identity);
  if (parentId !== null) await requirePublishedParent(db, parentId);
  if (input.targetReplyId && !await db.prepare("SELECT id FROM message_replies WHERE id = ?1 AND parent_id = ?2 AND status = 'published'").bind(input.targetReplyId, parentId).first()) throw new InputError(404, "REPLY_NOT_FOUND", "这条回复已不可用。");
  const recent = await db.prepare("SELECT MAX(created_at) AS latest FROM rate_limits WHERE ip_hash = ?1").bind(hash).first();
  const retryAfter = Math.max(1, Math.min(30, Math.ceil(((recent?.latest ?? now) + RATE_WINDOW_MS - now) / 1000)));
  return errorResponse(429, "RATE_LIMITED", "请稍等片刻再发送。", origin, env, retryAfter);
}

async function storeLike(request, db, messageId, origin, env, identity, replyId = null) {
  const input = await readBody(request);
  const account = identity.sub;
  if (typeof input.liked !== "boolean") throw new InputError(400, "INVALID_LIKE", "点赞状态无效，请重新尝试。");
  const id = replyId || messageId;
  const table = replyId ? "board_reply_likes" : "board_message_likes";
  const legacyTable = replyId ? "reply_likes" : "message_likes";
  const key = replyId ? "reply_id" : "message_id";
  const records = replyId ? "message_replies" : "messages";
  const available = replyId
    ? "SELECT 1 FROM message_replies r JOIN messages m ON m.id = r.parent_id WHERE r.id = ?1 AND r.parent_id = ?3 AND r.status = 'published' AND m.status = 'published'"
    : "SELECT 1 FROM messages WHERE id = ?1 AND status = 'published'";
  const bind = sql => db.prepare(sql).bind(...(replyId ? (sql.includes("?4") ? [id, account, messageId, new Date().toISOString()] : [id, account, messageId]) : sql.includes("?3") ? [id, account, new Date().toISOString()] : [id, account]));
  const mutation = input.liked
    ? bind(`INSERT INTO ${table} (${key}, account_key, created_at) SELECT ?1, ?2, ${replyId ? "?4" : "?3"} WHERE EXISTS (${available}) ON CONFLICT(${key}, account_key) DO NOTHING`)
    : bind(`DELETE FROM ${table} WHERE ${key} = ?1 AND account_key = ?2 AND EXISTS (${available})`);
  const result = await db.batch([
    mutation,
    bind(`SELECT r.id, ((SELECT COUNT(*) FROM ${table} l WHERE l.${key} = r.id) + (SELECT COUNT(*) FROM ${legacyTable} l WHERE l.${key} = r.id)) AS like_count, EXISTS (SELECT 1 FROM ${table} l WHERE l.${key} = r.id AND l.account_key = ?2) AS liked FROM ${records} r WHERE r.id = ?1 AND EXISTS (${available}) LIMIT 1`),
  ]);
  if (!Array.isArray(result) || result.length !== 2 || result.some(entry => entry.success === false)) throw new Error("Save unavailable");
  const row = result[1].results?.[0];
  if (!row) throw new InputError(404, "MESSAGE_NOT_FOUND", "这条内容已不可用。");
  return jsonResponse({ ok: true, messageId, ...(replyId ? { replyId } : {}), liked: Boolean(row.liked), likeCount: Number(row.like_count || 0) }, 200, origin, env);
}

async function deleteRecord(request, db, id, parentId, origin, env, identity) {
  await readBody(request);
  const account = identity.sub;
  const isReply = parentId !== null;
  const type = isReply ? "reply" : "message";
  const table = isReply ? "message_replies" : "messages";
  const authorized = `EXISTS (SELECT 1 FROM board_authors o WHERE o.record_id = ?1 AND o.record_type = '${type}' AND o.account_key = ?2)`;
  const parentCondition = isReply ? " AND parent_id = ?3" : "";
  const bind = (sql) => db.prepare(sql).bind(...(sql.includes("?3") ? [id, account, parentId] : sql.includes("?2") ? [id, account] : [id]));
  const statements = [
    bind(`SELECT r.id, ${isReply ? "r.parent_id," : ""} o.account_key FROM ${table} r LEFT JOIN board_authors o ON o.record_id = r.id AND o.record_type = '${type}' WHERE r.id = ?1`),
    bind(`DELETE FROM rate_limits WHERE request_id IN (SELECT request_id FROM ${table} WHERE id = ?1${parentCondition}${isReply ? "" : " UNION ALL SELECT request_id FROM message_replies WHERE parent_id = ?1"}) AND ${authorized}`),
  ];
  if (!isReply) statements.push(
    bind(`DELETE FROM message_owners WHERE record_type = 'reply' AND record_id IN (SELECT id FROM message_replies WHERE parent_id = ?1) AND ${authorized}`),
    bind(`DELETE FROM board_authors WHERE record_type = 'reply' AND record_id IN (SELECT id FROM message_replies WHERE parent_id = ?1) AND ${authorized}`),
  );
  statements.push(
    bind(`DELETE FROM ${table} WHERE id = ?1${parentCondition} AND ${authorized}`),
    bind(`DELETE FROM message_owners WHERE record_id = ?1 AND record_type = '${type}' AND ${authorized} AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ?1)`),
    bind(`DELETE FROM board_authors WHERE record_id = ?1 AND record_type = '${type}' AND account_key = ?2 AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ?1)`),
    bind(`SELECT id FROM ${table} WHERE id = ?1${parentCondition} AND ?2 IS NOT NULL`),
  );
  const result = await db.batch(statements);
  if (!Array.isArray(result) || result.length !== statements.length || result.some((entry) => entry.success === false)) throw new Error("Delete unavailable");
  const row = result[0].results?.[0];
  if (isReply && row && row.parent_id !== parentId) throw new InputError(404, "MESSAGE_NOT_FOUND", "这条回复已不可用。");
  if (row && row.account_key !== account) throw new InputError(403, "DELETE_NOT_ALLOWED", "只能删除自己账号留下的内容。");
  if (result[result.length - 1].results?.length) throw new Error("Delete was not confirmed");
  return jsonResponse({ ok: true, deletedId: id, kind: type, ...(isReply ? { parentId } : {}), alreadyDeleted: !row }, 200, origin, env);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    try {
      const url = new URL(request.url);
      if (origin && !allowedOrigin(origin, env)) return errorResponse(403, "ORIGIN_NOT_ALLOWED", "此来源不能访问留言板。", origin, env);
      const replyLike = url.pathname.match(/^\/api\/messages\/([^/]+)\/replies\/([^/]+)\/like$/);
      const nested = url.pathname.match(/^\/api\/messages\/([^/]+)\/(replies|like)$/);
      const deletion = url.pathname.match(/^\/api\/messages\/([^/]+)(?:\/replies\/([^/]+))?$/);
      if (url.pathname !== "/api/messages" && !nested && !deletion && !replyLike) return errorResponse(404, "NOT_FOUND", "没有这个留言接口。", origin, env);
      let messageId = null;
      if (nested) {
        if (!UUID.test(nested[1])) throw new InputError(400, "INVALID_MESSAGE_ID", "留言编号无效。");
        messageId = nested[1].toLowerCase();
      }
      if (deletion && (!UUID.test(deletion[1]) || (deletion[2] && !UUID.test(deletion[2])))) throw new InputError(400, "INVALID_MESSAGE_ID", "留言编号无效。");
      if (replyLike && (!UUID.test(replyLike[1]) || !UUID.test(replyLike[2]))) throw new InputError(400, "INVALID_MESSAGE_ID", "回复编号无效。");
      const methods = replyLike ? ["POST"] : deletion ? ["DELETE"] : nested?.[2] === "like" ? ["POST"] : ["GET", "POST"];
      if (request.method === "OPTIONS") {
        const method = request.headers.get("Access-Control-Request-Method");
        const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
        if (!allowedOrigin(origin, env) || !methods.includes(method) || requestedHeaders.some((name) => !["content-type", "authorization"].includes(name))) return errorResponse(403, "PREFLIGHT_NOT_ALLOWED", "此请求不能访问留言板。", origin, env);
        const headers = responseHeaders(origin, env);
        headers.set("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "));
        headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        headers.set("Access-Control-Max-Age", "600");
        return new Response(null, { status: 204, headers });
      }
      if (!methods.includes(request.method)) return jsonResponse({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "此请求方式不受支持。" } }, 405, origin, env, { Allow: [...methods, "OPTIONS"].join(", ") });
      if (!env.BOARD_DB) throw new Error("Database unavailable");
      const identity = await readIdentity(request, env, request.method !== "GET");
      if (request.method !== "GET") await requireActiveSession(identity);
      if (replyLike) return await storeLike(request, env.BOARD_DB, replyLike[1].toLowerCase(), origin, env, identity, replyLike[2].toLowerCase());
      if (deletion) return await deleteRecord(request, env.BOARD_DB, (deletion[2] || deletion[1]).toLowerCase(), deletion[2] ? deletion[1].toLowerCase() : null, origin, env, identity);
      if (nested?.[2] === "like") return await storeLike(request, env.BOARD_DB, messageId, origin, env, identity);
      if (nested?.[2] === "replies") return request.method === "GET" ? await listReplies(url, env.BOARD_DB, messageId, origin, env, identity) : await storeMessage(request, env.BOARD_DB, origin, env, identity, messageId);
      return request.method === "GET" ? await listMessages(url, env.BOARD_DB, origin, env, identity) : await storeMessage(request, env.BOARD_DB, origin, env, identity);
    } catch (error) {
      if (error instanceof InputError) return errorResponse(error.status, error.code, error.message, origin, env);
      return errorResponse(503, "SERVICE_UNAVAILABLE", "留言板暂时不可用，请稍后重试。", origin, env, 3);
    }
  },
};
