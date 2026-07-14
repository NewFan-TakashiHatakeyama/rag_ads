/**
 * rag-ads_daily-agg: 日次集計バッチ(DD-001 9.1〜9.2節。EventBridge 04:00 JST起動)
 *  ① 前日分の確定値(citations/cost/citationChars)をPlacement走査から再計算(冪等・
 *     impressions/clicksは速報値を保持)。
 *  ② 状態自動遷移(表10のシステム(自動)行):
 *     - 期限切れ: campaignEnd < 当日 かつ (delivering|approved) → expired + DeleteVectors(9.2節)
 *     - 配信開始: approved かつ campaignStart <= 当日 <= campaignEnd → delivering + PutVectors
 *  配信可否の一次判定はS3 Vectorsメタデータフィルタ(期間・status)で行っているため、
 *  バッチ遅延は配信誤りに直結しない二重防御の構成(9.2節)。
 *
 * ローカルPoC server/batch.js(テスト検証済み)のロジックを実DynamoDB/S3 Vectors/Bedrockへ移植。
 */
import {
  getItem, query, updateItem,
  embed, adEmbeddingText, putVector, deleteVector,
  jstDate, jstDateOffset, nowIso, log,
} from 'ragshared';

const T_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const T_PLACEMENTS = process.env.RAG_Ads_TABLE_PLACEMENTS;
const T_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;

/** JST日付 target のUTC時刻範囲(Placement GSI1SK=TS#{createdAt}の走査に使用) */
function utcTsRange(target) {
  const startMs = new Date(`${target}T00:00:00+09:00`).getTime();
  return { start: `TS#${new Date(startMs).toISOString()}`, end: `TS#${new Date(startMs + 86400000).toISOString()}` };
}

/** ステータス別の広告一覧(GSI1: STATUS#{status}) */
async function adsByStatus(status) {
  return query(T_MASTER, `STATUS#${status}`, { indexName: 'GSI1' });
}

/** ベクトル同期: delivering はPut(埋め込み生成)、それ以外はDelete。失敗はログのみ(9.2節: 本番はDLQ) */
async function syncVector(ad) {
  try {
    if (ad.status === 'delivering') await putVector(ad, await embed(adEmbeddingText(ad)));
    else await deleteVector(ad.adId);
  } catch (e) {
    log('ERROR', 'daily_agg', 'vector_sync_failed', { adIds: [ad.adId], msg: e.message });
  }
}

export const handler = async (event = {}) => {
  const target = event.date ?? jstDateOffset(-1); // 再実行時は日付指定可(9.1節)
  const today = jstDate();
  const started = Date.now();

  // ---- ① 確定値の再計算 ----
  // 対象日に実績があり得るステータスの広告を集計対象とする
  const aggAds = [...await adsByStatus('delivering'), ...await adsByStatus('paused'), ...await adsByStatus('expired')];
  const { start, end } = utcTsRange(target);
  let finalized = 0;
  for (const ad of aggAds) {
    const items = await query(T_PLACEMENTS, `AD#${ad.adId}`, { indexName: 'GSI1', skBetween: [start, end] });
    const existing = await getItem(T_STATS, { PK: `AD#${ad.adId}`, SK: `DATE#${target}` });
    if (items.length === 0 && !existing) continue;
    await updateItem(T_STATS, { PK: `AD#${ad.adId}`, SK: `DATE#${target}` }, {
      set: {
        adId: ad.adId, date: target,
        citations: items.length,
        cost: items.reduce((s, p) => s + (p.billedAmount ?? 0), 0),
        citationChars: items.reduce((s, p) => s + (p.citationChars ?? 0), 0),
        finalized: true, updatedAt: nowIso(),
      },
    });
    finalized++;
  }
  log('INFO', 'daily_agg', 'agg_finalized', { msg: target, latencyMs: Date.now() - started });

  // ---- ② 状態自動遷移(表10のシステム(自動)行) ----
  let expired = 0;
  let started2 = 0;
  const stamp = () => ({ GSI1SK: `UPDATED#${nowIso()}`, updatedAt: nowIso() });

  // 期限切れ: campaignEnd < 当日(delivering / approved が対象)
  for (const ad of [...await adsByStatus('delivering'), ...await adsByStatus('approved')]) {
    if (ad.campaignEnd < today) {
      const next = { ...ad, status: 'expired', GSI1PK: 'STATUS#expired', ...stamp() };
      await updateItem(T_MASTER, { PK: `AD#${ad.adId}`, SK: 'META' }, { set: { status: 'expired', GSI1PK: 'STATUS#expired', GSI1SK: next.GSI1SK, updatedAt: next.updatedAt } });
      await syncVector(next);
      expired++;
      log('INFO', 'daily_agg', 'ad_expired', { adIds: [ad.adId] });
    }
  }

  // 配信開始: approved かつ 開始日到来・期間内 → delivering(ベクトルPut)
  for (const ad of await adsByStatus('approved')) {
    if (ad.campaignStart <= today && ad.campaignEnd >= today) {
      const next = { ...ad, status: 'delivering', GSI1PK: 'STATUS#delivering', ...stamp() };
      await updateItem(T_MASTER, { PK: `AD#${ad.adId}`, SK: 'META' }, { set: { status: 'delivering', GSI1PK: 'STATUS#delivering', GSI1SK: next.GSI1SK, updatedAt: next.updatedAt } });
      await syncVector(next);
      started2++;
      log('INFO', 'daily_agg', 'ad_delivery_started', { adIds: [ad.adId] });
    }
  }

  const result = { target, finalized, expired, started: started2, latencyMs: Date.now() - started };
  log('INFO', 'daily_agg', 'done', result);
  return result;
};
