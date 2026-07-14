/**
 * rag-ads_vector-sync-retry: ベクトル同期DLQの再処理(DD-001 9.2節)
 * S3 VectorsのPut/Delete失敗メッセージを5分間隔で再試行する。
 *
 * 雛形(フェーズ1.5): DLQへエンキューする側(admin-apiのベクトル同期)が未移植のため、
 * 現段階では受信内容のログ出力のみ。実処理はadmin-api移植と同時に実装する。
 * メッセージ形式(予定): { op: "put"|"delete", adId, vector?, metadata? }
 */
const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'vector_sync_retry', event, ...fields }));

export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    log('WARN', 'vector_sync_retry_stub', {
      msg: '再処理ロジック未移植(フェーズ1.5)。メッセージを記録します',
      body: String(record.body).slice(0, 500),
    });
  }
  return { processed: (event.Records ?? []).length };
};
