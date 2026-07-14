/**
 * コードレビュー指摘の回帰テスト(2026-07-14レビュー)。
 * 各テストは修正済みの挙動を固定する。
 */
import './setup.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshWorld, makeAd, admin, tables,
  runAdPipeline, getPageAds, recordClick, runDailyAgg, setParams,
  jstDate, jstDateOffset, adVectorIndex,
  ADV1, ADV2, ADMIN,
} from './helpers.js';

const Q = '住宅ローンの借り換えを検討しています。変動金利と固定金利はどちらがいいですか？';
const PAGE = 'feedfacefeedfacefeedface';

function pipeline(pageId = PAGE) {
  return runAdPipeline({ pageId, question: Q, articleContentIds: [] });
}

beforeEach(() => freshWorld());

// レビュー指摘V2: max_per_advertiser >= 2 が機能すること
test('max_per_advertiser=2で同一広告主が2枠まで割当てられる', () => {
  setParams({ max_per_advertiser: 2 });
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン'] });
  makeAd(ADV1, { topic: '住宅ローン返済プラン比較', keywords: ['返済', '住宅ローン'], title: '同一広告主2本目' });
  makeAd(ADV1, { topic: '住宅ローンの金利見直し', keywords: ['変動金利', '住宅ローン'], title: '同一広告主3本目' });
  const ads = pipeline();
  assert.equal(ads.length, 2); // 3本あっても上限2
});

// レビュー指摘V3: recordClickがmax_slotsに追従すること
test('max_slots拡大時にslot4のクリックが計測される', () => {
  setParams({ max_slots: 5 });
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  pipeline();
  // SLOT#4のPlacementを直接投入(4広告主を用意する代わり)
  const p1 = tables.placements.get(`PAGE#${PAGE}`, 'SLOT#1');
  tables.placements.put({ ...p1, SK: 'SLOT#4', slot: 4, clicks: 0 });
  const url = recordClick(PAGE, 4);
  assert.equal(url, 'https://www.example.co.jp/lp');
  assert.equal(tables.placements.get(`PAGE#${PAGE}`, 'SLOT#4').clicks, 1);
  // 上限超えは引き続き不正
  assert.equal(recordClick(PAGE, 6), null);
});

// レビュー指摘V4: 冪等再実行時も表示時と同じ有効性判定を適用
test('再実行時: 停止済み広告は返却されず表示加算もされない', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const first = pipeline();
  assert.equal(first.length, 1);
  admin.patchStatus(ADV1, a, { to: 'paused' });
  const before = tables.placements.get(`PAGE#${PAGE}`, 'SLOT#1');
  const replay = pipeline(); // 同一pageIdの再実行
  assert.deepEqual(replay, []);
  const after = tables.placements.get(`PAGE#${PAGE}`, 'SLOT#1');
  assert.equal(after.impressions, before.impressions); // 加算なし
  assert.deepEqual(getPageAds(PAGE), []);
});

// レビュー指摘V7: パラメータAPIの型・範囲検証
test('PUT /v1/params: 不正な型・範囲・未定義キーはAPI-4001', () => {
  assert.throws(() => admin.putParamsApi(ADMIN, { enabled: 'false' }), (e) => e.code === 'API-4001');
  assert.throws(() => admin.putParamsApi(ADMIN, { theta_rel: 'abc' }), (e) => e.code === 'API-4001');
  assert.throws(() => admin.putParamsApi(ADMIN, { theta_rel: 1.5 }), (e) => e.code === 'API-4001');
  assert.throws(() => admin.putParamsApi(ADMIN, { max_slots: 0 }), (e) => e.code === 'API-4001');
  assert.throws(() => admin.putParamsApi(ADMIN, { unknown_key: 1 }), (e) => e.code === 'API-4001');
  assert.throws(() => admin.putParamsApi(ADMIN, { 'lead.min_chars': 80, 'lead.max_chars': 60 }), (e) => e.code === 'API-4001');
  const r = admin.putParamsApi(ADMIN, { theta_rel: 0.4, enabled: true });
  assert.equal(r.body.theta_rel, 0.4);
});

// レビュー指摘V10: approvedステータスの自動昇格(表10: システム(自動))
test('日次バッチ: approved広告は開始日到来でdeliveringへ昇格しベクトル登録される', () => {
  const adId = makeAd(ADV2, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  // シードと同様のapproved待機状態を再現
  const ad = tables.ads.get(`AD#${adId}`, 'META');
  tables.ads.put({ ...ad, status: 'approved', campaignStart: jstDate(), campaignEnd: jstDateOffset(30) });
  adVectorIndex.deleteVector(adId);
  runDailyAgg();
  assert.equal(tables.ads.get(`AD#${adId}`, 'META').status, 'delivering');
  assert.equal(adVectorIndex.has(adId), true);
});

test('日次バッチ: approved広告も終了日経過でexpiredになる', () => {
  const adId = makeAd(ADV2, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const ad = tables.ads.get(`AD#${adId}`, 'META');
  tables.ads.put({ ...ad, status: 'approved', campaignStart: jstDateOffset(-30), campaignEnd: jstDateOffset(-1) });
  adVectorIndex.deleteVector(adId);
  runDailyAgg();
  assert.equal(tables.ads.get(`AD#${adId}`, 'META').status, 'expired');
});

// レビュー指摘(G-5二重防御): ベクトルメタデータが古くてもMETAのstatusで除外される
test('G-5: ベクトル同期漏れがあってもMETAのstatus再確認で除外される', () => {
  const adId = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  // ベクトルを残したままMETAだけ停止(同期漏れを再現)
  const ad = tables.ads.get(`AD#${adId}`, 'META');
  tables.ads.put({ ...ad, status: 'paused' });
  const ads = pipeline();
  assert.deepEqual(ads, []);
});
