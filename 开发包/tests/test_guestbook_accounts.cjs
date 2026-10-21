'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const boardRoot = path.resolve(__dirname, '../../网站/留言板');
const source = fs.readFileSync(path.join(boardRoot, 'worker.js'), 'utf8');
const schema = fs.readFileSync(path.join(boardRoot, 'schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(boardRoot, 'migration-005-account-identity.sql'), 'utf8');
const workerReady = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`).then(module => module.default);
const secret = 'local-fixture-only-identity-secret-32-bytes';
const validationURL = 'https://pl.sundollworld.com/api/account/site-session/validate';
const origin = 'https://sundollworld.com';
const uuid = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function ticket(claims, header = {alg: 'HS256', typ: 'JWT'}, signingSecret = secret) {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${crypto.createHmac('sha256', signingSecret).update(input).digest('base64url')}`;
}
function account(name, device = 'one', overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {v: 1, iss: 'https://pl.sundollworld.com', aud: 'sundollworld-message-board', sub: hash(name), publicId: `board_${hash(`public:${name}`).slice(0, 32)}`, sid: hash(`${name}:${device}`), nickname: name, iat: now, exp: now + 300, ...overrides};
  return {...claims, ticket: ticket(claims)};
}

// Execute the unmodified Worker SQL with SQLite, including atomic D1 batch rollback.
class D1Fixture {
  constructor(initialSchema = schema) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(initialSchema);
    this.failAt = null;
    this.beforeBatch = null;
  }
  prepare(sql) {
    const fixture = this;
    return {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async all() { return fixture.execute(this); },
      async first() { return fixture.execute(this).results[0] || null; },
    };
  }
  execute(statement) {
    return {success: true, results: this.db.prepare(statement.sql).all(...statement.values)};
  }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(this.db); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (this.failAt === index) { this.failAt = null; throw new Error('Fixture transaction failure'); }
        return this.execute(statement);
      });
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  rows(sql, ...values) { return this.db.prepare(sql).all(...values).map(row => ({...row})); }
  count(table) { return this.rows(`SELECT COUNT(*) n FROM ${table}`)[0].n; }
  snapshot() {
    const tables = this.rows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    return JSON.stringify(tables.map(({name}) => [name, this.rows(`SELECT * FROM ${name} ORDER BY rowid`)]));
  }
  close() { this.db.close(); }
}

async function fixture(t) {
  const worker = await workerReady;
  const db = new D1Fixture();
  const previousFetch = global.fetch;
  const state = {mode: 'active', calls: 0, revoked: new Set(), requests: []};
  global.fetch = async (url, options) => {
    assert.equal(url, validationURL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ['ticket']);
    const claims = JSON.parse(Buffer.from(body.ticket.split('.')[1], 'base64url').toString());
    state.calls++;
    state.requests.push(claims);
    if (state.mode === 'offline') throw new Error('Fixture offline');
    if (state.mode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture abort')), {once: true}));
    if (state.mode === 'redirect') return new Response(null, {status: 302});
    if (state.mode === 'invalid-json') return new Response('oops');
    if (state.mode === 'inactive') return Response.json({ok: true, active: false});
    if (state.revoked.has(claims.sid)) return Response.json({ok: false}, {status: 401});
    return Response.json({ok: true, active: true});
  };
  t.after(() => { db.close(); global.fetch = previousFetch; });
  const env = {BOARD_DB: db, BOARD_IDENTITY_SECRET: secret, REVIEW_REQUIRED: 'false'};
  async function request(method, route, data, identity = null, options = {}) {
    const headers = {'Origin': origin, ...(data === undefined ? {} : {'Content-Type': 'application/json'}), ...(identity ? {Authorization: `Bearer ${identity.ticket}`} : {}), ...options.headers};
    const input = new Request(`https://sundollworld.com${route}`, {method, headers, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
    const response = await worker.fetch(input, {...env, ...options.env});
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text};
  }
  async function message(identity = account('甲'), body = '留言', options = {}) {
    const result = await request('POST', '/api/messages', {body, requestId: uuid(), ...options.data}, identity, {headers: {'CF-Connecting-IP': uuid()}, ...options});
    assert.equal(result.status, options.expectedStatus || 201, result.text);
    return result.body.message;
  }
  async function reply(parentId, identity = account('乙'), body = '回复', extra = {}) {
    const result = await request('POST', `/api/messages/${parentId}/replies`, {body, requestId: uuid(), ...extra}, identity, {headers: {'CF-Connecting-IP': uuid()}});
    assert.equal(result.status, 201, result.text);
    return result.body.reply;
  }
  return {db, request, message, reply, state, env};
}

test('incremental migration is repeatable and preserves anonymous contents, credentials and likes', () => {
  const db = new D1Fixture(schema.slice(0, schema.indexOf('CREATE TABLE IF NOT EXISTS board_authors')));
  try {
    const id = uuid(), rid = uuid();
    db.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(id, uuid(), '甲', '旧留言', '2026-10-01T00:00:00.000Z', 'published');
    db.db.prepare('INSERT INTO message_owners VALUES (?, ?, ?)').run(id, 'message', hash('old-token'));
    db.db.prepare('INSERT INTO message_likes VALUES (?, ?, ?)').run(id, hash('old-visitor'), '2026-10-01T00:00:00.000Z');
    db.db.prepare('INSERT INTO message_replies VALUES (?, ?, ?, ?, ?, ?, ?)').run(rid, uuid(), id, '乙', '旧回复', '2026-10-01T00:00:01.000Z', 'published');
    db.db.prepare('INSERT INTO reply_likes VALUES (?, ?, ?)').run(rid, hash('other-visitor'), '2026-10-01T00:00:01.000Z');
    const before = ['messages', 'message_replies', 'message_owners', 'message_likes', 'reply_likes'].map(table => db.rows(`SELECT * FROM ${table}`));
    db.db.exec(migration); db.db.exec(migration); db.db.exec(schema);
    assert.deepEqual(['messages', 'message_replies', 'message_owners', 'message_likes', 'reply_likes'].map(table => db.rows(`SELECT * FROM ${table}`)), before);
    assert.equal(db.count('board_authors'), 0);
    assert.equal(db.count('board_message_likes'), 0);
    assert.equal(db.count('board_reply_likes'), 0);
    assert.equal(db.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
    assert.deepEqual(db.rows('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});

test('all write routes require a verified account and cannot trust client identity fields', async t => {
  const f = await fixture(t), id = uuid(), rid = uuid();
  for (const [method, route, data] of [
    ['POST', '/api/messages', {nickname: '甲', body: '假身份', requestId: uuid()}],
    ['POST', `/api/messages/${id}/replies`, {nickname: '甲', body: '假身份'}],
    ['POST', `/api/messages/${id}/like`, {visitorId: uuid(), liked: true}],
    ['POST', `/api/messages/${id}/replies/${rid}/like`, {visitorId: uuid(), liked: true}],
    ['DELETE', `/api/messages/${id}`, {deleteToken: uuid()}],
    ['DELETE', `/api/messages/${id}/replies/${rid}`, {deleteToken: uuid()}],
  ]) assert.equal((await f.request(method, route, data)).status, 401);
  assert.equal(f.state.calls, 0); assert.equal(f.db.count('messages'), 0);
  const author = account('甲');
  const created = await f.message(author, '真实身份', {data: {nickname: '伪造者', accountId: 'not-real', visitorId: uuid(), deleteToken: uuid()}});
  assert.equal(created.nickname, '甲'); assert.equal(created.authorId, author.publicId); assert.equal(created.owned, true);
  assert.equal(f.db.rows('SELECT account_key FROM board_authors')[0].account_key, author.sub);
  assert.equal(f.db.count('message_owners'), 0);
});

test('actual Python account bridge tickets interoperate with the Worker without reading real credentials', async t => {
  const f = await fixture(t);
  const code = `import json, sys, time
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from server import site_identity
data = json.load(sys.stdin)
class SyntheticService:
    clock = staticmethod(time.time)
    def session(self, token=None, *, digest=None):
        if token == 'synthetic-fixture-session' or digest == site_identity.token_hash('synthetic-fixture-session'):
            return {'accountId': 'synthetic-only-account', 'name': '跨端昵称😀'}
        return None
service = SyntheticService()
with patch.object(site_identity, 'key_for', return_value=data['secret'].encode()):
    result = site_identity.issue(service, 'synthetic-fixture-session')
    claims = site_identity.validate(service, result['ticket'])
print(json.dumps({'ticket': result['ticket'], 'claims': claims}))
`;
  const result = spawnSync(process.env.SUNDOLL_PYTHON || 'python3', ['-c', code, path.resolve(__dirname, '../../程序包/主程序')], {input: JSON.stringify({secret}), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(result.stdout);
  const identity = {...generated.claims, ticket: generated.ticket};
  const row = await f.message(identity, '跨语言签名验证');
  assert.equal(row.nickname, '跨端昵称😀');
  assert.equal(row.authorId, generated.claims.publicId);
  assert.equal(row.owned, true);
  assert.equal(f.state.calls, 1);
});

test('JWT signature, schema, algorithm, issuer, audience, time and session digest fail closed', async t => {
  const f = await fixture(t), a = account('甲');
  const invalid = [
    {...a, ticket: `${a.ticket.slice(0, -6)}aaaaaa`},
    {...a, ticket: ticket(a, {alg: 'none', typ: 'JWT'})},
    {...a, ticket: ticket(a, {alg: 'HS256', typ: 'JWT', crit: ['unknown']})},
    account('甲', 'one', {iss: 'https://evil.invalid'}), account('甲', 'one', {aud: 'other'}),
    account('甲', 'one', {v: 2}), account('甲', 'one', {exp: a.iat - 1}),
    account('甲', 'one', {exp: a.iat + 301}), account('甲', 'one', {iat: a.iat + 60, exp: a.iat + 90}),
    account('甲', 'one', {sid: null}), account('甲', 'one', {sub: [a.sub]}),
    account('甲', 'one', {publicId: a.sub}), account('甲', 'one', {nickname: ' '}),
    account('甲', 'one', {nickname: '\ud800'}), account('甲', 'one', {nickname: '长'.repeat(25)}),
    {...a, ticket: 'a.b.c'}, {...a, ticket: 'x'.repeat(4097)},
  ];
  for (const identity of invalid) assert.equal((await f.request('POST', '/api/messages', {body: '坏票'}, identity)).status, 401);
  assert.equal(f.state.calls, 0); assert.equal(f.db.count('rate_limits'), 0);
  assert.equal((await f.request('POST', '/api/messages', {body: '缺配置'}, a, {env: {BOARD_IDENTITY_SECRET: ''}})).status, 503);
  assert.equal((await f.request('GET', '/api/messages', undefined, null, {env: {BOARD_IDENTITY_SECRET: ''}})).status, 200);
});

test('revoked sessions reject every write, while public GET never contacts the account bridge', async t => {
  const f = await fixture(t), a = account('甲'), m = await f.message(a), r = await f.reply(m.id, a);
  f.state.revoked.add(a.sid);
  const before = f.db.snapshot();
  for (const [method, route, data] of [
    ['POST', '/api/messages', {body: 'new'}], ['POST', `/api/messages/${m.id}/replies`, {body: 'new'}],
    ['POST', `/api/messages/${m.id}/like`, {liked: true}], ['POST', `/api/messages/${m.id}/replies/${r.id}/like`, {liked: true}],
    ['DELETE', `/api/messages/${m.id}`, {}], ['DELETE', `/api/messages/${m.id}/replies/${r.id}`, {}],
  ]) assert.equal((await f.request(method, route, data, a)).status, 401);
  assert.equal(f.db.snapshot(), before);
  const calls = f.state.calls;
  assert.equal((await f.request('GET', '/api/messages', undefined, a)).status, 200);
  assert.equal((await f.request('GET', `/api/messages/${m.id}/replies`)).status, 200);
  assert.equal(f.state.calls, calls);
});

test('offline, redirect and invalid session bridge responses cannot save or delete', async t => {
  const f = await fixture(t), a = account('甲'), m = await f.message(a), before = f.db.snapshot();
  for (const mode of ['offline', 'redirect', 'invalid-json', 'inactive']) {
    f.state.mode = mode;
    const write = await f.request('POST', '/api/messages', {body: 'blocked'}, a);
    assert.equal(write.status, 503); assert.equal(write.headers.get('Retry-After'), '3');
    assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {}, a)).status, 503);
    assert.equal(f.db.snapshot(), before);
    assert.equal((await f.request('GET', '/api/messages')).status, 200);
  }
});

test('bridge timeout aborts and leaves all rows unchanged', async t => {
  const f = await fixture(t), a = account('甲'); f.state.mode = 'timeout';
  const started = Date.now();
  assert.equal((await f.request('POST', '/api/messages', {body: 'timeout'}, a)).status, 503);
  assert.ok(Date.now() - started < 5500);
  assert.equal(f.db.count('messages'), 0); assert.equal(f.db.count('rate_limits'), 0);
});

test('cross-device author ownership is stable and public responses expose no private claims', async t => {
  const f = await fixture(t), one = account('甲', 'one'), two = account('甲', 'two'), other = account('乙');
  const m = await f.message(one), r = await f.reply(m.id, one);
  const own = await f.request('GET', '/api/messages', undefined, two);
  const foreign = await f.request('GET', '/api/messages', undefined, other);
  const anonymous = await f.request('GET', '/api/messages');
  assert.equal(own.body.messages[0].owned, true); assert.equal(foreign.body.messages[0].owned, false); assert.equal(anonymous.body.messages[0].owned, false);
  for (const result of [own, foreign, anonymous, await f.request('GET', `/api/messages/${m.id}/replies`, undefined, two)]) {
    for (const privateValue of [one.sub, one.sid, two.sid, one.ticket]) assert.ok(!result.text.includes(privateValue));
    for (const key of ['account_key', 'sid', 'email', 'requestId', 'deleteToken', 'token_hash']) assert.ok(!result.text.includes(`"${key}"`));
  }
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}/replies/${r.id}`, {}, two)).status, 200);
  const deletion = await f.request('DELETE', `/api/messages/${m.id}`, {}, two);
  assert.equal(deletion.status, 200); assert.equal(deletion.body.alreadyDeleted, false);
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {}, two)).body.alreadyDeleted, true);
});

test('same nickname, known visitor ID, old delete token and request ID cannot claim anonymous or other account records', async t => {
  const f = await fixture(t), a = account('甲'), other = account('甲', 'two', {sub: hash('different-account'), publicId: `board_${hash('different-public').slice(0,32)}`});
  const m = await f.message(a);
  const legacy = uuid(), legacyRequest = uuid(), oldToken = uuid();
  f.db.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(legacy, legacyRequest, '甲', '旧留言', '2026-10-01T00:00:00.000Z', 'published');
  f.db.db.prepare('INSERT INTO message_owners VALUES (?, ?, ?)').run(legacy, 'message', hash(oldToken));
  const before = f.db.snapshot();
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {deleteToken: oldToken}, other)).status, 403);
  assert.equal((await f.request('DELETE', `/api/messages/${legacy}`, {deleteToken: oldToken, nickname: '甲'}, a)).status, 403);
  assert.equal((await f.request('POST', '/api/messages', {body: '旧留言', nickname: '甲', requestId: legacyRequest}, a)).status, 409);
  assert.equal(f.db.snapshot(), before);
  const rows = (await f.request('GET', '/api/messages', undefined, a)).body.messages;
  assert.equal(rows.find(row => row.id === legacy).authorId, null); assert.equal(rows.find(row => row.id === legacy).owned, false);
});

test('submission retries are account-bound and survive nickname changes, response loss and concurrent replay', async t => {
  const f = await fixture(t), a = account('甲'), requestId = uuid();
  const data = {body: '原文', requestId};
  const first = await f.request('POST', '/api/messages', data, a);
  assert.equal(first.status, 201);
  const renamed = account('甲', 'two', {nickname: '新昵称'});
  const replay = await f.request('POST', '/api/messages', data, renamed);
  assert.equal(replay.status, 200); assert.equal(replay.body.message.id, first.body.message.id); assert.equal(replay.body.message.nickname, '甲');
  assert.equal((await f.request('POST', '/api/messages', {...data, body: '改文'}, a)).status, 409);
  assert.equal((await f.request('POST', '/api/messages', data, account('乙'))).status, 409);
  assert.equal((await f.request('POST', `/api/messages/${first.body.message.id}/replies`, data, a)).status, 409);
  const concurrentId = uuid();
  const results = await Promise.all(Array.from({length: 24}, () => f.request('POST', '/api/messages', {body: '并发', requestId: concurrentId}, a, {headers: {'CF-Connecting-IP': 'concurrent-fixture'}})));
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal(results.filter(result => result.status === 200).length, 23);
  assert.equal(new Set(results.map(result => result.body.message.id)).size, 1);
  assert.equal(f.db.count('messages'), 2); assert.equal(f.db.count('board_authors'), 2);
});

test('new reply targets must be published and in the same parent; stored target names survive target deletion', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙'), m = await f.message(a), other = await f.message(b);
  const target = await f.reply(m.id, b, '目标'), rid = uuid();
  assert.equal((await f.request('POST', `/api/messages/${other.id}/replies`, {body: '跨父', targetReplyId: target.id}, a)).status, 404);
  assert.equal((await f.request('POST', '/api/messages', {body: '错误对象', targetReplyId: target.id}, a)).status, 400);
  const answer = await f.reply(m.id, a, '回答', {requestId: rid, targetReplyId: target.id, targetNickname: '伪造'});
  assert.equal(answer.targetNickname, '乙'); assert.equal(answer.targetReplyId, target.id);
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}/replies/${target.id}`, {}, b)).status, 200);
  const replay = await f.request('POST', `/api/messages/${m.id}/replies`, {body: '回答', requestId: rid, targetReplyId: target.id}, account('甲', 'two'));
  assert.equal(replay.status, 200); assert.equal(replay.body.reply.targetNickname, '乙');
  const list = (await f.request('GET', `/api/messages/${m.id}/replies`)).body.replies;
  assert.equal(list.length, 1); assert.equal(list[0].targetNickname, '乙');
  assert.equal((await f.request('POST', `/api/messages/${m.id}/replies`, {body: '新答', targetReplyId: target.id}, a)).status, 404);
});

test('parent or reply target disappearing before save cannot create orphan content, author rows or rate slots', async t => {
  const f = await fixture(t), a = account('甲'), m = await f.message(a), r = await f.reply(m.id, a);
  const requestId = uuid();
  f.db.beforeBatch = db => db.prepare('DELETE FROM message_replies WHERE id=?').run(r.id);
  const response = await f.request('POST', `/api/messages/${m.id}/replies`, {body: '晚答', requestId, targetReplyId: r.id}, a, {headers: {'CF-Connecting-IP': 'target-race'}});
  assert.equal(response.status, 404); assert.equal(response.body.error.code, 'REPLY_NOT_FOUND');
  assert.equal(f.db.rows('SELECT * FROM rate_limits WHERE request_id=?', requestId).length, 0);
  const secondId = uuid();
  f.db.beforeBatch = db => db.prepare('DELETE FROM messages WHERE id=?').run(m.id);
  assert.equal((await f.request('POST', `/api/messages/${m.id}/replies`, {body: '晚答', requestId: secondId}, a, {headers: {'CF-Connecting-IP': 'parent-race'}})).status, 404);
  assert.equal(f.db.rows('SELECT * FROM rate_limits WHERE request_id=?', secondId).length, 0);
  assert.equal(f.db.count('message_replies'), 0);
});

test('concurrent account likes are unique across devices and visitor fields do not add votes', async t => {
  const f = await fixture(t), a = account('甲'), one = account('乙', 'one'), two = account('乙', 'two'), m = await f.message(a), r = await f.reply(m.id, a);
  for (const route of [`/api/messages/${m.id}/like`, `/api/messages/${m.id}/replies/${r.id}/like`]) {
    const results = await Promise.all(Array.from({length: 30}, (_, index) => f.request('POST', route, {liked: true, visitorId: uuid(), accountId: uuid()}, index % 2 ? one : two)));
    for (const result of results) { assert.equal(result.status, 200); assert.equal(result.body.likeCount, 1); assert.equal(result.body.liked, true); }
    assert.equal((await f.request('POST', route, {liked: true}, account('丙'))).body.likeCount, 2);
    assert.equal((await f.request('POST', route, {liked: false}, two)).body.likeCount, 1);
    assert.equal((await f.request('POST', route, {liked: false}, one)).body.likeCount, 1);
    assert.equal((await f.request('POST', route, {liked: 'true'}, one)).status, 400);
  }
  assert.equal(f.db.count('board_message_likes'), 1); assert.equal(f.db.count('board_reply_likes'), 1);
  assert.equal(f.db.count('message_likes'), 0); assert.equal(f.db.count('reply_likes'), 0);
  assert.equal((await f.request('GET', '/api/messages', undefined, one)).body.messages[0].liked, false);
  assert.equal((await f.request('GET', '/api/messages', undefined, account('丙'))).body.messages[0].liked, true);
  const another = await f.message(a);
  assert.equal((await f.request('POST', `/api/messages/${another.id}/replies/${r.id}/like`, {liked: true}, one)).status, 404);
});

test('legacy likes remain visible without being claimed or removed by an account', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙'), m = await f.message(a), r = await f.reply(m.id, a);
  f.db.db.prepare('INSERT INTO message_likes VALUES (?, ?, ?)').run(m.id, hash('legacy'), new Date().toISOString());
  f.db.db.prepare('INSERT INTO reply_likes VALUES (?, ?, ?)').run(r.id, hash('legacy'), new Date().toISOString());
  for (const route of [`/api/messages/${m.id}/like`, `/api/messages/${m.id}/replies/${r.id}/like`]) {
    assert.equal((await f.request('POST', route, {liked: true}, b)).body.likeCount, 2);
    assert.equal((await f.request('POST', route, {liked: false}, b)).body.likeCount, 1);
  }
  assert.equal((await f.request('GET', '/api/messages?visitorId=ignored', undefined, b)).body.messages[0].liked, false);
  assert.equal(f.db.count('message_likes'), 1); assert.equal(f.db.count('reply_likes'), 1);
});

test('failed like count reads roll back both account likes and unlikes', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙'), m = await f.message(a), r = await f.reply(m.id, a);
  for (const route of [`/api/messages/${m.id}/like`, `/api/messages/${m.id}/replies/${r.id}/like`]) {
    let before = f.db.snapshot(); f.db.failAt = 1;
    assert.equal((await f.request('POST', route, {liked: true}, b)).status, 503);
    assert.equal(f.db.snapshot(), before);
    assert.equal((await f.request('POST', route, {liked: true}, b)).body.likeCount, 1);
    before = f.db.snapshot(); f.db.failAt = 1;
    assert.equal((await f.request('POST', route, {liked: false}, b)).status, 503);
    assert.equal(f.db.snapshot(), before);
    assert.equal((await f.request('POST', route, {liked: false}, b)).body.likeCount, 0);
  }
});

test('wrong reply parent and foreign deletion leave credentials, authors, replies and rates untouched', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙'), m = await f.message(a), other = await f.message(b), r = await f.reply(m.id, a);
  const before = f.db.snapshot();
  assert.equal((await f.request('DELETE', `/api/messages/${other.id}/replies/${r.id}`, {}, a)).status, 404);
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}/replies/${r.id}`, {}, b)).status, 403);
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {}, b)).status, 403);
  assert.equal(f.db.snapshot(), before);
});

test('deletion atomically clears subtree accounts, legacy credentials, targets, likes and rate slots', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙'), m = await f.message(a), other = await f.message(b);
  const r = await f.reply(m.id, b), answer = await f.reply(m.id, a, '回答', {targetReplyId: r.id});
  f.db.db.prepare('INSERT INTO message_owners VALUES (?, ?, ?)').run(r.id, 'reply', hash('legacy-credential'));
  for (const route of [`/api/messages/${m.id}/like`, `/api/messages/${m.id}/replies/${r.id}/like`]) assert.equal((await f.request('POST', route, {liked: true}, b)).status, 200);
  f.db.failAt = 4;
  const before = f.db.snapshot();
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {}, a)).status, 503);
  assert.equal(f.db.snapshot(), before);
  assert.equal((await f.request('DELETE', `/api/messages/${m.id}`, {}, account('甲', 'two'))).status, 200);
  assert.equal(f.db.count('messages'), 1); assert.equal(f.db.rows('SELECT id FROM messages')[0].id, other.id);
  assert.equal(f.db.count('message_replies'), 0); assert.equal(f.db.count('board_authors'), 1);
  assert.equal(f.db.count('board_message_likes'), 0); assert.equal(f.db.count('board_reply_likes'), 0);
  assert.equal(f.db.count('reply_targets'), 0); assert.equal(f.db.count('message_owners'), 0); assert.equal(f.db.count('rate_limits'), 1);
  assert.deepEqual(f.db.rows('PRAGMA foreign_key_check'), []);
});

test('author and rate reservation roll back with a failed content or author transaction', async t => {
  const f = await fixture(t), a = account('甲');
  for (const failAt of [2, 3, 5]) {
    const requestId = uuid(), before = f.db.snapshot(); f.db.failAt = failAt;
    const data = {body: '事务', requestId};
    assert.equal((await f.request('POST', '/api/messages', data, a, {headers: {'CF-Connecting-IP': 'rollback'}})).status, 503);
    assert.equal(f.db.snapshot(), before);
    const retry = await f.request('POST', '/api/messages', data, a, {headers: {'CF-Connecting-IP': uuid()}});
    assert.equal(retry.status, 201); assert.equal(retry.body.message.owned, true);
  }
});

test('shared IP rate limit and pending moderation remain independent of account ownership', async t => {
  const f = await fixture(t), a = account('甲'), b = account('乙');
  const first = await f.request('POST', '/api/messages', {body: '第一'}, a, {headers: {'CF-Connecting-IP': 'same-ip'}});
  assert.equal(first.status, 201);
  const second = await f.request('POST', `/api/messages/${first.body.message.id}/replies`, {body: '第二'}, b, {headers: {'CF-Connecting-IP': 'same-ip'}});
  assert.equal(second.status, 429); assert.ok(Number(second.headers.get('Retry-After')) > 0);
  const pending = await f.message(a, '待审核', {env: {REVIEW_REQUIRED: 'true'}});
  assert.equal(pending.status, 'pending');
  assert.equal((await f.request('GET', '/api/messages')).body.messages.length, 1);
  assert.equal((await f.request('GET', `/api/messages/${pending.id}/replies`)).status, 404);
  assert.equal((await f.request('POST', `/api/messages/${pending.id}/like`, {liked: true}, a)).status, 404);
  assert.equal((await f.request('DELETE', `/api/messages/${pending.id}`, {}, account('甲', 'two'))).status, 200);
});

test('message and reply cursor pagination preserve order, ties, ownership and moderation', async t => {
  const f = await fixture(t), a = account('甲'), timestamp = '2026-10-01T00:00:00.000Z';
  const insertMessage = f.db.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  const ids = Array.from({length: 45}, uuid);
  for (const id of ids) insertMessage.run(id, uuid(), '旧昵称', '旧留言', timestamp, 'published');
  insertMessage.run(uuid(), uuid(), '审核', 'hidden', timestamp, 'pending');
  let cursor = null, all = [];
  do {
    const response = await f.request('GET', `/api/messages${cursor ? `?cursor=${cursor}` : ''}`, undefined, a);
    assert.equal(response.status, 200); assert.ok(response.body.messages.length <= 20);
    all.push(...response.body.messages.map(row => row.id)); cursor = response.body.nextCursor;
  } while (cursor);
  assert.deepEqual(all, ids.toSorted().reverse());
  const parent = ids[0], replyIds = Array.from({length: 45}, uuid);
  for (const id of replyIds) f.db.db.prepare('INSERT INTO message_replies VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, uuid(), parent, '回复者', '回复', timestamp, 'published');
  f.db.db.prepare('INSERT INTO message_replies VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(), uuid(), parent, '审核', 'hidden', timestamp, 'pending');
  cursor = null; all = [];
  do {
    const response = await f.request('GET', `/api/messages/${parent}/replies${cursor ? `?cursor=${cursor}` : ''}`, undefined, a);
    assert.equal(response.status, 200); assert.ok(response.body.replies.length <= 20);
    all.push(...response.body.replies.map(row => row.id)); cursor = response.body.nextCursor;
  } while (cursor);
  assert.deepEqual(all, replyIds.toSorted());
  for (const query of ['?cursor=', '?cursor=bad', '?cursor=a&cursor=b']) assert.equal((await f.request('GET', `/api/messages${query}`)).status, 400);
});

test('text, body limit, CORS authorization preflight and method restrictions remain enforced', async t => {
  const f = await fixture(t), a = account('甲');
  for (const body of ['', 'x'.repeat(501), '\u0000', '\ud800']) assert.equal((await f.request('POST', '/api/messages', {body}, a)).status, 400);
  assert.equal((await f.request('POST', '/api/messages', {body: 'x'.repeat(9000)}, a)).status, 413);
  assert.equal((await f.request('POST', '/api/messages', {body: 'ok'}, a, {headers: {'Content-Type': 'text/plain'}})).status, 415);
  const preflight = await f.request('OPTIONS', '/api/messages', undefined, null, {headers: {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization'}});
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await f.request('OPTIONS', '/api/messages', undefined, null, {headers: {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-account-id'}})).status, 403);
  assert.equal((await f.request('GET', '/api/messages', undefined, null, {headers: {Origin: 'https://evil.invalid'}})).status, 403);
  assert.equal((await f.request('PUT', '/api/messages', {}, a)).status, 405);
  assert.equal((await f.request('GET', `/api/messages/${uuid()}/like`)).status, 405);
});
