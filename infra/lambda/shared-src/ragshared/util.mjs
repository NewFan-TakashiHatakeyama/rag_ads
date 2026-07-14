/** 共通ユーティリティ(ローカルPoC server/util.js と同一契約) */
import crypto from 'node:crypto';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const nowIso = () => new Date().toISOString();

/** JSTの暦日(予算・統計のキーはJST日付で採番。DD-001 9.3節) */
export const jstDate = (d = new Date()) =>
  new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);

export const jstDateOffset = (days, base = new Date()) =>
  jstDate(new Date(base.getTime() + days * 86400000));

/** YYYY-MM-DD → 数値(S3 Vectorsの数値メタデータフィルタ用) */
export const dateToNum = (isoDate) => Number(String(isoDate).replaceAll('-', ''));

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) { time = ULID_CHARS[t % 32] + time; t = Math.floor(t / 32); }
  let rand = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) rand += ULID_CHARS[bytes[i] % 32];
  return time + rand;
}

export const round4 = (n) => Math.round(n * 10000) / 10000;

/** 構造化ログ(1イベント1行JSON。DD-001 10.1節)。質問原文・個人情報は出力しない */
export function log(level, svc, event, fields = {}) {
  const rec = { ts: new Date().toISOString(), level, svc, env: process.env.RAG_Ads_ENV ?? 'dev', event, ...fields };
  const line = JSON.stringify(rec);
  if (level === 'ERROR') console.error(line); else console.log(line);
}

/** LLM応答からJSONを抽出(```json フェンス・前後テキストを許容) */
export function extractJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON not found in LLM output');
  return JSON.parse(body.slice(start, end + 1));
}
