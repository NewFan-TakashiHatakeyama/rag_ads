/**
 * 広告パイプライン(DD-001 3.2節 図2 G-1〜G-10)と回答生成(既存サイト相当のモック)。
 * あらゆる例外は回答生成へ伝播させず、広告なし(ads: [])で終了する(3.4節)。
 */
import { tables, adVectorIndex, transactWrite, ConditionalCheckFailed } from './store.js';
import { getParams } from './config.js';
import { embed, similarity, contentVector } from './vector.js';
import { classifyQuestion, generateLeads, validateLead } from './llm.js';
import { jstDate, nowIso, newPageId, sha256, round4, log } from './util.js';

const PRIORITY_BOOST = { '高': 1.0, '中': 0.6, '低': 0.3 };

const defaultDeps = { generateLeads, savePlacements };

// ---- 回答生成(既存NewFan-Financeの回答生成Lambda相当) ---------------------
/**
 * 質問を受け付け、回答ページを生成して広告パイプラインを実行する。
 * @returns {{pageId, question, answer, sources, ads}}
 */
export function answerQuestion(question, deps = {}) {
  const pageId = newPageId(question);
  const qvec = embed(question);
  // 記事RAG検索(既存処理相当): 類似度上位3件
  const contents = tables.contents.scan((c) => c.SK === 'META');
  const scored = contents
    .map((c) => ({ c, sim: similarity(qvec, contentVector(c)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 3)
    .filter((x) => x.sim > 0.05);
  const sources = scored.map((x) => ({ contentId: x.c.contentId, title: x.c.title }));
  const answer = composeAnswer(question, scored.map((x) => x.c));
  const cls = classifyQuestion(question);
  const page = {
    PK: `PAGE#${pageId}`, SK: 'META',
    pageId, question, answer, sources,
    questionCategory: cls.category, questionType: cls.question_type,
    createdAt: nowIso(),
  };
  tables.pages.put(page);
  const ads = runAdPipeline({ pageId, question, qvec, cls, articleContentIds: sources.map((s) => s.contentId) }, deps);
  return { pageId, question, answer, sources, ads };
}

function composeAnswer(question, contents) {
  if (contents.length === 0) {
    return 'ご質問に関連する記事が見つかりませんでした。一般的な情報としては、金融商品の選択やローンの見直しは、ご自身の収支状況とリスク許容度を踏まえて比較検討することが大切です。';
  }
  const parts = [];
  contents.forEach((c, i) => {
    parts.push(`${c.summary} [${i + 1}]`);
  });
  parts.push('以上を踏まえ、ご自身の状況(収入・返済計画・リスク許容度)に合わせて判断することをおすすめします。');
  return parts.join('\n\n');
}

// ---- 広告パイプライン(G-2〜G-10) -----------------------------------------
/**
 * @param {{pageId: string, question: string, qvec?: object, articleContentIds: string[]}} input
 * @returns {Array} 広告カードDTO(6.2.1のads[]スキーマ)。広告なし・失敗時は []
 */
export function runAdPipeline(input, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const params = getParams();
  const started = Date.now();
  try {
    if (!params.enabled) {
      log('INFO', 'ad_pipeline', 'pipeline_skipped', { pageId: input.pageId });
      return [];
    }
    // 冪等性(3.5節): 同一pageIdのPlacementが既にあれば既存を返却(課金なし)。
    // 返却は表示に使われるため、表示時と同じ有効性判定(3.3節)を適用する
    const existing = tables.placements.query(`PAGE#${input.pageId}`);
    if (existing.length > 0) {
      const alive = filterAlivePlacements(existing);
      recordImpressions(alive);
      return alive.map(toAdCard);
    }
    return generateAndPlace(input, params, d, started);
  } catch (e) {
    log('ERROR', 'ad_pipeline', 'pipeline_failed', { pageId: input.pageId, code: 'ADS-1999', msg: e.message });
    return [];
  }
}

function generateAndPlace(input, params, d, started) {
  const { pageId, question, articleContentIds } = input;
  const today = jstDate();
  const qvec = input.qvec ?? embed(question);

  // G-2 質問分析(分類失敗時はターゲットフィルタ未適用で続行)
  const cls = input.cls ?? classifyQuestion(question);

  // G-3 広告候補検索(status=delivering AND 期間内。S3 Vectorsメタデータフィルタ相当)
  let hits;
  try {
    hits = adVectorIndex.query(
      qvec, params.candidate_topk,
      (m) => m.status === 'delivering' && m.campaignStart <= today && m.campaignEnd >= today,
      similarity
    );
  } catch (e) {
    log('WARN', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1001', msg: e.message });
    return [];
  }
  log('INFO', 'ad_pipeline', 'candidates_found', { pageId, adIds: hits.map((h) => h.adId) });

  // G-4 広告メタ取得(欠損は除外: ADS-1002)
  const candidates = [];
  for (const h of hits) {
    const meta = tables.ads.get(`AD#${h.adId}`, 'META');
    if (!meta) {
      log('WARN', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1002', adIds: [h.adId] });
      continue;
    }
    candidates.push({ ...meta, sim: h.sim });
  }

  // G-5 除外フィルタ(類似度閾値・ターゲット・予算見込み)。
  // ベクトルメタデータの同期漏れに備え、取得済みMETAの現在statusと期間も再確認する(二重防御)
  const valid = candidates.filter((c) => {
    if (c.status !== 'delivering' || c.campaignStart > today || c.campaignEnd < today) return false;
    if (c.sim < params.theta_rel) return false;
    if (cls.targetFilterApplicable && c.target?.questionTypes?.length) {
      if (!c.target.questionTypes.includes(cls.question_type)) return false;
    }
    const stat = tables.stats.get(`AD#${c.adId}`, `DATE#${today}`);
    if ((stat?.cost ?? 0) + c.unitPriceCitation > c.dailyBudget) return false;
    return true;
  });
  if (valid.length === 0) return [];

  // G-6 スコアリング・枠割当 + G-7 予算計上(条件付き加算・不成立は次点繰上げ)
  const prices = valid.map((c) => c.unitPriceCitation);
  const [minP, maxP] = [Math.min(...prices), Math.max(...prices)];
  for (const c of valid) {
    c.bidNorm = maxP === minP ? 1 : (c.unitPriceCitation - minP) / (maxP - minP);
    c.linkBoost = linkBoost(c.adId, articleContentIds);
    c.score = params['weights.rel'] * c.sim + params['weights.bid'] * c.bidNorm + params['weights.link'] * c.linkBoost;
  }
  valid.sort((a, b) => b.score - a.score);
  const selected = [];
  const advertiserSlots = new Map(); // advertiserId -> 割当済み枠数
  const reserved = []; // 補償減算用 {adId, unit}
  for (const c of valid) {
    if (selected.length >= params.max_slots) break;
    if ((advertiserSlots.get(c.advertiserId) ?? 0) >= params.max_per_advertiser) continue;
    if (!reserveBudget(c, today)) {
      log('INFO', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1301', adIds: [c.adId] });
      continue;
    }
    reserved.push({ adId: c.adId, unit: c.unitPriceCitation });
    selected.push(c);
    advertiserSlots.set(c.advertiserId, (advertiserSlots.get(c.advertiserId) ?? 0) + 1);
    log('INFO', 'ad_pipeline', 'ad_selected', { pageId, adIds: [c.adId] });
  }
  if (selected.length === 0) return [];

  // G-8 リード文一括生成(失敗・検証NGはフォールバック定型文)
  const leadMap = buildLeads({ question, cls, articleContentIds }, selected, d, pageId);

  // G-9 Placement保存(TransactWrite・冪等)
  let placements;
  try {
    placements = d.savePlacements(pageId, selected, leadMap, cls, today);
  } catch (e) {
    if (e instanceof ConditionalCheckFailed) {
      // 競合で先に保存されていた場合: 今回の課金予約を補償し、既存を返す(3.5節)
      compensate(reserved, today);
      const alive = filterAlivePlacements(tables.placements.query(`PAGE#${pageId}`));
      recordImpressions(alive);
      return alive.map(toAdCard);
    }
    compensate(reserved, today);
    log('ERROR', 'ad_pipeline', 'pipeline_failed', { pageId, code: 'ADS-1201', msg: e.message });
    return [];
  }
  log('INFO', 'ad_pipeline', 'placement_saved', {
    pageId, adIds: placements.map((p) => p.adId), latencyMs: Date.now() - started,
  });

  // 生成応答のads[]も表示1回として計測する(2.6節)
  recordImpressions(placements);
  return placements.map(toAdCard);
}

/** 表示可否判定(3.3節): 現在のRagAds.statusが配信中かつキャンペーン期間内のPlacementのみ */
function filterAlivePlacements(placements) {
  const today = jstDate();
  return placements.filter((p) => {
    const meta = tables.ads.get(`AD#${p.adId}`, 'META');
    return meta && meta.status === 'delivering' && meta.campaignStart <= today && meta.campaignEnd >= today;
  });
}

/** 記事紐づけ加点: 取得記事とのLINKのうち最優先のものを採用(高=1.0/中=0.6/低=0.3) */
function linkBoost(adId, articleContentIds) {
  if (!articleContentIds?.length) return 0;
  const links = tables.ads.query(`AD#${adId}`, { skPrefix: 'LINK#' });
  let boost = 0;
  for (const l of links) {
    const contentId = l.SK.slice('LINK#'.length);
    if (articleContentIds.includes(contentId)) {
      boost = Math.max(boost, PRIORITY_BOOST[l.priority] ?? 0);
    }
  }
  return boost;
}

/** G-7 予算計上: DailyStatsへの条件付き加算(DD-001 4.2.2)。不成立=予算超過でfalse */
export function reserveBudget(ad, today = jstDate()) {
  try {
    tables.stats.update(`AD#${ad.adId}`, `DATE#${today}`, {
      add: { cost: ad.unitPriceCitation, citations: 1 },
      set: { adId: ad.adId, date: today, updatedAt: nowIso() },
      condition: (cur) => (cur?.cost ?? 0) <= ad.dailyBudget - ad.unitPriceCitation,
    });
    log('INFO', 'ad_pipeline', 'budget_reserved', { adIds: [ad.adId] });
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailed) return false;
    throw e;
  }
}

/** G-9失敗時の補償減算(3.5節) */
function compensate(reserved, today) {
  for (const r of reserved) {
    try {
      tables.stats.update(`AD#${r.adId}`, `DATE#${today}`, {
        add: { cost: -r.unit, citations: -1 },
        set: { updatedAt: nowIso() },
      });
    } catch (e) {
      log('ERROR', 'ad_pipeline', 'pipeline_failed', { code: 'ADS-1201', adIds: [r.adId], msg: `補償減算失敗: ${e.message}` });
    }
  }
}

/** G-8 リード文生成+検証。戻り値: Map(adId -> {lead, source}) */
function buildLeads(ctx, selected, d, pageId) {
  const params = getParams();
  const map = new Map();
  const fallback = { lead: params['lead.fallback_text'], source: 'fallback' };
  if (!params['lead.enabled']) {
    for (const c of selected) map.set(c.adId, fallback);
    return map;
  }
  let result = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = d.generateLeads(
        { question: ctx.question, category: ctx.cls.category, questionType: ctx.cls.question_type },
        selected.map((c) => ({ adId: c.adId, title: c.title, adText: c.adText, keywords: c.keywords, tags: c.tags }))
      );
      if (!result || !Array.isArray(result.leads)) result = null;
    } catch {
      result = null;
    }
  }
  if (!result) {
    log('WARN', 'ad_pipeline', 'lead_fallback', { pageId, code: 'ADS-1101' });
    for (const c of selected) map.set(c.adId, fallback);
    return map;
  }
  for (const c of selected) {
    const entry = result.leads.find((l) => l.adId === c.adId);
    const reason = entry ? validateLead(entry.lead) : 'missing';
    if (reason) {
      log('WARN', 'ad_pipeline', 'lead_fallback', { pageId, code: 'ADS-1102', adIds: [c.adId], msg: reason });
      map.set(c.adId, fallback);
    } else {
      map.set(c.adId, { lead: entry.lead, source: 'llm' });
      log('INFO', 'ad_pipeline', 'lead_generated', { pageId, adIds: [c.adId] });
    }
  }
  return map;
}

/** G-9 Placement保存(冪等・スナップショット保持。DD-001 5.2節) */
function savePlacements(pageId, selected, leadMap, cls, today) {
  const now = nowIso();
  const ttl = Math.floor(Date.now() / 1000) + 13 * 30 * 24 * 3600; // 13ヶ月
  const items = selected.map((c, i) => {
    const lead = leadMap.get(c.adId);
    return {
      PK: `PAGE#${pageId}`, SK: `SLOT#${i + 1}`,
      GSI1PK: `AD#${c.adId}`, GSI1SK: `TS#${now}`,
      pageId, slot: i + 1,
      adId: c.adId, advertiserId: c.advertiserId,
      adTitle: c.title, landingUrl: c.landingUrl, imageUrl: c.imageUrl ?? null,
      leadText: lead.lead, leadSource: lead.source,
      score: round4(c.score), sim: round4(c.sim), bidNorm: round4(c.bidNorm), linkBoost: c.linkBoost,
      unitPrice: c.unitPriceCitation, billedAmount: c.unitPriceCitation,
      citationChars: lead.lead.length,
      questionCategory: cls.category, questionType: cls.question_type,
      questionDigest: sha256(`PAGE#${pageId}`),
      impressions: 0, clicks: 0,
      createdAt: now, date: today, ttl,
    };
  });
  transactWrite(items.map((item) => ({ table: tables.placements, item, conditionNotExists: true })));
  // 引用文字数を日次統計へ計上(確定は日次バッチで再計算)
  for (const item of items) {
    tables.stats.update(`AD#${item.adId}`, `DATE#${today}`, {
      add: { citationChars: item.citationChars },
      set: { updatedAt: nowIso() },
    });
  }
  return items;
}

// ---- 表示時(3.3節)・クリック(6.2.3) --------------------------------------
/**
 * GET /v1/pages/{pageId}/ads: 有効性判定+表示加算(軽量パス)。
 * 有効性はPlacementスナップショットではなく現在のRagAds.statusと期間で判定する。
 */
export function getPageAds(pageId) {
  const placements = tables.placements.query(`PAGE#${pageId}`);
  if (placements.length === 0) return []; // ADS-2001: 空配列を200で返却
  const alive = filterAlivePlacements(placements);
  recordImpressions(alive);
  return alive.map(toAdCard);
}

function recordImpressions(placements) {
  const today = jstDate();
  const now = nowIso();
  for (const p of placements) {
    tables.placements.update(p.PK, p.SK, {
      add: { impressions: 1 },
      set: { lastViewedAt: now, ...(p.firstViewedAt ? {} : { firstViewedAt: now }) },
    });
    tables.stats.update(`AD#${p.adId}`, `DATE#${today}`, {
      add: { impressions: 1 },
      set: { updatedAt: now },
    });
    log('INFO', 'page_ads', 'impression', { pageId: p.pageId, adIds: [p.adId], slot: p.slot });
  }
}

/**
 * GET /r/{pageId}/{slot}: クリック計測+リダイレクト先(スナップショットのlandingUrl)を返す。
 * 不正時はnull(呼び出し側でサイトトップへ302。ADS-3001)
 */
export function recordClick(pageId, slot) {
  const slotNum = Number(slot);
  const maxSlots = getParams().max_slots;
  if (!/^[0-9a-f]{8,64}$/i.test(String(pageId)) || !Number.isInteger(slotNum) || slotNum < 1 || slotNum > maxSlots) {
    log('WARN', 'click', 'click', { code: 'ADS-3001', msg: 'invalid pageId/slot' });
    return null;
  }
  const p = tables.placements.get(`PAGE#${pageId}`, `SLOT#${slotNum}`);
  if (!p) {
    log('WARN', 'click', 'click', { pageId, slot: slotNum, code: 'ADS-3001' });
    return null;
  }
  const now = nowIso();
  tables.placements.update(p.PK, p.SK, { add: { clicks: 1 }, set: { lastClickedAt: now } });
  tables.stats.update(`AD#${p.adId}`, `DATE#${jstDate()}`, { add: { clicks: 1 }, set: { updatedAt: now } });
  log('INFO', 'click', 'click', { pageId, adIds: [p.adId], slot: slotNum });
  return p.landingUrl; // オープンリダイレクト防止: スナップショットのみ(11.2節)
}

/** Placement → 広告カードDTO(6.2.1) */
function toAdCard(p) {
  return {
    slot: p.slot,
    adId: p.adId,
    label: '広告',
    lead: p.leadText,
    title: p.adTitle,
    imageUrl: p.imageUrl ?? null,
    clickUrl: `/r/${p.pageId}/${p.slot}`,
  };
}
