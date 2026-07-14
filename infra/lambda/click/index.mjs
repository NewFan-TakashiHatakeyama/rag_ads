/**
 * rag-ads_click: クリック計測 GET /r/{pageId}/{slot} (DD-001 6.2.3)
 * Placement参照→clicks加算→スナップショットのlandingUrlへ302。
 * 不正時は計測せずサイトトップへ302(ADS-3001)。
 * リダイレクト先はPlacementに保存済みのlandingUrlのみ(オープンリダイレクト防止。11.2節)。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_PLACEMENTS = process.env.RAG_Ads_TABLE_PLACEMENTS;
const TABLE_STATS = process.env.RAG_Ads_TABLE_DAILY_STATS;
const SITE_TOP = process.env.RAG_Ads_SITE_TOP_URL || 'https://finance.newfan.co.jp/';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const nowIso = () => new Date().toISOString();
const jstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: nowIso(), level, svc: 'click', event, ...fields }));

const redirect = (url) => ({
  statusCode: 302,
  headers: { Location: url, 'Cache-Control': 'no-store' },
  body: '',
});

export const handler = async (event) => {
  const { pageId = '', slot = '' } = event.pathParameters ?? {};
  const slotNum = Number(slot);
  try {
    // 入力の健全性チェック(枠数上限の正はPlacementの実在確認。slotは常識的範囲のみ検査)
    // pageId は媒体の messageId 形式(英数・-・_)を許容(決定C)
    if (!/^[0-9a-zA-Z_-]{8,64}$/.test(pageId) || !Number.isInteger(slotNum) || slotNum < 1 || slotNum > 99) {
      log('WARN', 'click', { code: 'ADS-3001', msg: 'invalid pageId/slot' });
      return redirect(SITE_TOP);
    }
    const g = await ddb.send(new GetCommand({
      TableName: TABLE_PLACEMENTS,
      Key: { PK: `PAGE#${pageId}`, SK: `SLOT#${slotNum}` },
    }));
    const p = g.Item;
    if (!p?.landingUrl) {
      log('WARN', 'click', { pageId, slot: slotNum, code: 'ADS-3001' });
      return redirect(SITE_TOP);
    }
    const now = nowIso();
    const today = jstDate();
    const results = await Promise.allSettled([
      ddb.send(new UpdateCommand({
        TableName: TABLE_PLACEMENTS,
        Key: { PK: p.PK, SK: p.SK },
        UpdateExpression: 'ADD clicks :one SET lastClickedAt = :now',
        ExpressionAttributeValues: { ':one': 1, ':now': now },
      })),
      ddb.send(new UpdateCommand({
        TableName: TABLE_STATS,
        Key: { PK: `AD#${p.adId}`, SK: `DATE#${today}` },
        UpdateExpression: 'ADD clicks :one SET updatedAt = :now, adId = if_not_exists(adId, :adId), #d = if_not_exists(#d, :date)',
        ExpressionAttributeNames: { '#d': 'date' },
        ExpressionAttributeValues: { ':one': 1, ':now': now, ':adId': p.adId, ':date': today },
      })),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') log('WARN', 'click_update_failed', { pageId, msg: String(r.reason) });
    }
    log('INFO', 'click', { pageId, adIds: [p.adId], slot: slotNum });
    return redirect(p.landingUrl);
  } catch (e) {
    // 計測失敗でもユーザー遷移は妨げない(サイトトップへ)
    log('ERROR', 'click_failed', { pageId, msg: e.message });
    return redirect(SITE_TOP);
  }
};
