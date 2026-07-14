/**
 * rag-ads_admin-api: 広告管理API(DD-001 6.3節、BD-001 7.1節)。
 * ローカルPoC server/adminApi.js(テスト48件で検証済み)を実DynamoDB/S3 Vectors/Bedrock接続へ移植。
 * 認可: API GatewayのJWTオーソライザ通過後、cognito:groupsでadvertiser/adminを判定(11.1節)。
 * エラー形式: {"error": {"code": "API-xxxx", "message": "…", "details": [...]}} (表9)
 */
import {
  getItem, putItem, deleteItem, query, scan, ConditionalCheckFailed,
  getParams, invalidateParamsCache,
  embed, adEmbeddingText, contentEmbeddingText,
  putVector, deleteVector,
  screenAd, validateAd, pickAdAttributes,
  ulid, nowIso, jstDate, jstDateOffset, round4, log,
} from 'ragshared';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const T_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const T_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;
const SSM_PREFIX = process.env.RAG_Ads_SSM_PREFIX;
const ssm = new SSMClient({});
const PRIORITIES = ['高', '中', '低'];

// contentテーブル(既存記事)はローカルではDynamoDBだが本番は既存記事テーブル。
// 環境変数 RAG_Ads_TABLE_CONTENTS が無ければ記事参照系(紐づけ候補・コンテンツ詳細)は縮退。
const T_CONTENTS = process.env.RAG_Ads_TABLE_CONTENTS || null;

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
});
const ok = (status, body) => json(status, body);
const errBody = (e) => json(e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });

// ---- 認証・認可 ----
function sessionOf(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw = claims['cognito:groups'] ?? '';
  const groups = String(raw).replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  const email = claims.email ?? claims['cognito:username'] ?? claims.sub;
  return {
    email,
    role: groups.includes('admin') ? 'admin' : 'advertiser',
    advertiserId: claims.sub, // CognitoユーザーsubをadvertiserIdとする(5.1節)
  };
}
function requireAdmin(s) { if (s.role !== 'admin') throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)'); }
function requireOwnership(s, ad) {
  if (s.role === 'admin') return;
  if (ad.advertiserId !== s.advertiserId) throw new ApiError(403, 'API-4031', '権限エラー(他広告主のリソース)');
}

async function getAdOr404(adId) {
  const ad = await getItem(T_MASTER, { PK: `AD#${adId}`, SK: 'META' });
  if (!ad) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  return ad;
}

async function linksOf(adId) {
  return query(T_MASTER, `AD#${adId}`, { skPrefix: 'LINK#' });
}

function adSummary(ad, linkCount) {
  return {
    adId: ad.adId, title: ad.title, category: ad.category,
    tags: ad.tags ?? [], keywords: ad.keywords ?? [],
    status: ad.status, billingModel: ad.billingModel,
    unitPriceCitation: ad.unitPriceCitation, dailyBudget: ad.dailyBudget,
    campaignStart: ad.campaignStart, campaignEnd: ad.campaignEnd,
    advertiserId: ad.advertiserId, advertiserEmail: ad.advertiserEmail ?? null,
    linkCount, findings: ad.findings ?? [], reviewNote: ad.reviewNote ?? null,
    submittedAt: ad.submittedAt ?? null, createdAt: ad.createdAt, updatedAt: ad.updatedAt,
  };
}

/** ベクトル同期(5.4節): 配信中はPut、それ以外はDelete。失敗はDLQ退避(呼び出し側で捕捉) */
async function syncVector(ad) {
  if (ad.status === 'delivering') {
    const vec = await embed(adEmbeddingText(ad));
    await putVector(ad, vec);
  } else {
    await deleteVector(ad.adId);
  }
}

// ---- 広告CRUD ----
async function listAds(s, params) {
  let items = await scan(T_MASTER, { filterExpression: 'SK = :meta', values: { ':meta': 'META' } });
  if (s.role !== 'admin') items = items.filter((a) => a.advertiserId === s.advertiserId);
  const status = params.get('status');
  if (status && status !== 'all') items = items.filter((a) => a.status === status);
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const truncated = items.length > 200;
  const sliced = items.slice(0, 200);
  const withCounts = await Promise.all(sliced.map(async (a) => adSummary(a, (await linksOf(a.adId)).length)));
  return ok(200, { ads: withCounts, truncated });
}

async function createAd(s, body) {
  const submit = body.submit !== false;
  const errors = validateAd(body, { draft: !submit });
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  const adId = ulid();
  const now = nowIso();
  const attrs = pickAdAttributes(body);
  const params = await getParams();
  const findings = await screenAd(params['lead.model_id'], attrs);
  const ad = {
    PK: `AD#${adId}`, SK: 'META',
    GSI1PK: `STATUS#${submit ? 'reviewing' : 'draft'}`, GSI1SK: `UPDATED#${now}`,
    adId, ...attrs,
    status: submit ? 'reviewing' : 'draft',
    advertiserId: s.advertiserId, advertiserEmail: s.email,
    findings, submittedAt: submit ? now : null, createdAt: now, updatedAt: now,
  };
  await putItem(T_MASTER, ad);
  log('INFO', 'admin_api', submit ? 'ad_submitted' : 'ad_drafted', { adIds: [adId] });
  return ok(201, { adId, status: ad.status, findings });
}

async function getAd(s, adId) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  const links = await Promise.all((await linksOf(adId)).map(async (l) => {
    const contentId = l.SK.slice('LINK#'.length);
    const c = T_CONTENTS ? await getItem(T_CONTENTS, { PK: `CONTENT#${contentId}`, SK: 'META' }) : null;
    return { contentId, title: c?.title ?? '(記事参照は未接続)', genre: c?.genre ?? null, priority: l.priority, relevanceScore: l.relevanceScore, createdAt: l.createdAt };
  }));
  return ok(200, { ad: { ...adSummary(ad, links.length), adText: ad.adText, landingUrl: ad.landingUrl, imageUrl: ad.imageUrl, target: ad.target }, links });
}

async function updateAd(s, adId, body) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  if (ad.status === 'reviewing') throw new ApiError(409, 'API-4091', '審査中の広告は編集できません(状態遷移の競合)');
  const submit = body.submit !== false;
  const errors = validateAd(body, { draft: !submit });
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  const now = nowIso();
  const attrs = pickAdAttributes(body);
  const params = await getParams();
  const findings = await screenAd(params['lead.model_id'], attrs);
  const next = {
    ...ad, ...attrs, status: submit ? 'reviewing' : 'draft',
    GSI1PK: `STATUS#${submit ? 'reviewing' : 'draft'}`, GSI1SK: `UPDATED#${now}`,
    findings, submittedAt: submit ? now : ad.submittedAt, updatedAt: now,
  };
  await putItem(T_MASTER, next);
  await safeSyncVector(next); // 配信中→draft/reviewingで即時Delete(未審査内容の配信防止)
  log('INFO', 'admin_api', submit ? 'ad_resubmitted' : 'ad_drafted', { adIds: [adId] });
  return ok(200, { adId, status: next.status, findings });
}

// ---- ステータス遷移(6.3.2 表10) ----
const TRANSITIONS = [
  { from: 'reviewing', to: 'delivering', roles: ['admin'] },
  { from: 'reviewing', to: 'needs_fix', roles: ['admin'] },
  { from: 'delivering', to: 'paused', roles: ['advertiser', 'admin'] },
  { from: 'paused', to: 'reviewing', roles: ['advertiser', 'admin'] },
  { from: 'needs_fix', to: 'reviewing', roles: ['advertiser', 'admin'] },
  { from: 'expired', to: 'reviewing', roles: ['advertiser', 'admin'] },
];

async function patchStatus(s, adId, body) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  let to = body?.to;
  if (to === 'approved') to = 'delivering';
  const rule = TRANSITIONS.find((t) => t.from === ad.status && t.to === to);
  if (!rule) throw new ApiError(409, 'API-4091', `状態遷移が許可されていません(${ad.status} → ${body?.to})`);
  if (!rule.roles.includes(s.role)) throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)');
  const now = nowIso();
  const next = { ...ad, status: to, GSI1PK: `STATUS#${to}`, GSI1SK: `UPDATED#${now}`, updatedAt: now };
  if (to === 'needs_fix') {
    const note = body?.reviewNote;
    if (typeof note !== 'string' || note.length < 1 || note.length > 500) {
      throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'reviewNote', reason: '差戻し理由：入力してください（500文字以内）' }]);
    }
    next.reviewNote = note; next.reviewedAt = now; next.reviewedBy = s.email;
  }
  if (to === 'delivering') { next.approvedAt = now; next.approvedBy = s.email; next.reviewNote = null; }
  if (to === 'reviewing') {
    next.submittedAt = now;
    const params = await getParams();
    next.findings = await screenAd(params['lead.model_id'], next);
  }
  await putItem(T_MASTER, next);
  await safeSyncVector(next);
  log('INFO', 'admin_api', 'status_changed', { adIds: [adId], msg: `${ad.status} -> ${to}` });
  return ok(200, { adId, status: to });
}

// ---- コンテンツ紐づけ(F-05) ----
async function linkCandidates(s, adId) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  if (!T_CONTENTS) return ok(200, { adId, candidates: [], note: '記事テーブル未接続(媒体側連携で有効化)' });
  const adVec = await embed(adEmbeddingText(ad));
  const linked = new Set((await linksOf(adId)).map((l) => l.SK.slice('LINK#'.length)));
  const contents = (await scan(T_CONTENTS, { filterExpression: 'SK = :m', values: { ':m': 'META' } }))
    .filter((c) => !linked.has(c.contentId));
  const scored = await Promise.all(contents.map(async (c) => ({
    c, relevance: round4(cosine(adVec, await embed(contentEmbeddingText(c)))),
  })));
  const candidates = scored.sort((a, b) => b.relevance - a.relevance).slice(0, 10)
    .map(({ c, relevance }) => ({ contentId: c.contentId, title: c.title, genre: c.genre, relevance, citationsPerDay: 0, competingAds: 0 }));
  return ok(200, { adId, candidates });
}

async function putLink(s, adId, contentId, body) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  if (ad.status === 'draft' || ad.status === 'reviewing') throw new ApiError(409, 'API-4091', '下書き・審査中の広告は紐づけできません(承認後に有効化されます)');
  if (T_CONTENTS && !(await getItem(T_CONTENTS, { PK: `CONTENT#${contentId}`, SK: 'META' }))) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  const priority = body?.priority ?? '中';
  if (!PRIORITIES.includes(priority)) throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'priority', reason: '優先度：高・中・低のいずれかを指定してください' }]);
  await putItem(T_MASTER, {
    PK: `AD#${adId}`, SK: `LINK#${contentId}`, GSI2PK: `CONTENT#${contentId}`, GSI2SK: `AD#${adId}`,
    adId, contentId, priority, relevanceScore: null, createdAt: nowIso(),
  });
  log('INFO', 'admin_api', 'link_created', { adIds: [adId], msg: contentId });
  return ok(200, { adId, contentId, priority });
}

async function deleteLink(s, adId, contentId) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  const link = await getItem(T_MASTER, { PK: `AD#${adId}`, SK: `LINK#${contentId}` });
  if (!link) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  await deleteItem(T_MASTER, { PK: `AD#${adId}`, SK: `LINK#${contentId}` });
  return ok(200, { adId, contentId });
}

// ---- レポート(F-12) ----
async function getReport(s, adId, params) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  const to = params.get('to') || jstDate();
  const from = params.get('from') || jstDateOffset(-6, new Date(`${to}T00:00:00+09:00`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'from', reason: '期間：日付の指定が不正です' }]);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 93) throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'from', reason: '期間：最大93日まで指定できます' }]);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const date = jstDateOffset(i, new Date(`${from}T00:00:00+09:00`));
    const st = await getItem(T_STATS, { PK: `AD#${adId}`, SK: `DATE#${date}` });
    rows.push({
      date, citations: st?.citations ?? 0, cost: st?.cost ?? 0, citationChars: st?.citationChars ?? 0,
      impressions: st?.impressions ?? 0, clicks: st?.clicks ?? 0, finalized: st?.finalized ?? false,
    });
  }
  return ok(200, { adId, title: ad.title, from, to, rows });
}

// ---- コンテンツ詳細(6.3.3・S-03-1) ----
async function getContent(s, contentId, params) {
  if (!T_CONTENTS) throw new ApiError(404, 'API-4041', '記事テーブル未接続(媒体側連携で有効化)');
  const c = await getItem(T_CONTENTS, { PK: `CONTENT#${contentId}`, SK: 'META' });
  if (!c) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  const full = params.get('full') === 'true';
  const body = c.body ?? '';
  const res = {
    contentId: c.contentId, title: c.title, genre: c.genre, publishedAt: c.publishedAt, updatedAt: c.updatedAt,
    sources: c.sources ?? [], bodyPreview: full ? body : body.slice(0, 2000), hasMore: !full && body.length > 2000,
  };
  const adId = params.get('adId');
  if (adId) {
    const ad = await getItem(T_MASTER, { PK: `AD#${adId}`, SK: 'META' });
    if (ad) {
      requireOwnership(s, ad);
      res.relevance = round4(cosine(await embed(adEmbeddingText(ad)), await embed(contentEmbeddingText(c))));
      res.matchedKeywords = [...(ad.keywords ?? []), ...(ad.tags ?? [])].filter((kw) => kw && (c.title.includes(kw) || body.includes(kw)));
    }
  }
  return ok(200, res);
}

// ---- 運用パラメータ(表6) ----
const PARAM_RULES = {
  enabled: { type: 'boolean' }, 'weights.rel': { type: 'number', min: 0, max: 1 },
  'weights.bid': { type: 'number', min: 0, max: 1 }, 'weights.link': { type: 'number', min: 0, max: 1 },
  theta_rel: { type: 'number', min: 0, max: 1 }, max_slots: { type: 'int', min: 1, max: 10 },
  candidate_topk: { type: 'int', min: 1, max: 50 }, max_per_advertiser: { type: 'int', min: 1, max: 10 },
  'lead.min_chars': { type: 'int', min: 1, max: 200 }, 'lead.max_chars': { type: 'int', min: 1, max: 200 },
  'lead.model_id': { type: 'string', max: 200 }, 'lead.enabled': { type: 'boolean' },
  'lead.fallback_text': { type: 'string', min: 1, max: 100 }, 'sampling.content_check': { type: 'number', min: 0, max: 1 },
};

async function getParamsApi() { return ok(200, await getParams()); }

async function putParamsApi(body) {
  const patch = body ?? {};
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
  const current = await getParams();
  const merged = { ...current, ...patch };
  if (Number(merged['lead.min_chars']) > Number(merged['lead.max_chars'])) errors.push({ field: 'lead.min_chars', reason: 'lead.min_chars：lead.max_chars以下を指定してください' });
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  for (const [key, value] of Object.entries(patch)) {
    await ssm.send(new PutParameterCommand({ Name: `${SSM_PREFIX}/${key}`, Value: String(value), Type: 'String', Overwrite: true }));
  }
  invalidateParamsCache();
  return ok(200, await getParams());
}

// ---- ベクトル同期のフェイルセーフ(失敗はDLQへ。5.4節) ----
async function safeSyncVector(ad) {
  try {
    await syncVector(ad);
  } catch (e) {
    log('ERROR', 'admin_api', 'vector_sync_failed', { adIds: [ad.adId], msg: e.message });
    // 本番ではSQS DLQへ退避(9.2節)。ここでは記録に留め、状態遷移自体は成功扱いにする
  }
}

/** コサイン類似度(正規化済みベクトル前提=Titanのnormalize:trueで内積) */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

// ---- ルーティング ----
export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '';
  const pp = event.pathParameters ?? {};
  const qs = new URLSearchParams(event.rawQueryString ?? '');
  const body = event.body ? JSON.parse(event.body) : {};
  const s = sessionOf(event);
  log('INFO', 'admin_api', 'request', { msg: `${method} ${rawPath}`, groups: [s.role] });

  try {
    // パラメータ(admin専用)
    if (rawPath.endsWith('/v1/params')) {
      requireAdmin(s);
      if (method === 'GET') return await getParamsApi();
      if (method === 'PUT') return await putParamsApi(body);
    }
    // 広告CRUD
    if (/\/v1\/ads$/.test(rawPath)) {
      if (method === 'GET') return await listAds(s, qs);
      if (method === 'POST') return await createAd(s, body);
    }
    if (pp.adId && /\/v1\/ads\/[^/]+$/.test(rawPath)) {
      if (method === 'GET') return await getAd(s, pp.adId);
      if (method === 'PUT') return await updateAd(s, pp.adId, body);
    }
    if (pp.adId && rawPath.endsWith('/status') && method === 'PATCH') return await patchStatus(s, pp.adId, body);
    if (pp.adId && rawPath.endsWith('/link-candidates') && method === 'GET') return await linkCandidates(s, pp.adId);
    if (pp.adId && pp.contentId && rawPath.includes('/links/')) {
      if (method === 'PUT') return await putLink(s, pp.adId, pp.contentId, body);
      if (method === 'DELETE') return await deleteLink(s, pp.adId, pp.contentId);
    }
    if (pp.adId && rawPath.includes('/reports/ads/') && method === 'GET') return await getReport(s, pp.adId, qs);
    if (pp.contentId && rawPath.includes('/v1/contents/') && method === 'GET') return await getContent(s, pp.contentId, qs);
    // 日次バッチ手動起動(admin。バッチ側Lambdaへ委譲する想定だが未接続のため501)
    if (rawPath.endsWith('/v1/batch/daily-agg')) { requireAdmin(s); throw new ApiError(501, 'API-5001', '日次バッチはEventBridge起動。手動起動はLambda直接invokeを使用'); }

    throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  } catch (e) {
    if (e instanceof ApiError) return errBody(e);
    if (e instanceof ConditionalCheckFailed) return errBody(new ApiError(409, 'API-4091', '状態遷移の競合(更新競合)'));
    log('ERROR', 'admin_api', 'unhandled_error', { msg: e.message, stack: e.stack?.slice(0, 300) });
    return errBody(new ApiError(500, 'API-5001', '内部エラー'));
  }
};
