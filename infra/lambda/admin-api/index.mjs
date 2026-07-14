/**
 * rag-ads_admin-api: 広告管理API(DD-001 6.3節)。
 *
 * 現段階(フェーズ1: API雛形。BD-001 11.3 W1-W2「API雛形」相当):
 *  - 実装済み: GET/PUT /v1/params(表6パラメータの参照・検証付き更新。段階公開のフラグ操作に使用)
 *  - 雛形    : 広告CRUD・審査・紐づけ・レポート・コンテンツ詳細(501を返す)
 *    → フェーズ1.5でローカル実装(server/adminApi.js。テスト48件で検証済み)から移植する。
 *
 * 認可: API GatewayのJWTオーソライザ通過後、cognito:groupsでadvertiser/adminを判定(11.1節)。
 */
import { SSMClient, GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const SSM_PREFIX = process.env.RAG_Ads_SSM_PREFIX; // /rag_ads/{env}
const ssm = new SSMClient({});

const nowIso = () => new Date().toISOString();
const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: nowIso(), level, svc: 'admin_api', event, ...fields }));

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
const apiError = (statusCode, code, message, details) =>
  json(statusCode, { error: { code, message, ...(details ? { details } : {}) } });

/** パラメータ検証スキーマ(DD-001 表6。ローカル実装のPARAM_RULESと同一) */
const PARAM_RULES = {
  enabled: { type: 'boolean' },
  'weights.rel': { type: 'number', min: 0, max: 1 },
  'weights.bid': { type: 'number', min: 0, max: 1 },
  'weights.link': { type: 'number', min: 0, max: 1 },
  theta_rel: { type: 'number', min: 0, max: 1 },
  max_slots: { type: 'int', min: 1, max: 10 },
  candidate_topk: { type: 'int', min: 1, max: 50 },
  max_per_advertiser: { type: 'int', min: 1, max: 10 },
  'lead.min_chars': { type: 'int', min: 1, max: 200 },
  'lead.max_chars': { type: 'int', min: 1, max: 200 },
  'lead.model_id': { type: 'string', max: 200 },
  'lead.enabled': { type: 'boolean' },
  'lead.fallback_text': { type: 'string', min: 1, max: 100 },
  'sampling.content_check': { type: 'number', min: 0, max: 1 },
};

function groupsOf(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw = claims['cognito:groups'] ?? '';
  // HTTP API JWTオーソライザは配列を "[a b]" 形式の文字列で渡すことがある
  return String(raw).replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
}

async function getParams() {
  const out = {};
  let nextToken;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_PREFIX}/`, Recursive: true, NextToken: nextToken,
    }));
    for (const p of r.Parameters ?? []) {
      const key = p.Name.slice(SSM_PREFIX.length + 1);
      out[key] = p.Value;
    }
    nextToken = r.NextToken;
  } while (nextToken);
  return out;
}

function validateParamPatch(patch, current) {
  const errors = [];
  for (const [key, value] of Object.entries(patch)) {
    const rule = PARAM_RULES[key];
    if (!rule) { errors.push({ field: key, reason: `${key}：定義されていないパラメータです` }); continue; }
    const isNum = typeof value === 'number' && Number.isFinite(value);
    if (rule.type === 'boolean' && typeof value !== 'boolean') errors.push({ field: key, reason: `${key}：true/falseで指定してください` });
    else if (rule.type === 'number' && !isNum) errors.push({ field: key, reason: `${key}：数値で指定してください` });
    else if (rule.type === 'int' && (!isNum || !Number.isInteger(value))) errors.push({ field: key, reason: `${key}：整数で指定してください` });
    else if (rule.type === 'string' && typeof value !== 'string') errors.push({ field: key, reason: `${key}：文字列で指定してください` });
    else if ((rule.type === 'number' || rule.type === 'int') && (value < rule.min || value > rule.max)) errors.push({ field: key, reason: `${key}：${rule.min}〜${rule.max}の範囲で指定してください` });
    else if (rule.type === 'string' && ((rule.min && value.length < rule.min) || (rule.max && value.length > rule.max))) errors.push({ field: key, reason: `${key}：${rule.min ?? 0}〜${rule.max}文字で指定してください` });
  }
  const merged = { ...current, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) };
  if (Number(merged['lead.min_chars']) > Number(merged['lead.max_chars'])) {
    errors.push({ field: 'lead.min_chars', reason: 'lead.min_chars：lead.max_chars以下を指定してください' });
  }
  return errors;
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '';
  const groups = groupsOf(event);
  const isAdmin = groups.includes('admin');
  log('INFO', 'request', { msg: `${method} ${rawPath}`, groups });

  try {
    // ---- 実装済み: 運用パラメータ(表6) ----
    if (rawPath.endsWith('/v1/params')) {
      if (!isAdmin) return apiError(403, 'API-4031', '権限エラー(管理者専用操作)');
      if (method === 'GET') return json(200, await getParams());
      if (method === 'PUT') {
        const patch = JSON.parse(event.body ?? '{}');
        const current = await getParams();
        const errors = validateParamPatch(patch, current);
        if (errors.length) return apiError(400, 'API-4001', 'バリデーションエラー', errors);
        for (const [key, value] of Object.entries(patch)) {
          await ssm.send(new PutParameterCommand({
            Name: `${SSM_PREFIX}/${key}`, Value: String(value), Type: 'String', Overwrite: true,
          }));
        }
        log('INFO', 'params_updated', { msg: Object.keys(patch).join(',') });
        return json(200, await getParams());
      }
    }

    // ---- 雛形: 未移植エンドポイント(フェーズ1.5で server/adminApi.js から移植) ----
    return apiError(501, 'API-5001', '未実装(フェーズ1.5でローカル検証済み実装から移植予定)');
  } catch (e) {
    log('ERROR', 'unhandled_error', { msg: e.message });
    return apiError(500, 'API-5001', '内部エラー');
  }
};
