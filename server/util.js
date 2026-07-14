import crypto from 'node:crypto';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 現在時刻のISO8601(UTC)文字列 */
export function nowIso() {
  return new Date().toISOString();
}

/** JSTの暦日 (YYYY-MM-DD)。予算・日次統計のキーはJST日付で採番する(DD-001 9.3節) */
export function jstDate(d = new Date()) {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JSTでn日前の日付 (YYYY-MM-DD) */
export function jstDateOffset(days, base = new Date()) {
  return jstDate(new Date(base.getTime() + days * 86400000));
}

/** SHA-256ダイジェスト(hex)。質問原文は保存せずダイジェストのみ記録する(BD-001 10.4節) */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** ULID風の時系列ソート可能ID(広告IDに使用。DD-001 5.1節) */
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ULID_CHARS[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) rand += ULID_CHARS[bytes[i] % 32];
  return time + rand;
}

/** 回答ページID(既存採番のハッシュ形式を踏襲。DD-001 1.2節) */
export function newPageId(question) {
  return sha256(question + '|' + Date.now() + '|' + crypto.randomBytes(8).toString('hex')).slice(0, 24);
}

export function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** スコア・関連度の格納用丸め(小数4桁) */
export function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 構造化ログ(1イベント1行JSON。DD-001 10.1節)。質問原文・個人情報は出力しない */
export function log(level, svc, event, fields = {}) {
  const rec = { ts: new Date().toISOString(), level, svc, env: 'dev', event, ...fields };
  const line = JSON.stringify(rec);
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}
