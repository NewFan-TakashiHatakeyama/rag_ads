/**
 * rag-ads_daily-agg: 日次集計バッチ(DD-001 9.1節。EventBridge 04:00 JST起動)
 * 前日分の確定値(citations/cost/citationChars)をPlacement走査から再計算して上書きする(冪等)。
 * 表示・クリックは速報値を保持し、確定処理では上書きしない(9.1節)。
 *
 * 未移植(フェーズ1.5): 期限切れ・配信開始の自動遷移(9.2節)。
 *  - 期限切れの一次防御はS3 Vectorsメタデータフィルタ(期間・status)のため、
 *    遷移が未実装でも期限切れ広告が配信されることはない(二重防御構成。9.2節)。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_MASTER = process.env.RAG_Ads_TABLE_MASTER;
const TABLE_PLACEMENTS = process.env.RAG_Ads_TABLE_PLACEMENTS;
const TABLE_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const nowIso = () => new Date().toISOString();
const jstDateOffset = (days) => new Date(Date.now() + 9 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);
const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: nowIso(), level, svc: 'daily_agg', event, ...fields }));

/** JST日付 target のUTC時刻範囲(GSI1SK=TS#{createdAt}の走査に使用) */
function utcRangeOfJstDate(target) {
  const start = new Date(`${target}T00:00:00+09:00`).toISOString();
  const end = new Date(new Date(`${target}T00:00:00+09:00`).getTime() + 86400e3).toISOString();
  return { start: `TS#${start}`, end: `TS#${end}` };
}

async function listAds() {
  const ads = [];
  let key;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE_MASTER,
      FilterExpression: 'SK = :meta',
      ExpressionAttributeValues: { ':meta': 'META' },
      ExclusiveStartKey: key,
    }));
    ads.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return ads;
}

async function queryPlacements(adId, target) {
  const { start, end } = utcRangeOfJstDate(target);
  const items = [];
  let key;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE_PLACEMENTS,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :s AND :e',
      ExpressionAttributeValues: { ':pk': `AD#${adId}`, ':s': start, ':e': end },
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

export const handler = async (event = {}) => {
  const target = event.date ?? jstDateOffset(-1); // 再実行時は日付指定可(9.1節)
  const started = Date.now();
  const ads = await listAds();
  let finalized = 0;

  for (const ad of ads) {
    const items = await queryPlacements(ad.adId, target);
    const existing = await ddb.send(new GetCommand({
      TableName: TABLE_STATS, Key: { PK: `AD#${ad.adId}`, SK: `DATE#${target}` },
    }));
    if (items.length === 0 && !existing.Item) continue; // 実績なし・速報もなし

    await ddb.send(new UpdateCommand({
      TableName: TABLE_STATS,
      Key: { PK: `AD#${ad.adId}`, SK: `DATE#${target}` },
      // citations/cost/citationCharsのみ確定値で上書き。impressions/clicksは速報値を保持(9.1節)
      UpdateExpression: 'SET adId = :adId, #d = :date, citations = :c, cost = :cost, citationChars = :chars, finalized = :t, updatedAt = :now',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':adId': ad.adId,
        ':date': target,
        ':c': items.length,
        ':cost': items.reduce((s, p) => s + (p.billedAmount ?? 0), 0),
        ':chars': items.reduce((s, p) => s + (p.citationChars ?? 0), 0),
        ':t': true,
        ':now': nowIso(),
      },
    }));
    finalized++;
  }

  const result = { target, finalized, ads: ads.length, latencyMs: Date.now() - started };
  log('INFO', 'agg_finalized', result);
  return result;
};
