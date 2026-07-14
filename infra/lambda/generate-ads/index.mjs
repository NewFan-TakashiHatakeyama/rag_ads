/**
 * rag-ads_generate-ads: 広告生成エンドポイント(サービス方式。DD-001 3.2節 G-1〜G-10)
 *   POST /v1/pages/{pageId}/generate-ads
 *   媒体NewFan-Financeの回答生成(src/app/api/chat/route.ts)から呼び出し、回答単位で広告を確定・課金する。
 *
 * 認証: サービス間APIキー(X-Api-Key ヘッダ ⇔ SSM /rag_ads/{env}/service_api_key)。
 * 入力: { question: string, articleContentIds?: string[], questionVector?: number[] }
 *   - questionVector を渡すと候補検索に流用(媒体のGemini埋め込みを共用。決定A-1・BD-001 3.3節)。
 *     未指定時は広告システムが設定プロバイダで埋め込む。
 * 出力: { pageId, ads: [...6.2.1と同形] }。広告なし・失敗時は空配列(フェイルセーフ)。
 *
 * ローカルPoC server/pipeline.js generateAndPlace(テスト48件)を実DynamoDB/S3 Vectors/Bedrockへ移植。
 */
import {
  getItem, query, transactWrite, updateItem, ConditionalCheckFailed,
  getParams, embed, queryCandidates,
  generateLeads, validateLead,
  jstDate, nowIso, sha256, round4, log,
} from 'ragshared';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const T_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const T_PLACEMENTS = process.env.RAG_Ads_TABLE_PLACEMENTS;
const T_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;
const SSM_PREFIX = process.env.RAG_Ads_SSM_PREFIX;
const PRIORITY_BOOST = { '高': 1.0, '中': 0.6, '低': 0.3 };
const ssm = new SSMClient({});

// ---- サービスAPIキー(5分キャッシュ) ----
let keyCache = null;
let keyAt = 0;
async function getServiceApiKey() {
  if (keyCache && Date.now() - keyAt < 300000) return keyCache;
  const r = await ssm.send(new GetParameterCommand({ Name: `${SSM_PREFIX}/service_api_key`, WithDecryption: true }));
  keyCache = r.Parameter?.Value ?? '';
  keyAt = Date.now();
  return keyCache;
}

const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// ---- パイプライン補助(server/pipeline.js より移植) ----

/** 記事紐づけ加点(高=1.0/中=0.6/低=0.3)。取得記事とのLINKのうち最優先を採用 */
async function linkBoost(adId, articleContentIds) {
  if (!articleContentIds?.length) return 0;
  const links = await query(T_MASTER, `AD#${adId}`, { skPrefix: 'LINK#' });
  let boost = 0;
  for (const l of links) {
    const contentId = l.SK.slice('LINK#'.length);
    if (articleContentIds.includes(contentId)) boost = Math.max(boost, PRIORITY_BOOST[l.priority] ?? 0);
  }
  return boost;
}

/** 予算計上(条件付き加算。DD-001 4.2.2)。不成立=予算超過でfalse */
async function reserveBudget(ad, today) {
  try {
    await updateItem(T_STATS, { PK: `AD#${ad.adId}`, SK: `DATE#${today}` }, {
      add: { cost: ad.unitPriceCitation, citations: 1 },
      set: { adId: ad.adId, date: today, updatedAt: nowIso() },
      // cost(加算前) <= dailyBudget - unit ⇔ 加算後 <= dailyBudget
      condition: 'attribute_not_exists(cost) OR cost <= :limit',
      values: { ':limit': ad.dailyBudget - ad.unitPriceCitation },
    });
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailed) return false;
    throw e;
  }
}

/** 補償減算(G-9失敗時。3.5節) */
async function compensate(reserved, today) {
  for (const r of reserved) {
    try {
      await updateItem(T_STATS, { PK: `AD#${r.adId}`, SK: `DATE#${today}` }, {
        add: { cost: -r.unit, citations: -1 }, set: { updatedAt: nowIso() },
      });
    } catch (e) {
      log('ERROR', 'ad_pipeline', 'pipeline_failed', { code: 'ADS-1201', adIds: [r.adId], msg: `補償減算失敗: ${e.message}` });
    }
  }
}

/** G-8 リード文生成+検証(失敗・NGはフォールバック定型文) */
async function buildLeads(ctx, selected, params, pageId) {
  const map = new Map();
  const fallback = { lead: params['lead.fallback_text'], source: 'fallback' };
  if (!params['lead.enabled']) {
    for (const c of selected) map.set(c.adId, fallback);
    return map;
  }
  let result = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = await generateLeads(params['lead.model_id'],
        { question: ctx.question, category: ctx.cls.category, questionType: ctx.cls.question_type, articleTitles: ctx.articleTitles },
        selected.map((c) => ({ adId: c.adId, title: c.title, adText: c.adText })));
      if (!result || !Array.isArray(result.leads)) result = null;
    } catch { result = null; }
  }
  if (!result) {
    log('WARN', 'ad_pipeline', 'lead_fallback', { pageId, code: 'ADS-1101' });
    for (const c of selected) map.set(c.adId, fallback);
    return map;
  }
  for (const c of selected) {
    const entry = result.leads.find((l) => l.adId === c.adId);
    const reason = entry ? validateLead(entry.lead, params) : 'missing';
    if (reason) {
      log('WARN', 'ad_pipeline', 'lead_fallback', { pageId, code: 'ADS-1102', adIds: [c.adId], msg: reason });
      map.set(c.adId, fallback);
    } else {
      map.set(c.adId, { lead: entry.lead, source: 'llm' });
    }
  }
  return map;
}

/** G-9 Placement保存(冪等・スナップショット保持。5.2節) */
async function savePlacements(pageId, selected, leadMap, cls, today) {
  const now = nowIso();
  const ttl = Math.floor(Date.now() / 1000) + 13 * 30 * 24 * 3600;
  const items = selected.map((c, i) => {
    const lead = leadMap.get(c.adId);
    return {
      PK: `PAGE#${pageId}`, SK: `SLOT#${i + 1}`,
      GSI1PK: `AD#${c.adId}`, GSI1SK: `TS#${now}`,
      pageId, slot: i + 1, adId: c.adId, advertiserId: c.advertiserId,
      adTitle: c.title, landingUrl: c.landingUrl, imageUrl: c.imageUrl ?? null,
      leadText: lead.lead, leadSource: lead.source,
      score: round4(c.score), sim: round4(c.sim), bidNorm: round4(c.bidNorm), linkBoost: c.linkBoost,
      unitPrice: c.unitPriceCitation, billedAmount: c.unitPriceCitation,
      citationChars: lead.lead.length,
      questionCategory: cls.category, questionType: cls.question_type,
      questionDigest: sha256(`PAGE#${pageId}`),
      impressions: 0, clicks: 0, createdAt: now, date: today, ttl,
    };
  });
  await transactWrite(items.map((item) => ({ table: T_PLACEMENTS, item, conditionNotExists: true })));
  for (const item of items) {
    await updateItem(T_STATS, { PK: `AD#${item.adId}`, SK: `DATE#${today}` }, {
      add: { citationChars: item.citationChars }, set: { updatedAt: nowIso() },
    });
  }
  return items;
}

/** 表示計測(生成応答のads[]も1回の表示。2.6節) */
async function recordImpressions(placements) {
  const today = jstDate();
  const now = nowIso();
  for (const p of placements) {
    await updateItem(T_PLACEMENTS, { PK: p.PK, SK: p.SK }, {
      add: { impressions: 1 }, set: { lastViewedAt: now, ...(p.firstViewedAt ? {} : { firstViewedAt: now }) },
    });
    await updateItem(T_STATS, { PK: `AD#${p.adId}`, SK: `DATE#${today}` }, {
      add: { impressions: 1 }, set: { updatedAt: now, adId: p.adId, date: today },
    });
  }
}

/** 有効性判定(冪等再返却時。3.3節) */
async function filterAlive(placements) {
  const today = jstDate();
  const out = [];
  for (const p of placements) {
    const meta = await getItem(T_MASTER, { PK: `AD#${p.adId}`, SK: 'META' });
    if (meta && meta.status === 'delivering' && meta.campaignStart <= today && meta.campaignEnd >= today) out.push(p);
  }
  return out;
}

const toAdCard = (p) => ({
  slot: p.slot, adId: p.adId, label: '広告', lead: p.leadText, title: p.adTitle,
  imageUrl: p.imageUrl ?? null, clickUrl: `/r/${p.pageId}/${p.slot}`,
});

// ---- メインハンドラ ----
export const handler = async (event) => {
  const started = Date.now();
  const pageId = event.pathParameters?.pageId ?? '';
  const respond = (ads) => json(200, { pageId, ads });

  try {
    // 認証(サービス間APIキー)
    const provided = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'] ?? '';
    const expected = await getServiceApiKey();
    if (!expected || provided !== expected) return json(401, { error: { code: 'API-4011', message: '認証エラー(サービスキー)' } });

    if (!/^[0-9a-zA-Z_-]{8,64}$/.test(pageId)) return respond([]); // messageId形式許容

    // API Gatewayがbodyをbase64化する場合に備えデコード(日本語の文字化け防止)
    const rawBody = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body ?? '');
    const body = rawBody ? JSON.parse(rawBody) : {};
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return respond([]);
    const articleContentIds = Array.isArray(body.articleContentIds) ? body.articleContentIds : [];

    const params = await getParams();
    if (!params.enabled) { log('INFO', 'ad_pipeline', 'pipeline_skipped', { pageId }); return respond([]); }

    // 冪等性(3.5節): 既存Placementがあれば有効分を返す(課金なし)
    const existing = await query(T_PLACEMENTS, `PAGE#${pageId}`, { skPrefix: 'SLOT#' });
    if (existing.length > 0) {
      const alive = await filterAlive(existing);
      await recordImpressions(alive);
      return respond(alive.map(toAdCard));
    }

    const today = jstDate();
    // G-2 質問分析。埋め込みは questionVector 優先(媒体Gemini共用)、無ければ自前埋め込み
    const { classifyQuestion } = await import('ragshared');
    const cls = await classifyQuestion(params['lead.model_id'], question);
    const qvec = Array.isArray(body.questionVector) ? body.questionVector : await embed(question);

    // G-3 候補検索(status=delivering AND 期間内)
    let hits;
    try {
      hits = await queryCandidates(qvec, params.candidate_topk, today);
    } catch (e) {
      log('WARN', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1001', msg: e.message });
      return respond([]);
    }
    log('INFO', 'ad_pipeline', 'candidates_found', { pageId, adIds: hits.map((h) => h.adId) });

    // G-4 メタ取得(欠損除外)
    const candidates = [];
    for (const h of hits) {
      const meta = await getItem(T_MASTER, { PK: `AD#${h.adId}`, SK: 'META' });
      if (meta) candidates.push({ ...meta, sim: h.sim });
    }

    // G-5 除外フィルタ(閾値・ターゲット・予算・二重防御でstatus/期間再確認)
    const valid = [];
    for (const c of candidates) {
      if (c.status !== 'delivering' || c.campaignStart > today || c.campaignEnd < today) continue;
      if (c.sim < params.theta_rel) continue;
      if (cls.targetFilterApplicable && c.target?.questionTypes?.length && !c.target.questionTypes.includes(cls.question_type)) continue;
      const stat = await getItem(T_STATS, { PK: `AD#${c.adId}`, SK: `DATE#${today}` });
      if ((stat?.cost ?? 0) + c.unitPriceCitation > c.dailyBudget) continue;
      valid.push(c);
    }
    if (valid.length === 0) return respond([]);

    // G-6 スコアリング + G-7 予算計上(条件付き加算・不成立は次点繰上げ)
    const prices = valid.map((c) => c.unitPriceCitation);
    const [minP, maxP] = [Math.min(...prices), Math.max(...prices)];
    for (const c of valid) {
      c.bidNorm = maxP === minP ? 1 : (c.unitPriceCitation - minP) / (maxP - minP);
      c.linkBoost = await linkBoost(c.adId, articleContentIds);
      c.score = params['weights.rel'] * c.sim + params['weights.bid'] * c.bidNorm + params['weights.link'] * c.linkBoost;
    }
    valid.sort((a, b) => b.score - a.score);
    const selected = [];
    const advertiserSlots = new Map();
    const reserved = [];
    for (const c of valid) {
      if (selected.length >= params.max_slots) break;
      if ((advertiserSlots.get(c.advertiserId) ?? 0) >= params.max_per_advertiser) continue;
      if (!(await reserveBudget(c, today))) { log('INFO', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1301', adIds: [c.adId] }); continue; }
      reserved.push({ adId: c.adId, unit: c.unitPriceCitation });
      selected.push(c);
      advertiserSlots.set(c.advertiserId, (advertiserSlots.get(c.advertiserId) ?? 0) + 1);
    }
    if (selected.length === 0) return respond([]);

    // G-8 リード文
    const articleTitles = [];
    for (const id of articleContentIds.slice(0, 3)) {
      const c = await getItem(process.env.RAG_Ads_TABLE_CONTENTS || T_MASTER, { PK: `CONTENT#${id}`, SK: 'META' }).catch(() => null);
      if (c?.title) articleTitles.push(c.title);
    }
    const leadMap = await buildLeads({ question, cls, articleContentIds, articleTitles }, selected, params, pageId);

    // G-9 Placement保存(冪等)
    let placements;
    try {
      placements = await savePlacements(pageId, selected, leadMap, cls, today);
    } catch (e) {
      if (e instanceof ConditionalCheckFailed) {
        await compensate(reserved, today);
        const alive = await filterAlive(await query(T_PLACEMENTS, `PAGE#${pageId}`, { skPrefix: 'SLOT#' }));
        await recordImpressions(alive);
        return respond(alive.map(toAdCard));
      }
      await compensate(reserved, today);
      log('ERROR', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1201', msg: e.message });
      return respond([]);
    }
    log('INFO', 'ad_pipeline', 'placement_saved', { pageId, adIds: placements.map((p) => p.adId), latencyMs: Date.now() - started });

    await recordImpressions(placements);
    return respond(placements.map(toAdCard));
  } catch (e) {
    // あらゆる例外は広告なしで返す(回答生成を妨げない。3.4節)
    log('ERROR', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1999', msg: e.message });
    return respond([]);
  }
};
