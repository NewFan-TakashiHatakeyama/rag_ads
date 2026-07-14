# NewFan-Finance 媒体側繋ぎ込みキット(フェーズ2)

finance.newfan.co.jp への RAG広告配信システム組み込み手順。
既存システムへの変更は**次の3点に限定**される(NF-RAGAD-BD-001 3.4節)。
**すべてフィーチャーフラグOFF(`/rag_ads/{env}/enabled = false`)のまま先行デプロイする**(DD-001 13.1/13.2 段階0)。

---

## 変更点1: 回答生成Lambdaへの ad_pipeline 組み込み

既存の回答生成Lambda(Python 3.12)に広告パイプライン(DD-001 3.2節 G-1〜G-10)を組み込む。

- **移植元(仕様の正)**: 本リポジトリ `server/pipeline.js` / `server/llm.js` / `server/vector.js`。
  ロジックはテスト48件(`tests/`。DD-001 12.3 IT-01〜IT-21相当)で検証済みであり、
  Python移植時はこのテストケース一覧を検収基準として使用する。
- **必須の振る舞い**(移植時に落としてはならないもの):
  1. フラグOFF時はG-3以降を実行しない(SSM `/rag_ads/{env}/enabled`。5分キャッシュ)
  2. 広告パイプラインの例外は回答生成へ伝播させない(全体をtry-except・広告なしで返す。3.4節)
  3. 回答のストリーミング返却をブロックしない(並行実行。3.2節)
  4. Placement保存は`attribute_not_exists(PK)`条件付きTransactWriteItemsで冪等(3.5節)
  5. 予算計上は条件付き加算(`cost <= :limit - :u`)、保存失敗時は補償減算(4.2.2/3.5節)
  6. 同一広告主は1ページ`max_per_advertiser`枠まで(**カウンタで実装**。Set存在判定は2以上で壊れる — ローカル実装のコードレビューで検出済みの不具合パターン)
  7. リード文は生成後に検証(20〜60字・NG辞書・URL/HTML/改行・「広告」語)し、NG時はフォールバック定型文
- **接続先**: DataStackの3テーブル(`rag_ads_*_{env}`)、S3 Vectors `rag-ads-index-{env}`、
  Bedrock(`/rag_ads/{env}/lead.model_id`)。IAMは既存Lambda実行ロールへ最小権限で追加。

## 変更点2: 回答生成レスポンスへの ads[] 付加

回答確定時に以下のスキーマで`ads[]`を付加する(DD-001 6.2.1。0件時は`"ads": []`)。
実装位置は既存レスポンス方式に合わせ、(a)ストリーム末尾のメタイベント、または(b)回答確定後のページ情報取得、のいずれか。

```json
"ads": [
  {
    "slot": 1,
    "adId": "01JZX8G4N0EXAMPLE",
    "label": "広告",
    "lead": "変動金利の見直しを検討中の方に、返済シミュレーションの無料相談があります。",
    "title": "住宅ローン借り換え無料診断",
    "imageUrl": "https://cdn.example.com/loan-checkup.jpg",
    "clickUrl": "/r/4732574e907f.../1"
  }
]
```

## 変更点3: Next.jsフロントへの AdSlotBlock 配置

1. `AdSlotBlock.tsx` と `AdSlotBlock.module.css` を既存リポジトリの `components/` へコピー
2. 回答ページの **Related直上** に1箇所配置(DD-001 2.1節。回答本文・情報源・Relatedには手を加えない):

```tsx
import AdSlotBlock from '@/components/AdSlotBlock';

{/* 情報源(Sources)と Related の間 = Related直上 */}
<AdSlotBlock
  pageId={pageId}
  initialAds={generatedAds /* 初回生成応答のads[]。再訪ページではundefined */}
  apiBase={process.env.NEXT_PUBLIC_RAG_ADS_API_BASE ?? ''}
/>
```

挙動仕様(コンポーネント内に実装済み・ローカルPoCで実機検証済み):
高さ予約(PC240/SP160px)→3秒タイムアウト→0件/失敗はブロックごと非表示・リトライなし・
「広告」ラベル常時表示・全テキストエスケープ描画・`rel="nofollow sponsored noopener"`。

## インフラ前提(媒体側で必要な設定)

- **同一ドメイン配下へのルーティング**(DD-001 6.1節): `/v1/pages/*/ads` と `/r/*` を
  `api.finance.newfan.co.jp`(または同等)へ向ける。CloudFrontのビヘイビア追加
  またはAPI Gatewayカスタムドメインで実現。`apiBase`にそのベースURLを設定。
- CORS: 別ドメイン運用の場合はApiStackの`corsOrigins`に`https://finance.newfan.co.jp`を設定。

## デプロイ・公開手順(DD-001 13.2)

| 段階 | 操作 | 判定基準 |
|---|---|---|
| 0 | 上記3点をフラグOFFのままリリース | スモーク通過・既存機能の無影響(レイテンシ・エラー率) |
| 1 | `PUT /v1/params {"enabled": true}` + 社内アカウント限定 | 表示崩れなし・アラームなし3日間 |
| 2 | pageIdハッシュで実トラフィック10% | AdFillRate・レイテンシ・エラー率が目標内で7日間 |
| 3 | 100% | 検証運用(BD-001 11章)へ移行 |

ロールバック一次手段はフラグOFF(即時・デプロイ不要。13.3節)。
`enabled=false`の間も広告取得APIは空配列を返し、AdSlotBlockは自動的に非表示になる。
