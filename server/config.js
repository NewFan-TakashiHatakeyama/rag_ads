/**
 * 設定パラメータ(DD-001 4.3節 表6)。
 * 本番はSSM Parameter Store(/rag_ads/{env}/)だが、ローカルPoCでは data/params.json。
 * Lambdaの「起動時ロード・5分キャッシュ」に合わせ、ファイル変更は5分以内に反映される。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARAMS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'params.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_PARAMS = {
  enabled: true,
  'weights.rel': 0.6,
  'weights.bid': 0.2,
  'weights.link': 0.2,
  theta_rel: 0.5,
  max_slots: 3,
  candidate_topk: 10,
  max_per_advertiser: 1,
  'lead.min_chars': 20,
  'lead.max_chars': 60,
  'lead.model_id': 'local-mock-haiku',
  'lead.enabled': true,
  // 注: この定型文(19字)はDD-001表6の規定値であり、同表のlead.min_chars=20を下回る(設計書内の
  // 既知の不整合)。文字数検証(7.3節)はLLM生成リードのみが対象で、フォールバック文は検証対象外。
  'lead.fallback_text': 'ご質問に関連するサービスのご案内です。',
  'sampling.content_check': 0.1,
};

let cache = null;
let cacheAt = 0;

function loadFile() {
  try {
    if (fs.existsSync(PARAMS_FILE)) {
      return { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')) };
    }
  } catch { /* 破損時はデフォルトへフォールバック */ }
  return { ...DEFAULT_PARAMS };
}

export function getParams() {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_TTL_MS) {
    cache = loadFile();
    cacheAt = now;
  }
  return cache;
}

/** テスト・運用切替用: 即時反映で上書きする */
export function setParams(patch, { persist = false } = {}) {
  cache = { ...getParams(), ...patch };
  cacheAt = Date.now();
  if (persist) {
    fs.mkdirSync(path.dirname(PARAMS_FILE), { recursive: true });
    fs.writeFileSync(PARAMS_FILE, JSON.stringify(cache, null, 2));
  }
  return cache;
}

export function resetParams() {
  cache = { ...DEFAULT_PARAMS };
  cacheAt = Date.now();
}
