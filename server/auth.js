/**
 * 認証(BD-001 8.2節)。本番はCognitoユーザープール+API GatewayのJWTオーソライザだが、
 * ローカルPoCでは同一の認可モデル(advertiser/adminグループ+リソース所有判定)を
 * 持つ簡易セッショントークンで代替する。
 */
import crypto from 'node:crypto';
import { tables } from './store.js';
import { randomToken, nowIso } from './util.js';

const sessions = new Map(); // token -> { email, role, advertiserId, name, createdAt }
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8時間で失効(本番はCognito JWTの有効期限に相当)

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}

export function createUser({ email, password, role, advertiserId, name }) {
  const salt = crypto.randomBytes(8).toString('hex');
  tables.users.put({
    PK: `USER#${email}`, SK: 'META',
    email, role, advertiserId: advertiserId ?? null, name,
    salt, passwordHash: hashPassword(password, salt),
    createdAt: nowIso(),
  });
}

export function login(email, password) {
  const u = tables.users.get(`USER#${email}`, 'META');
  if (!u) return null;
  const hash = hashPassword(String(password ?? ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.passwordHash))) return null;
  const token = randomToken();
  sessions.set(token, { email: u.email, role: u.role, advertiserId: u.advertiserId, name: u.name, createdAt: nowIso() });
  return { token, user: publicUser(sessions.get(token)) };
}

export function logout(token) {
  sessions.delete(token);
}

/** Authorizationヘッダからセッションを解決(未認証・失効はnull) */
export function authenticate(req) {
  const h = req.headers['authorization'] ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() - Date.parse(s.createdAt) > SESSION_TTL_MS) {
    sessions.delete(m[1]); // 失効(API-4011として扱われる)
    return null;
  }
  return s;
}

export function publicUser(s) {
  return { email: s.email, role: s.role, advertiserId: s.advertiserId, name: s.name };
}
