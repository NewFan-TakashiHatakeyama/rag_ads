/**
 * 設定パラメータ(DD-001 4.3節 表6)。SSM Parameter Storeから取得し5分キャッシュ。
 * ローカルPoC server/config.js と同一契約(値は文字列→適切な型に変換して返す)。
 */
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const SSM_PREFIX = process.env.RAG_Ads_SSM_PREFIX;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ssm = new SSMClient({});

const NUMERIC = new Set([
  'weights.rel', 'weights.bid', 'weights.link', 'theta_rel', 'sampling.content_check',
  // 紐づけ候補(S-03)用。配信のtheta_rel(質問↔広告)とは分布が異なるため別管理
  'link.theta_rel', 'link.citation_weight',
]);
const INTEGER = new Set([
  'max_slots', 'candidate_topk', 'max_per_advertiser', 'lead.min_chars', 'lead.max_chars',
  'link.recency_days',
]);
const BOOLEAN = new Set(['enabled', 'lead.enabled']);

let cache = null;
let cacheAt = 0;

function coerce(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (BOOLEAN.has(k)) out[k] = v === 'true';
    else if (INTEGER.has(k)) out[k] = parseInt(v, 10);
    else if (NUMERIC.has(k)) out[k] = parseFloat(v);
    else out[k] = v;
  }
  return out;
}

async function loadFromSsm() {
  const raw = {};
  let nextToken;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_PREFIX}/`, Recursive: true, NextToken: nextToken,
    }));
    for (const p of r.Parameters ?? []) raw[p.Name.slice(SSM_PREFIX.length + 1)] = p.Value;
    nextToken = r.NextToken;
  } while (nextToken);
  return coerce(raw);
}

/** パラメータ取得(5分キャッシュ)。Lambda実行環境の再利用でキャッシュが効く */
export async function getParams() {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_TTL_MS) {
    cache = await loadFromSsm();
    cacheAt = now;
  }
  return cache;
}

/** キャッシュを強制無効化(パラメータ更新直後の反映用) */
export function invalidateParamsCache() { cache = null; }
