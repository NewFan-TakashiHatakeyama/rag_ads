# 【要対応・媒体側】S3 Vectors 索引と記事テーブルの同期不整合

> 対象: NewFan-Finance(媒体)/ 発見日: 2026-07-15 / 影響度: **高(媒体自身のRAG回答品質に直撃)**
> 発見経緯: RAG広告の「コンテンツ紐づけ」をANN検索化した際、候補記事の大半が実在しないことから判明。

---

## 1. 事象

**媒体の S3 Vectors 索引に、既に削除された記事のベクトルが残り続けている。**

`prna-articles`(DynamoDB)は **TTL 30日**で古い記事を自動削除するが、
`newfan-finance-vectors / prna-articles`(S3 Vectors)側のベクトルは**一切削除されていない**。
その結果、索引には「記事本体が存在しないベクトル(=幽霊エントリ)」が無期限に蓄積している。

### 実測値(2026-07-15 / 本番データ)

| 項目 | 実測 |
|---|---|
| DynamoDB 実記事数 | **962件** |
| TTL 設定 | **ENABLED**(属性 `ttl`)・保持 **30日** |
| pubDate 範囲 | **2026-06-14 〜 2026-07-14**(=直近30日のみ) |
| ANN検索 上位20件のうち**実在**した記事 | **3件** |
| ANN検索 上位20件のうち**幽霊**(削除済み) | **17件(85%)** |
| 索引に対する実在率(推定) | **約15%** |

例: `article_id=31c3d1e5…`(Habitat for Humanity・pub_date 2026-03-24)は
索引に存在するが、DynamoDB には存在しない(30日を過ぎTTL削除済み)。

---

## 2. 影響

### ⚠️ 媒体自身のRAG回答品質(最も重大)
`src/lib/aws/s3-vectors-search.ts` の検索は
**① S3 Vectors QueryVectors → ② article_id → ③ DynamoDB BatchGetItem** の順で本文を取得する。
索引の**約85%が幽霊**のため、**topK=10 で検索しても本文が取れるのは平均1〜2件程度**にまで目減りする。

- 「関連する記事が見つかりませんでした」と回答されるケースが増える
- Sources に無関係な記事だけが並ぶ(たまたま生き残った記事が採用されるため)
- **retrieval が実質的に機能不全**に近い状態

### RAG広告の紐づけ
候補記事の詳細が404、紐づけも不可になる(**広告システム側は防御実装済み**: ANNを多めに取得し
DynamoDBへのBatchGetで実在分のみに絞る。ただし候補数が目減りするため根本解決にはならない)。

---

## 3. 原因

`lambda/prna-vectors-ingestor/s3-vectors-client.ts` に **削除系の実装が存在しない**。

```ts
// 現状のエクスポート(確認済み)
export async function putVector(input: VectorInput): Promise<void>      // 追加のみ
export async function putVectorsBatch(inputs: VectorInput[]): Promise<number>  // 追加のみ
// ← DeleteVectors に相当する関数が無い
```

記事のライフサイクルは DynamoDB の TTL に委ねられているが、
**TTL は DynamoDB のアイテムを消すだけで、S3 Vectors には何の作用もしない**。
そのため「記事は消える / ベクトルは残る」という片側だけの削除になっている。

---

## 4. 対応(2段構え)

### 対策A(恒久): TTL削除に連動してベクトルを削除する

**DynamoDB Streams** を使い、TTL削除イベントを拾って `DeleteVectors` を呼ぶ。

1. `prna-articles` の **Streams を有効化**(`NEW_AND_OLD_IMAGES`)。
2. Stream を購読する Lambda を新設し、**REMOVE イベント**を処理する。
   - TTL削除は `userIdentity.principalId === 'dynamodb.amazonaws.com'` かつ
     `userIdentity.type === 'Service'` で判別できる(手動削除と区別したい場合)。
   - 実運用では「REMOVE なら消す」で十分(手動削除でもベクトルは消すべきため)。
3. `s3-vectors-client.ts` に削除関数を追加する。

```ts
import { DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';

/** 記事削除に連動してベクトルを削除する(TTL削除・手動削除の両方で使う) */
export async function deleteVectors(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // DeleteVectors はキー配列を受け取る。大量削除時は分割する
  const BATCH = 100;
  for (let i = 0; i < keys.length; i += BATCH) {
    await client.send(new DeleteVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      keys: keys.slice(i, i + BATCH),
    }));
  }
}
```

```ts
// Stream購読Lambda(例)
export const handler = async (event: DynamoDBStreamEvent) => {
  const removed = event.Records
    .filter((r) => r.eventName === 'REMOVE')
    .map((r) => r.dynamodb?.Keys?.url_hash?.S)
    .filter((k): k is string => !!k);
  if (removed.length) await deleteVectors(removed);
};
```

> **注意**: ベクトルのキーは `url_hash`(= `article_id`)。索引の key と DynamoDB の PK が
> 一致している前提の設計なので、そのまま削除キーに使える。

### 対策B(既存分の棚卸し): 蓄積済みの幽霊ベクトルを一括削除

対策Aを入れても**過去に溜まった幽霊は消えない**ため、一度だけ棚卸しが必要。

1. S3 Vectors の `ListVectors` で索引の全キーを列挙する。
2. DynamoDB へ `BatchGetItem`(100件ずつ)で実在チェック。
3. 実在しないキーを `DeleteVectors` で削除する。

> 広告システム側(このリポジトリ)からも同一アカウント・同一リージョンで実行可能。
> **本番データの削除**になるため、実行前に必ず「削除対象件数」をドライランで確認すること。

### 対策C(代替・要検討): そもそもTTLで消すべきか
現状の保持は **30日のみ**。RAGの回答品質は記事の網羅性に依存するため、
「30日で消す」設計自体が回答品質の上限を決めてしまっている。
コスト都合でなければ **保持期間の延長 or TTL廃止**も選択肢(その場合、索引との不整合も起きにくくなる)。

---

## 5. 検証方法

対応後、以下で健全性を確認する。

```
① 索引の実在率: ListVectors の全キー → DynamoDB BatchGet → 実在率が 100% に近いこと
② retrieval: 適当な質問で topK=10 検索 → 本文が取れる件数が 10 に近いこと
③ TTL連動: テスト記事を作成→ベクトル投入→ttlを直近に設定→削除後に
   GetVectors でベクトルが消えていること
```

---

## 6. 関連する別論点(コンテンツ拡充)

同時に判明した事実として、**媒体の実記事962件に消費者向け金融記事が存在しない**。

| キーワード | タイトル一致 | 本文一致 |
|---|---|---|
| 住宅ローン / 借り換え / 変動金利 / 固定金利 | **0件** | **0件** |
| NISA / iDeCo / 家計 | 0件 | 0件 |
| 金利 | 0件 | 1件 |

カテゴリ内訳: `english 647 / prnewswire 269 / finance 45 / capital 1`(**英語のPRが67%**)。

RAG広告の紐づけ・関連度は記事コーパスに依存するため、
**広告テーマ(住宅ローン等)に合う記事が無い限り、紐づけは機能しない**。
索引同期の修正とは別に、**コンテンツ方針の決定**が必要(記事側を拡充するか、
既存コーパス=BtoB/英語PRに合う広告在庫に寄せるか)。

---

## 参照
- 広告システム側の防御実装: `infra/lambda/admin-api/index.mjs`(`filterLiveContents`)
- 媒体の検索経路: `src/lib/aws/s3-vectors-search.ts`
- 媒体の投入経路: `lambda/prna-vectors-ingestor/`(`s3-vectors-client.ts` に削除実装が無い)
