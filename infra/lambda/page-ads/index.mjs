/**
 * rag-ads_page-ads: 広告取得API GET /v1/pages/{pageId}/ads (DD-001 3.3節/6.2.2)
 * Placement取得(Query)→広告有効性判定(BatchGetItem)→表示加算→カードDTO返却。
 * ローカルPoC(server/pipeline.js getPageAds)で検証済みのロジックのDynamoDB実装。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, QueryCommand, BatchGetCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE_PLACEMENTS = process.env.RAG_Ads_TABLE_PLACEMENTS;
const TABLE_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const TABLE_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const nowIso = () => new Date().toISOString();
/** JSTの暦日(予算・統計はJST日付で採番。DD-001 9.3節) */
const jstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: nowIso(), level, svc: 'page_ads', event, ...fields }));

export const handler = async (event) => {
  const started = Date.now();
  const pageId = event.pathParameters?.pageId ?? '';
  const respond = (ads) => ({
    statusCode: 200, // Placementなし・全無効・形式不正も200の空配列(6.2.2)
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ pageId, ads }),
  });

  try {
    if (!/^[0-9a-f]{8,64}$/i.test(pageId)) return respond([]);

    const q = await ddb.send(new QueryCommand({
      TableName: TABLE_PLACEMENTS,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PAGE#${pageId}` },
    }));
    const placements = (q.Items ?? []).filter((p) => String(p.SK).startsWith('SLOT#'));
    if (placements.length === 0) return respond([]); // ADS-2001

    // 有効性はスナップショットではなく現在のRagAds.statusと期間で判定(3.3節)
    const keys = [...new Set(placements.map((p) => p.adId))]
      .map((adId) => ({ PK: `AD#${adId}`, SK: 'META' }));
    const bg = await ddb.send(new BatchGetCommand({
      RequestItems: { [TABLE_MASTER]: { Keys: keys } },
    }));
    const metas = new Map((bg.Responses?.[TABLE_MASTER] ?? []).map((m) => [m.adId, m]));
    const today = jstDate();
    const alive = placements.filter((p) => {
      const m = metas.get(p.adId);
      return m && m.status === 'delivering' && m.campaignStart <= today && m.campaignEnd >= today;
    });

    // 表示加算(無効枠は加算しない)。計測失敗は応答を妨げない
    const now = nowIso();
    const updates = alive.flatMap((p) => [
      ddb.send(new UpdateCommand({
        TableName: TABLE_PLACEMENTS,
        Key: { PK: p.PK, SK: p.SK },
        UpdateExpression: 'ADD impressions :one SET lastViewedAt = :now, firstViewedAt = if_not_exists(firstViewedAt, :now)',
        ExpressionAttributeValues: { ':one': 1, ':now': now },
      })),
      ddb.send(new UpdateCommand({
        TableName: TABLE_STATS,
        Key: { PK: `AD#${p.adId}`, SK: `DATE#${today}` },
        UpdateExpression: 'ADD impressions :one SET updatedAt = :now, adId = if_not_exists(adId, :adId), #d = if_not_exists(#d, :date)',
        ExpressionAttributeNames: { '#d': 'date' },
        ExpressionAttributeValues: { ':one': 1, ':now': now, ':adId': p.adId, ':date': today },
      })),
    ]);
    const results = await Promise.allSettled(updates);
    for (const r of results) {
      if (r.status === 'rejected') log('WARN', 'impression_update_failed', { pageId, msg: String(r.reason) });
    }
    for (const p of alive) log('INFO', 'impression', { pageId, adIds: [p.adId], slot: p.slot });

    const ads = alive
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({
        slot: p.slot,
        adId: p.adId,
        label: '広告',
        lead: p.leadText,
        title: p.adTitle,
        imageUrl: p.imageUrl ?? null,
        clickUrl: `/r/${pageId}/${p.slot}`,
      }));
    log('INFO', 'page_ads_served', { pageId, latencyMs: Date.now() - started, adIds: ads.map((a) => a.adId) });
    return respond(ads);
  } catch (e) {
    // 広告取得の失敗はフロントが非表示にフォールバックするため空配列で返す(2.5節)
    log('ERROR', 'page_ads_failed', { pageId, code: 'ADS-2001', msg: e.message });
    return respond([]);
  }
};
