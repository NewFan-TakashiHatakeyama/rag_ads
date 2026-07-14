import './setup.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshWorld, makeAd, admin, tables, adVectorIndex,
  runAdPipeline, getPageAds, recordClick, answerQuestion, reserveBudget,
  runDailyAgg, setParams, jstDate, jstDateOffset,
  ADV1, ADV2, ADV3, ADMIN,
} from './helpers.js';

const Q = '住宅ローンの借り換えを検討しています。変動金利と固定金利はどちらがいいですか？';
const PAGE = 'a1b2c3d4e5f6a7b8c9d0e1f2';

function pipeline(pageId = PAGE, deps = {}) {
  return runAdPipeline({ pageId, question: Q, articleContentIds: ['C-LOAN'] }, deps);
}
function stats(adId, date = jstDate()) {
  return tables.stats.get(`AD#${adId}`, `DATE#${date}`);
}

beforeEach(() => freshWorld());

// IT-01 正常配置(3枠): スコア降順・広告主重複なし・Placement/課金3件
test('IT-01: 有効広告5件から3枠を配置し課金計上する', () => {
  const ids = [
    makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン'], unitPrice: 12 }),
    makeAd(ADV2, { topic: '固定金利プラン比較', keywords: ['固定金利', '住宅ローン'], unitPrice: 10 }),
    makeAd(ADV3, { topic: '住宅ローン返済相談', keywords: ['返済', '住宅ローン'], unitPrice: 8 }),
    makeAd(ADV1, { topic: '変動金利の見直し', keywords: ['変動金利'], unitPrice: 6, title: '2本目(同一広告主)' }),
    makeAd(ADV2, { topic: '住宅購入の資金計画', keywords: ['資金計画'], unitPrice: 5, title: '2本目(広告主2)' }),
  ];
  const ads = pipeline();
  assert.equal(ads.length, 3);
  assert.deepEqual(ads.map((a) => a.slot), [1, 2, 3]);
  // スコア降順 = Placementのscore降順
  const placements = tables.placements.query(`PAGE#${PAGE}`);
  assert.equal(placements.length, 3);
  const scores = placements.map((p) => p.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  // 広告主重複なし
  const advertisers = placements.map((p) => p.advertiserId);
  assert.equal(new Set(advertisers).size, 3);
  // 課金: 各広告のDailyStatsにcost/citationsが1件分
  for (const p of placements) {
    const s = stats(p.adId);
    assert.equal(s.citations, 1);
    assert.equal(s.cost, p.unitPrice);
  }
  // 全カードに「広告」ラベル・計測URL
  for (const a of ads) {
    assert.equal(a.label, '広告');
    assert.match(a.clickUrl, new RegExp(`^/r/${PAGE}/[123]$`));
  }
  assert.ok(ids.length === 5);
});

// IT-02 候補0件
test('IT-02: 配信中広告なしでads空・正常応答', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え', status: 'paused' });
  const ads = pipeline();
  assert.deepEqual(ads, []);
  assert.equal(tables.placements.query(`PAGE#${PAGE}`).length, 0);
});

// IT-03 閾値足切り
test('IT-03: 関連度が閾値未満の広告は配置されない', () => {
  setParams({ theta_rel: 0.5 });
  makeAd(ADV1, { topic: 'まったく無関係な観葉植物の育て方講座', title: '観葉植物サブスク', keywords: ['観葉植物'] });
  const ads = pipeline();
  assert.deepEqual(ads, []);
});

// IT-04 予算超過除外: 残予算<単価の広告は除外され次点が繰上げ
test('IT-04: 予算超過の広告は除外され次点が繰上げられる', () => {
  const top = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン', '変動金利', '固定金利'], unitPrice: 100, dailyBudget: 100 });
  const second = makeAd(ADV2, { topic: '住宅ローンの相談', keywords: ['住宅ローン'], unitPrice: 10, dailyBudget: 1000 });
  // topの当日予算を使い切る
  assert.equal(reserveBudget({ adId: top, unitPriceCitation: 100, dailyBudget: 100 }), true);
  const ads = pipeline();
  assert.equal(ads.length, 1);
  assert.equal(ads[0].adId, second);
  // topは追加課金されていない(100のまま)
  assert.equal(stats(top).cost, 100);
});

// IT-05 同一広告主制御
test('IT-05: 同一広告主の広告は1枠まで', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン'] });
  makeAd(ADV1, { topic: '住宅ローン返済プラン比較', keywords: ['返済', '住宅ローン'], title: '同一広告主2本目' });
  const ads = pipeline();
  assert.equal(ads.length, 1);
});

// IT-06 リード生成失敗 → 全枠フォールバック・配置課金は成立
test('IT-06: リード生成失敗時はフォールバック文で配置が成立する', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const ads = pipeline(PAGE, { generateLeads: () => { throw new Error('bedrock error'); } });
  assert.equal(ads.length, 1);
  assert.equal(ads[0].lead, 'ご質問に関連するサービスのご案内です。');
  const p = tables.placements.query(`PAGE#${PAGE}`)[0];
  assert.equal(p.leadSource, 'fallback');
  assert.equal(stats(p.adId).cost, p.unitPrice); // 課金成立
});

// IT-07 リード検証NG → 該当広告のみフォールバック
test('IT-07: NG表現を含むリードはフォールバックへ置換される', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const b = makeAd(ADV2, { topic: '固定金利プラン比較', keywords: ['固定金利', '住宅ローン'] });
  const ads = pipeline(PAGE, {
    generateLeads: (ctx, adsIn) => ({
      leads: adsIn.map((x) => ({
        adId: x.adId,
        lead: x.adId === a ? '必ず得する住宅ローンの借り換えプランをご案内します。' : 'ご質問に関連する住宅ローンの比較サービスのご案内です。',
      })),
    }),
  });
  assert.equal(ads.length, 2);
  const pa = tables.placements.query(`PAGE#${PAGE}`).find((p) => p.adId === a);
  const pb = tables.placements.query(`PAGE#${PAGE}`).find((p) => p.adId === b);
  assert.equal(pa.leadSource, 'fallback'); // NG語「必ず」
  assert.equal(pb.leadSource, 'llm');
});

// IT-08 保存失敗の補償: 課金加算が減算で相殺される
test('IT-08: Placement保存失敗時は課金を補償減算し広告なしで終了', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const ads = pipeline(PAGE, { savePlacements: () => { throw new Error('transact failed'); } });
  assert.deepEqual(ads, []);
  const s = stats(a);
  assert.equal(s.cost, 0);      // 加算→補償減算で相殺
  assert.equal(s.citations, 0);
});

// IT-09 冪等性: 同一pageIdの2回実行で二重計上されない
test('IT-09: 同一pageIdで2回実行しても課金・Placementは1回分', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  const first = pipeline();
  const second = pipeline();
  assert.equal(first.length, 1);
  assert.deepEqual(second.map((a) => a.adId), first.map((a) => a.adId));
  const p = tables.placements.query(`PAGE#${PAGE}`);
  assert.equal(p.length, 1);
  assert.equal(stats(p[0].adId).citations, 1); // 二重計上なし
  assert.equal(p[0].impressions, 0);           // 生成時は表示を計上しない(実表示はpage-adsフェッチ時のみ)
});

// IT-10 表示(全有効)
test('IT-10: 広告取得APIで全枠返却・表示が加算される', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  makeAd(ADV2, { topic: '固定金利プラン比較', keywords: ['固定金利', '住宅ローン'] });
  pipeline();
  const before = tables.placements.query(`PAGE#${PAGE}`);
  const ads = getPageAds(PAGE);
  assert.equal(ads.length, 2);
  const after = tables.placements.query(`PAGE#${PAGE}`);
  for (let i = 0; i < after.length; i++) {
    assert.equal(after[i].impressions, before[i].impressions + 1);
  }
});

// IT-11 表示(一部無効): 停止枠は除外・加算されない
test('IT-11: 停止した広告の枠は除外され表示加算されない', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン', '変動金利', '固定金利'], unitPrice: 20 });
  const b = makeAd(ADV2, { topic: '固定金利プラン比較', keywords: ['固定金利', '住宅ローン'], unitPrice: 5 });
  pipeline();
  admin.patchStatus(ADV1, a, { to: 'paused' });
  const pBefore = tables.placements.query(`PAGE#${PAGE}`).find((p) => p.adId === a);
  const ads = getPageAds(PAGE);
  assert.equal(ads.length, 1);
  assert.equal(ads[0].adId, b);
  const pAfter = tables.placements.query(`PAGE#${PAGE}`).find((p) => p.adId === a);
  assert.equal(pAfter.impressions, pBefore.impressions); // 無効枠は加算なし
});

// IT-12 表示(全無効)
test('IT-12: 全広告が無効なら空配列', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  pipeline();
  admin.patchStatus(ADV1, a, { to: 'paused' });
  assert.deepEqual(getPageAds(PAGE), []);
});

// IT-13 クリック正常
test('IT-13: クリックでclicks加算・landingUrlへ302相当', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  pipeline();
  const url = recordClick(PAGE, 1);
  assert.equal(url, 'https://www.example.co.jp/lp');
  const p = tables.placements.get(`PAGE#${PAGE}`, 'SLOT#1');
  assert.equal(p.clicks, 1);
  assert.equal(stats(p.adId).clicks, 1);
});

// IT-14 クリック不正
test('IT-14: 不正なpageId/slotは計測せずトップへ(null)', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  pipeline();
  assert.equal(recordClick('unknown!!', 9), null);
  assert.equal(recordClick(PAGE, 3), null); // Placement未存在slot
  const p = tables.placements.get(`PAGE#${PAGE}`, 'SLOT#1');
  assert.equal(p.clicks, 0);
});

// IT-15 フィーチャーフラグOFF
test('IT-15: enabled=falseで広告処理を全スキップ', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'] });
  setParams({ enabled: false });
  const ads = pipeline();
  assert.deepEqual(ads, []);
  assert.equal(tables.placements.query(`PAGE#${PAGE}`).length, 0);
});

// IT-18 予算日次リセット: 翌日は新しいDATE#で加算が成立
test('IT-18: 予算は日次(JST)でリセットされる', () => {
  const ad = { adId: 'AD-BUDGET', unitPriceCitation: 100, dailyBudget: 100 };
  assert.equal(reserveBudget(ad, jstDate()), true);
  assert.equal(reserveBudget(ad, jstDate()), false);           // 当日は超過
  assert.equal(reserveBudget(ad, jstDateOffset(1)), true);     // 翌日は成立
});

// IT-19 日次集計整合
test('IT-19: 日次バッチの確定値がPlacement集計と一致する(冪等)', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'], unitPrice: 12 });
  pipeline();
  getPageAds(PAGE);   // 表示+1
  recordClick(PAGE, 1);
  const today = jstDate();
  const r1 = runDailyAgg(today);
  const s1 = stats(a, today);
  assert.equal(s1.finalized, true);
  assert.equal(s1.citations, 1);
  assert.equal(s1.cost, 12);
  assert.equal(s1.impressions, 1); // 表示時のみ計上(getPageAdsフェッチ1回。生成時は計上しない)
  assert.equal(s1.clicks, 1);
  const r2 = runDailyAgg(today);  // 再実行しても同一(冪等)
  const s2 = stats(a, today);
  assert.deepEqual({ c: s2.citations, cost: s2.cost }, { c: s1.citations, cost: s1.cost });
  assert.ok(r1.finalized >= 1 && r2.finalized >= 1);
});

// 期限切れ処理(9.2節)
test('日次バッチ: 終了日経過の配信中広告をexpiredにしベクトル削除する', () => {
  const a = makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'], end: 10 });
  // 終了日を過去に書き換え(配信中のまま)
  const ad = tables.ads.get(`AD#${a}`, 'META');
  tables.ads.put({ ...ad, campaignEnd: jstDateOffset(-1) });
  assert.equal(adVectorIndex.has(a), true);
  runDailyAgg();
  assert.equal(tables.ads.get(`AD#${a}`, 'META').status, 'expired');
  assert.equal(adVectorIndex.has(a), false);
});

// ターゲット制約(4.4節): 質問タイプ不一致は除外
test('ターゲット制約: questionTypesが質問分類と不一致の広告は除外', () => {
  makeAd(ADV1, {
    topic: '住宅ローン借り換え診断', keywords: ['住宅ローン'],
    target: { questionTypes: ['情報検索'] },
  });
  // Q は「〜検討しています。どちらがいいですか?」→ 提案要求
  const ads = pipeline();
  assert.deepEqual(ads, []);
});

// 回答生成統合(F-08相当): answerQuestionがページ・記事・広告を返す
test('answerQuestion: 回答ページが保存されads[]が付与される', () => {
  makeAd(ADV1, { topic: '住宅ローン借り換え診断', keywords: ['借り換え', '住宅ローン'] });
  const r = answerQuestion('住宅ローンの借り換えの損益分岐点を知りたい');
  assert.ok(r.pageId.length >= 8);
  assert.ok(r.answer.length > 0);
  assert.ok(r.sources.length > 0);
  assert.equal(tables.pages.get(`PAGE#${r.pageId}`, 'META').question, '住宅ローンの借り換えの損益分岐点を知りたい');
  assert.equal(r.ads.length, 1);
});
