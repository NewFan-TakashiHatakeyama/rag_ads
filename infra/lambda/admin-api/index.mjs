/**
 * rag-ads_admin-api: 広告管理API(DD-001 6.3節、BD-001 7.1節)。
 * ローカルPoC server/adminApi.js(テスト48件で検証済み)を実DynamoDB/S3 Vectors/Bedrock接続へ移植。
 * 認可: API GatewayのJWTオーソライザ通過後、cognito:groupsでadvertiser/adminを判定(11.1節)。
 * エラー形式: {"error": {"code": "API-xxxx", "message": "…", "details": [...]}} (表9)
 */
import {
  getItem, putItem, deleteItem, query, scan, batchGet, ConditionalCheckFailed,
  getParams, invalidateParamsCache,
  embed, adEmbeddingText, contentEmbeddingText,
  putVector, deleteVector, queryContentCandidates, getContentVector,
  screenAd, validateAd, pickAdAttributes,
  ulid, nowIso, jstDate, jstDateOffset, round4, log,
} from 'ragshared';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const T_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const T_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;
const SSM_PREFIX = process.env.RAG_Ads_SSM_PREFIX;
const ssm = new SSMClient({});
const PRIORITIES = ['高', '中', '低'];

// contentテーブル(既存記事)はローカル/devではスタンドイン、本番は媒体の既存記事テーブルを直接参照する。
// 環境変数 RAG_Ads_TABLE_CONTENTS が無ければ記事参照系(紐づけ候補・コンテンツ詳細)は縮退。
const T_CONTENTS = process.env.RAG_Ads_TABLE_CONTENTS || null;
// 媒体の記事テーブル(PK=url_hash=article_id)。設定時はこちらを正とし、属性名を読み替える(6.3.3節)。
const T_MEDIA_CONTENTS = process.env.RAG_Ads_MEDIA_CONTENT_TABLE || null;

/**
 * 記事1件の取得。媒体テーブル(url_hash / title / content / category / pubDate / url)が設定されていれば
 * それを正とし、広告システムの内部表現へ読み替える。未設定時はスタンドイン記事テーブルを使う。
 */
async function fetchContent(contentId) {
  if (T_MEDIA_CONTENTS) {
    const m = await getItem(T_MEDIA_CONTENTS, { url_hash: contentId });
    if (!m) return null;
    return {
      contentId: m.url_hash,
      title: m.title ?? '',
      genre: m.category ?? '',
      body: m.content ?? '',
      publishedAt: m.pubDate ?? null,
      updatedAt: m.pubDate ?? null,
      sources: m.url ? [m.url] : [],
    };
  }
  if (!T_CONTENTS) return null;
  const c = await getItem(T_CONTENTS, { PK: `CONTENT#${contentId}`, SK: 'META' });
  if (!c) return null;
  return {
    contentId: c.contentId, title: c.title ?? '', genre: c.genre ?? '', body: c.body ?? '',
    publishedAt: c.publishedAt ?? null, updatedAt: c.updatedAt ?? null, sources: c.sources ?? [],
  };
}

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

/**
 * 競合広告数(GSI2逆引き)。同一記事に紐づく他広告の件数とカテゴリ内訳のみ。
 * 広告主名・広告タイトルは含めない(6.3.3節)。
 */
async function competingAdCount(contentId, excludeAdId) {
  const links = await query(T_MASTER, `CONTENT#${contentId}`, { indexName: 'GSI2' });
  const otherAdIds = [...new Set(links.map((l) => l.adId).filter((id) => id !== excludeAdId))];
  if (otherAdIds.length === 0) return { count: 0, byCategory: {} };
  const metas = await batchGet(T_MASTER, otherAdIds.map((id) => ({ PK: `AD#${id}`, SK: 'META' })));
  const byCategory = {};
  for (const m of metas) {
    const cat = m.category ?? 'その他';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { count: otherAdIds.length, byCategory };
}

// ---- コンテンツ紐づけ(F-05) ----
const LINK_CANDIDATE_LIMIT = 20;
// 媒体のベクトル索引には、記事テーブルのTTL削除後もベクトルが残る(索引と実データが乖離する)。
// 索引の上位をそのまま出すと存在しない記事が並び、詳細404・紐づけ不可になるため、
// 多めに取得して実在分だけに絞る。倍率は「索引に対する実在記事の割合」の悪化に耐える値。
const ANN_OVERFETCH = 10;
const BATCH_GET_LIMIT = 100;

/** 候補のうち記事テーブルに実在するものだけを残す(削除済み=幽霊エントリを除外) */
async function filterLiveContents(hits) {
  if (!T_MEDIA_CONTENTS) return hits; // スタンドイン運用時は候補の出所が記事テーブル自身のため素通し
  const live = [];
  for (let i = 0; i < hits.length; i += BATCH_GET_LIMIT) {
    const chunk = hits.slice(i, i + BATCH_GET_LIMIT);
    const found = await batchGet(T_MEDIA_CONTENTS, chunk.map((h) => ({ url_hash: h.contentId })));
    const alive = new Set(found.map((m) => m.url_hash));
    for (const h of chunk) if (alive.has(h.contentId)) live.push(h);
  }
  return live;
}

/**
 * 紐づけ候補(S-03・6.3.2)。
 * 本線: 媒体の記事ベクトル索引を広告ベクトルでANN検索する(記事は媒体側で埋め込み済み=決定A-1で同一Gemini空間)。
 *   広告1本の埋め込みだけで済み記事件数に依存しない。contentIdは媒体のarticle_idなので、
 *   generate-adsが受け取るarticleContentIdsと一致し紐づけ加点が実トラフィックで機能する。
 * 縮退: 記事ベクトル索引が未設定の環境では、従来のスタンドイン記事テーブルを全件走査して都度埋め込む。
 */
async function linkCandidates(s, adId) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  const adVec = await embed(adEmbeddingText(ad));
  const linked = new Set((await linksOf(adId)).map((l) => l.SK.slice('LINK#'.length)));

  // 紐づけ済み・削除済み記事を除いても候補が枯れないよう多めに取得してから絞る
  const hits = await queryContentCandidates(adVec, LINK_CANDIDATE_LIMIT * ANN_OVERFETCH + linked.size);
  if (hits) {
    const live = await filterLiveContents(hits);
    const top = live.filter((h) => !linked.has(h.contentId)).slice(0, LINK_CANDIDATE_LIMIT);
    const candidates = await Promise.all(top.map(async (h) => ({
      contentId: h.contentId, title: h.title, genre: h.genre, url: h.url,
      relevance: round4(h.relevance),
      citationsPerDay: await citationsPerDay(h.contentId),
      competingAds: (await competingAdCount(h.contentId, adId)).count,
    })));
    return ok(200, { adId, candidates, source: 'vector-index' });
  }

  if (!T_CONTENTS) return ok(200, { adId, candidates: [], note: '記事ベクトル索引・記事テーブルとも未接続(媒体側連携で有効化)' });
  const contents = (await scan(T_CONTENTS, { filterExpression: 'SK = :m', values: { ':m': 'META' } }))
    .filter((c) => !linked.has(c.contentId));
  const scored = await Promise.all(contents.map(async (c) => ({
    c, relevance: round4(cosine(adVec, await embed(contentEmbeddingText(c)))),
  })));
  const top = scored.sort((a, b) => b.relevance - a.relevance).slice(0, LINK_CANDIDATE_LIMIT);
  const candidates = await Promise.all(top.map(async ({ c, relevance }) => ({
    contentId: c.contentId, title: c.title, genre: c.genre, relevance,
    citationsPerDay: await citationsPerDay(c.contentId),
    competingAds: (await competingAdCount(c.contentId, adId)).count,
  })));
  return ok(200, { adId, candidates, source: 'contents-table' });
}

/**
 * 記事の引用回数/日(6.3.3): generate-adsが回答生成時に受け取るarticleContentIdsを
 * daily_stats(PK=CONTENT#{id})へ日次加算したものを、直近7日の平均として返す。
 */
async function citationsPerDay(contentId, days = 7) {
  const rows = await query(T_STATS, `CONTENT#${contentId}`, { skPrefix: 'DATE#' });
  if (rows.length === 0) return 0;
  const from = jstDateOffset(-(days - 1));
  const recent = rows.filter((r) => String(r.SK).slice('DATE#'.length) >= from);
  const total = recent.reduce((sum, r) => sum + (r.citations ?? 0), 0);
  return Math.round((total / days) * 10) / 10;
}

async function putLink(s, adId, contentId, body) {
  const ad = await getAdOr404(adId);
  requireOwnership(s, ad);
  if (ad.status === 'draft' || ad.status === 'reviewing') throw new ApiError(409, 'API-4091', '下書き・審査中の広告は紐づけできません(承認後に有効化されます)');
  // 実在確認は記事の正(媒体テーブル or スタンドイン)に対して行う。
  // ベクトル索引は媒体のTTL削除済み記事を含みうるため、索引だけを根拠に紐づけてはならない。
  const c = await fetchContent(contentId);
  if ((T_MEDIA_CONTENTS || T_CONTENTS) && !c) throw new ApiError(404, 'API-4041', 'リソースが存在しません(記事が削除済みの可能性があります)');
  const priority = body?.priority ?? '中';
  if (!PRIORITIES.includes(priority)) throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'priority', reason: '優先度：高・中・低のいずれかを指定してください' }]);
  // 紐づけ時点の関連度を記録(S-03の紐づけ済み表示・分析用)。一覧(ANN)と同じ媒体の保存済みベクトルを優先
  let relevanceScore = null;
  if (c) {
    const contentVec = await getContentVector(contentId) ?? await embed(contentEmbeddingText(c));
    relevanceScore = round4(cosine(await embed(adEmbeddingText(ad)), contentVec));
  }
  await putItem(T_MASTER, {
    PK: `AD#${adId}`, SK: `LINK#${contentId}`, GSI2PK: `CONTENT#${contentId}`, GSI2SK: `AD#${adId}`,
    adId, contentId, priority, relevanceScore, createdAt: nowIso(),
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
  if (!T_MEDIA_CONTENTS && !T_CONTENTS) throw new ApiError(404, 'API-4041', '記事テーブル未接続(媒体側連携で有効化)');
  const c = await fetchContent(contentId);
  if (!c) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  const full = params.get('full') === 'true';
  const body = c.body ?? '';
  const res = {
    contentId: c.contentId, title: c.title, genre: c.genre, publishedAt: c.publishedAt, updatedAt: c.updatedAt,
    sources: c.sources ?? [], bodyPreview: full ? body : body.slice(0, 2000), hasMore: !full && body.length > 2000,
  };
  const adId = params.get('adId');
  // 競合状況(GSI2逆引き)+ 引用回数/日(generate-adsが受け取ったarticleContentIdsの日次集計)
  res.competingAds = await competingAdCount(contentId, adId ?? null);
  res.citationsPerDay = await citationsPerDay(contentId);
  if (adId) {
    const ad = await getItem(T_MASTER, { PK: `AD#${adId}`, SK: 'META' });
    if (ad) {
      requireOwnership(s, ad);
      // 関連度は一覧(ANN)と同じ「媒体が保存済みの記事ベクトル」を使う。取得できない場合のみ再埋め込み
      const contentVec = await getContentVector(contentId) ?? await embed(contentEmbeddingText(c));
      res.relevance = round4(cosine(await embed(adEmbeddingText(ad)), contentVec));
      res.matchedKeywords = [...(ad.keywords ?? []), ...(ad.tags ?? [])].filter((kw) => kw && (c.title.includes(kw) || body.includes(kw)));
      const link = await getItem(T_MASTER, { PK: `AD#${adId}`, SK: `LINK#${contentId}` });
      res.linked = !!link;
      res.linkedPriority = link?.priority ?? null;
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
