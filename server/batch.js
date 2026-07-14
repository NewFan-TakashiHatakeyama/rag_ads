/**
 * 日次集計バッチ(DD-001 9.1〜9.2節。本番: rag-ads_daily-agg / EventBridge 04:00 JST)。
 * 前日分の確定値をPlacement走査から再計算して上書きし(冪等)、期限切れ広告を処理する。
 * 表示・クリックは速報値を保持し、citations・cost・citationCharsのみ再計算対象(9.1節)。
 */
import { tables } from './store.js';
import { syncVector } from './adminApi.js';
import { jstDate, jstDateOffset, nowIso, log } from './util.js';

/**
 * @param {string} [targetDate] 対象日(YYYY-MM-DD)。省略時は前日(JST)。再実行時は日付指定可
 * @returns {{target: string, finalized: number, expired: number}}
 */
export function runDailyAgg(targetDate) {
  const target = targetDate ?? jstDateOffset(-1);
  const ads = tables.ads.scan((it) => it.SK === 'META');

  // GSI1(AD#{adId}×TS#{createdAt})走査相当: 対象日のPlacementを1回の走査で広告別にグループ化
  const byAd = new Map();
  for (const p of tables.placements.scan((it) => String(it.SK).startsWith('SLOT#') && it.date === target)) {
    if (!byAd.has(p.adId)) byAd.set(p.adId, []);
    byAd.get(p.adId).push(p);
  }

  let finalized = 0;
  for (const ad of ads) {
    const items = byAd.get(ad.adId) ?? [];
    const existing = tables.stats.get(`AD#${ad.adId}`, `DATE#${target}`);
    if (items.length === 0 && !existing) continue; // 実績なし・速報もなし
    tables.stats.update(`AD#${ad.adId}`, `DATE#${target}`, {
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
  log('INFO', 'daily_agg', 'agg_finalized', { msg: target, latencyMs: 0 });

  // 状態遷移の自動処理(表10のシステム(自動)行)
  const today = jstDate();
  let expired = 0;
  let started = 0;
  for (const ad of ads) {
    const stamp = () => ({ GSI1SK: `UPDATED#${nowIso()}`, updatedAt: nowIso() });
    // 期限切れ(9.2節): 終了日経過 → expired + DeleteVectors(approved待機中も対象)
    if ((ad.status === 'delivering' || ad.status === 'approved') && ad.campaignEnd < today) {
      const next = { ...ad, status: 'expired', GSI1PK: 'STATUS#expired', ...stamp() };
      tables.ads.put(next);
      syncVector(next);
      expired++;
      log('INFO', 'daily_agg', 'ad_expired', { adIds: [ad.adId] });
      continue;
    }
    // 配信開始(表10: approved→delivering・システム(自動)): 開始日到来でベクトル登録
    if (ad.status === 'approved' && ad.campaignStart <= today && ad.campaignEnd >= today) {
      const next = { ...ad, status: 'delivering', GSI1PK: 'STATUS#delivering', ...stamp() };
      tables.ads.put(next);
      syncVector(next);
      started++;
      log('INFO', 'daily_agg', 'ad_delivery_started', { adIds: [ad.adId] });
    }
  }
  return { target, finalized, expired, started };
}

// CLI実行: node server/batch.js [YYYY-MM-DD]
if (process.argv[1] && process.argv[1].endsWith('batch.js')) {
  const { loadFromDisk, saveNow } = await import('./store.js');
  loadFromDisk();
  const result = runDailyAgg(process.argv[2]);
  saveNow();
  console.log(JSON.stringify(result));
}
