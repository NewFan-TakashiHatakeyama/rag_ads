/**
 * 広告管理API(DD-001 6.3節、BD-001 7.1節)。
 * エラー形式: {"error": {"code": "API-xxxx", "message": "…", "details": [...]}} (表9)
 */
import { tables, adVectorIndex } from './store.js';
import { embed, similarity, adEmbeddingText, contentVector } from './vector.js';
import { validateAd, pickAdAttributes } from './validate.js';
import { screenAd } from './llm.js';
import { ulid, nowIso, jstDate, jstDateOffset, round4, log } from './util.js';
import { getParams, setParams } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const PRIORITIES = ['高', '中', '低'];

// ---- 共通ヘルパ -----------------------------------------------------------
function requireAuth(session) {
  if (!session) throw new ApiError(401, 'API-4011', '認証エラー(トークン欠落・失効)');
  return session;
}

function getAdOr404(adId) {
  const ad = tables.ads.get(`AD#${adId}`, 'META');
  if (!ad) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  return ad;
}

/** advertiserは自身のadvertiserIdに一致する広告のみ操作可能(6.3.2) */
function requireOwnership(session, ad) {
  if (session.role === 'admin') return;
  if (ad.advertiserId !== session.advertiserId) {
    throw new ApiError(403, 'API-4031', '権限エラー(他広告主のリソース)');
  }
}

function adSummary(ad) {
  const links = tables.ads.query(ad.PK, { skPrefix: 'LINK#' });
  return {
    adId: ad.adId, title: ad.title, category: ad.category,
    tags: ad.tags ?? [], keywords: ad.keywords ?? [],
    status: ad.status, billingModel: ad.billingModel,
    unitPriceCitation: ad.unitPriceCitation, dailyBudget: ad.dailyBudget,
    campaignStart: ad.campaignStart, campaignEnd: ad.campaignEnd,
    advertiserId: ad.advertiserId, advertiserEmail: ad.advertiserEmail ?? null,
    linkCount: links.length,
    findings: ad.findings ?? [],
    reviewNote: ad.reviewNote ?? null,
    submittedAt: ad.submittedAt ?? null,
    createdAt: ad.createdAt, updatedAt: ad.updatedAt,
  };
}

/** ベクトル同期(5.4節): 配信開始でPut、停止・期限切れ・内容変更でDelete */
export function syncVector(ad) {
  if (ad.status === 'delivering') {
    adVectorIndex.putVector(ad.adId, embed(adEmbeddingText(ad)), {
      adId: ad.adId, category: ad.category, status: 'delivering',
      campaignStart: ad.campaignStart, campaignEnd: ad.campaignEnd,
      unitPrice: ad.unitPriceCitation, advertiserId: ad.advertiserId,
    });
  } else {
    adVectorIndex.deleteVector(ad.adId);
  }
}

// ---- 広告CRUD --------------------------------------------------------------
/** GET /v1/ads?status= (一覧・最大200件・更新日時降順) */
export function listAds(session, query) {
  requireAuth(session);
  let items = tables.ads.scan((it) => it.SK === 'META');
  if (session.role !== 'admin') {
    items = items.filter((a) => a.advertiserId === session.advertiserId);
  }
  const status = query.get('status');
  if (status && status !== 'all') items = items.filter((a) => a.status === status);
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const truncated = items.length > 200;
  return { status: 200, body: { ads: items.slice(0, 200).map(adSummary), truncated } };
}

/** POST /v1/ads (submit=true:出稿→reviewing / false:下書き→draft。201でadId返却) */
export function createAd(session, body) {
  requireAuth(session);
  const submit = body.submit !== false; // 既定true(6.3.1)
  const errors = validateAd(body, { draft: !submit });
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  const adId = ulid();
  const now = nowIso();
  const attrs = pickAdAttributes(body);
  const ad = {
    PK: `AD#${adId}`, SK: 'META',
    GSI1PK: `STATUS#${submit ? 'reviewing' : 'draft'}`, GSI1SK: `UPDATED#${now}`,
    adId, ...attrs,
    status: submit ? 'reviewing' : 'draft',
    advertiserId: session.advertiserId ?? session.email,
    advertiserEmail: session.email,
    findings: screenAd(attrs), // 出稿時スクリーニング(7.4節)。警告のみで自動リジェクトしない
    submittedAt: submit ? now : null,
    createdAt: now, updatedAt: now,
  };
  tables.ads.put(ad);
  log('INFO', 'admin_api', submit ? 'ad_submitted' : 'ad_drafted', { adIds: [adId] });
  return { status: 201, body: { adId, status: ad.status, findings: ad.findings } };
}

/** GET /v1/ads/{adId} (詳細+紐づけ一覧) */
export function getAd(session, adId) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  const links = tables.ads.query(ad.PK, { skPrefix: 'LINK#' }).map((l) => {
    const contentId = l.SK.slice('LINK#'.length);
    const c = tables.contents.get(`CONTENT#${contentId}`, 'META');
    return {
      contentId, title: c?.title ?? '(記事が見つかりません)', genre: c?.genre ?? null,
      priority: l.priority, relevanceScore: l.relevanceScore, createdAt: l.createdAt,
    };
  });
  return { status: 200, body: { ad: { ...adSummary(ad), adText: ad.adText, landingUrl: ad.landingUrl, imageUrl: ad.imageUrl, target: ad.target }, links } };
}

/**
 * PUT /v1/ads/{adId} (更新。submit仕様はPOSTと同一。6.3.1)
 * 審査中は編集不可(409)。配信中・承認済の更新は未審査内容の配信を防ぐため配信を停止し
 * draft(下書き保存)またはreviewing(出稿)へ遷移する(BD-001 4.2.2)。
 */
export function updateAd(session, adId, body) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  if (ad.status === 'reviewing') {
    throw new ApiError(409, 'API-4091', '審査中の広告は編集できません(状態遷移の競合)');
  }
  const submit = body.submit !== false;
  const errors = validateAd(body, { draft: !submit });
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  const now = nowIso();
  const attrs = pickAdAttributes(body);
  const next = {
    ...ad, ...attrs,
    status: submit ? 'reviewing' : 'draft',
    GSI1PK: `STATUS#${submit ? 'reviewing' : 'draft'}`, GSI1SK: `UPDATED#${now}`,
    findings: screenAd(attrs),
    submittedAt: submit ? now : ad.submittedAt,
    updatedAt: now,
  };
  tables.ads.put(next);
  syncVector(next); // 配信中だった場合はDeleteVectors(即時配信停止)
  log('INFO', 'admin_api', submit ? 'ad_resubmitted' : 'ad_drafted', { adIds: [adId] });
  return { status: 200, body: { adId, status: next.status, findings: next.findings } };
}

/**
 * DELETE /v1/ads/{adId} — 広告の物理削除(F-01)
 *
 * 一度も配信されていない状態(draft / needs_fix)のみ許可する。
 * 配信済み(delivering/paused/expired)は Placement(課金記録・監査証跡)が存在し得るため、
 * 物理削除せず停止(paused)による論理削除を用いる(DD-001 6.4節)。
 * reviewing は審査対象の固定のため削除させない(編集不可と同じ理由)。
 *
 * draft/needs_fix は承認前でベクトル未登録のため DeleteVectors は不要。
 * 紐づけ(LINK#)も含めて AD#{adId} 配下をすべて削除する。
 */
export const DELETABLE_STATUSES = ['draft', 'needs_fix'];

export function deleteAd(session, adId) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  if (!DELETABLE_STATUSES.includes(ad.status)) {
    throw new ApiError(
      409,
      'API-4091',
      ad.status === 'reviewing'
        ? '審査中の広告は削除できません(審査対象の固定のため)'
        : '配信実績のある広告は削除できません(課金記録の保全のため)。「停止」をご利用ください'
    );
  }
  for (const l of tables.ads.query(ad.PK, { skPrefix: 'LINK#' })) {
    tables.ads.delete(ad.PK, l.SK);
  }
  tables.ads.delete(ad.PK, 'META');
  log('INFO', 'admin_api', 'ad_deleted', { adIds: [adId] });
  return { status: 200, body: { adId, deleted: true } };
}

// ---- ステータス遷移(6.3.2 表10) --------------------------------------------
const TRANSITIONS = [
  // 承認: PoCでは承認時にstatus=deliveringを設定し期間はフィルタで制御(6.3.2)
  { from: 'reviewing', to: 'delivering', roles: ['admin'] },
  { from: 'reviewing', to: 'needs_fix', roles: ['admin'], needsNote: true },
  { from: 'delivering', to: 'paused', roles: ['advertiser', 'admin'] },
  { from: 'paused', to: 'reviewing', roles: ['advertiser', 'admin'] },     // 再出稿(再審査)
  { from: 'needs_fix', to: 'reviewing', roles: ['advertiser', 'admin'] },  // 修正して再出稿
  { from: 'expired', to: 'reviewing', roles: ['advertiser', 'admin'] },    // 再出稿(BD-001 4.2.2)
];

/** PATCH /v1/ads/{adId}/status  body: {to, reviewNote?} */
export function patchStatus(session, adId, body) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  let to = body?.to;
  if (to === 'approved') to = 'delivering'; // 承認の別名(表10: approved→deliveringは承認時に設定)
  const rule = TRANSITIONS.find((t) => t.from === ad.status && t.to === to);
  if (!rule) {
    throw new ApiError(409, 'API-4091', `状態遷移が許可されていません(${ad.status} → ${body?.to})`);
  }
  if (!rule.roles.includes(session.role)) {
    throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)');
  }
  const now = nowIso();
  const next = { ...ad, status: to, GSI1PK: `STATUS#${to}`, GSI1SK: `UPDATED#${now}`, updatedAt: now };
  if (to === 'needs_fix') {
    const note = body?.reviewNote;
    if (typeof note !== 'string' || note.length < 1 || note.length > 500) {
      throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'reviewNote', reason: '差戻し理由：入力してください（500文字以内）' }]);
    }
    next.reviewNote = note;
    next.reviewedAt = now;
    next.reviewedBy = session.email;
  }
  if (to === 'delivering') {
    next.approvedAt = now;
    next.approvedBy = session.email;
    next.reviewNote = null;
  }
  if (to === 'reviewing') {
    next.submittedAt = now;
    next.findings = screenAd(next); // 再出稿時は再スクリーニング
  }
  tables.ads.put(next);
  syncVector(next);
  log('INFO', 'admin_api', 'status_changed', { adIds: [adId], msg: `${ad.status} -> ${to}` });
  return { status: 200, body: { adId, status: to } };
}

// ---- コンテンツ紐づけ(F-05) -------------------------------------------------
/** GET /v1/ads/{adId}/link-candidates (類似度上位10件のレコメンド) */
export function linkCandidates(session, adId) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  const adVec = embed(adEmbeddingText(ad));
  const linked = new Set(tables.ads.query(ad.PK, { skPrefix: 'LINK#' }).map((l) => l.SK.slice('LINK#'.length)));
  const contents = tables.contents.scan((c) => c.SK === 'META');
  // 関連度のみで上位10件へ絞ってから統計(引用実績・競合)を付与する(全記事分の集計を避ける)
  const cands = contents
    .filter((c) => !linked.has(c.contentId))
    .map((c) => ({ c, relevance: round4(similarity(adVec, contentVector(c))) }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10)
    .map(({ c, relevance }) => ({
      contentId: c.contentId,
      title: c.title,
      genre: c.genre,
      relevance,
      citationsPerDay: contentCitationsPerDay(c),
      competingAds: competingAdCount(c.contentId, adId).count,
    }));
  return { status: 200, body: { adId, candidates: cands } };
}

/** PUT /v1/ads/{adId}/links/{contentId}  body: {priority} */
export function putLink(session, adId, contentId, body) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  if (ad.status === 'draft' || ad.status === 'reviewing') {
    throw new ApiError(409, 'API-4091', '下書き・審査中の広告は紐づけできません(承認後に有効化されます)');
  }
  const c = tables.contents.get(`CONTENT#${contentId}`, 'META');
  if (!c) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  const priority = body?.priority ?? '中';
  if (!PRIORITIES.includes(priority)) {
    throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'priority', reason: '優先度：高・中・低のいずれかを指定してください' }]);
  }
  const relevance = similarity(embed(adEmbeddingText(ad)), contentVector(c));
  tables.ads.put({
    PK: ad.PK, SK: `LINK#${contentId}`,
    GSI2PK: `CONTENT#${contentId}`, GSI2SK: `AD#${adId}`,
    adId, contentId,
    relevanceScore: round4(relevance),
    priority,
    createdAt: nowIso(),
  });
  log('INFO', 'admin_api', 'link_created', { adIds: [adId], msg: contentId });
  return { status: 200, body: { adId, contentId, priority } };
}

/** DELETE /v1/ads/{adId}/links/{contentId} */
export function deleteLink(session, adId, contentId) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  const link = tables.ads.get(ad.PK, `LINK#${contentId}`);
  if (!link) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  tables.ads.delete(ad.PK, `LINK#${contentId}`);
  log('INFO', 'admin_api', 'link_deleted', { adIds: [adId], msg: contentId });
  return { status: 200, body: { adId, contentId } };
}

// ---- レポート(F-12) ---------------------------------------------------------
/** GET /v1/reports/ads/{adId}?from=&to= (日次レポート。既定は過去7日間) */
export function getReport(session, adId, query) {
  requireAuth(session);
  const ad = getAdOr404(adId);
  requireOwnership(session, ad);
  const to = query.get('to') || jstDate();
  const from = query.get('from') || jstDateOffset(-6, new Date(`${to}T00:00:00+09:00`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'from', reason: '期間：日付の指定が不正です' }]);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 93) {
    throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'from', reason: '期間：最大93日まで指定できます' }]);
  }
  const rows = [];
  for (let i = 0; i < days; i++) {
    const date = jstDateOffset(i, new Date(`${from}T00:00:00+09:00`));
    const s = tables.stats.get(`AD#${adId}`, `DATE#${date}`);
    rows.push({
      date,
      citations: s?.citations ?? 0,
      cost: s?.cost ?? 0,
      citationChars: s?.citationChars ?? 0,
      impressions: s?.impressions ?? 0,
      clicks: s?.clicks ?? 0,
      finalized: s?.finalized ?? false,
    });
  }
  return { status: 200, body: { adId, title: ad.title, from, to, rows } };
}

// ---- コンテンツ詳細(6.3.3・S-03-1) -------------------------------------------
/** GET /v1/contents/{contentId}?adId=&full= (既存記事テーブルの読み取り専用参照) */
export function getContent(session, contentId, query) {
  requireAuth(session);
  const c = tables.contents.get(`CONTENT#${contentId}`, 'META');
  if (!c) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
  const full = query.get('full') === 'true';
  const body = c.body ?? '';
  const res = {
    contentId: c.contentId, title: c.title, genre: c.genre,
    publishedAt: c.publishedAt, updatedAt: c.updatedAt,
    sources: c.sources ?? [],
    bodyPreview: full ? body : body.slice(0, 2000),
    hasMore: !full && body.length > 2000,
    stats: contentStats(c),
    competingAds: competingAdCount(contentId, query.get('adId')),
  };
  const adId = query.get('adId');
  if (adId) {
    const ad = tables.ads.get(`AD#${adId}`, 'META');
    if (ad) {
      requireOwnership(session, ad);
      res.relevance = round4(similarity(embed(adEmbeddingText(ad)), contentVector(c)));
      res.matchedKeywords = [...(ad.keywords ?? []), ...(ad.tags ?? [])]
        .filter((kw) => kw && (c.title.includes(kw) || body.includes(kw)));
      const link = tables.ads.get(`AD#${adId}`, `LINK#${contentId}`);
      res.linked = !!link;
      res.linkedPriority = link?.priority ?? null;
    }
  }
  return { status: 200, body: res };
}

/** 引用回数/日(直近7日平均)。シードのベース値+実測(回答ページのsources参照)を合算 */
function contentCitationsPerDay(c) {
  const daily = contentDaily(c);
  const total = daily.reduce((s, d) => s + d.count, 0);
  return Math.round((total / 7) * 10) / 10;
}

function contentDaily(c) {
  const base = c.baseCitationsDaily ?? [];
  const pages = tables.pages.scan((p) => p.SK === 'META' && (p.sources ?? []).some((s) => s.contentId === c.contentId));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = jstDateOffset(-i);
    const live = pages.filter((p) => (p.createdAt ?? '').length && jstDate(new Date(p.createdAt)) === date).length;
    days.push({ date, count: (base[6 - i] ?? 0) + live });
  }
  return days;
}

function contentStats(c) {
  const daily = contentDaily(c);
  // 質問タイプ内訳(取得可能な範囲。実ページの分類スナップショットから算出)
  const pages = tables.pages.scan((p) => p.SK === 'META' && (p.sources ?? []).some((s) => s.contentId === c.contentId));
  const share = {};
  for (const p of pages) {
    if (p.questionType) share[p.questionType] = (share[p.questionType] ?? 0) + 1;
  }
  const stats = { citationsPerDay: contentCitationsPerDay(c), daily };
  if (Object.keys(share).length) stats.questionTypeShare = share;
  return stats;
}

/** 競合広告(GSI2逆引き相当): 同一記事に紐づく他広告の件数とカテゴリ内訳のみ(広告主名は含めない) */
function competingAdCount(contentId, excludeAdId) {
  const links = tables.ads.scan((it) => String(it.SK).startsWith('LINK#') && it.contentId === contentId && it.adId !== excludeAdId);
  const byCategory = {};
  for (const l of links) {
    const ad = tables.ads.get(`AD#${l.adId}`, 'META');
    const cat = ad?.category ?? 'その他';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { count: links.length, byCategory };
}

// ---- 運用パラメータ(SSM相当。フィーチャーフラグ検証用) ------------------------
export function getParamsApi(session) {
  requireAuth(session);
  if (session.role !== 'admin') throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)');
  return { status: 200, body: getParams() };
}

/** パラメータ検証スキーマ(DD-001 表6)。配信インバリアントを支配する値のため型・範囲を強制する */
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

export function putParamsApi(session, body) {
  requireAuth(session);
  if (session.role !== 'admin') throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)');
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
  const merged = { ...getParams(), ...patch };
  if (merged['lead.min_chars'] > merged['lead.max_chars']) {
    errors.push({ field: 'lead.min_chars', reason: 'lead.min_chars：lead.max_chars以下を指定してください' });
  }
  if (errors.length) throw new ApiError(400, 'API-4001', 'バリデーションエラー', errors);
  return { status: 200, body: setParams(patch, { persist: true }) };
}
