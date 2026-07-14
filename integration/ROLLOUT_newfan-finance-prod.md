# NewFan-Finance 本番反映・段階公開 手順(フェーズB以降)

> 前提: **媒体の `main` ブランチ = 本番(prod)**。専用ステージングが無いため、初回反映は必ず
> **広告OFFの状態で本番へ出し、無影響を確認してから段階的に有効化**する。
> 実装(フェーズA)は `integration/DESIGN_newfan-finance-media-side.md` を参照。本書はB以降(デプロイ・検証・公開)。

---

## 0. 制御モデル(二段構え)

`main=prod`・広告システムの `enabled` はグローバル一律のため、**媒体側にロールアウトゲートを設けて対象を絞る**。

| レイヤ | 制御 | 変更方法 | 速度 |
|---|---|---|---|
| ① 広告システム マスタースイッチ | `enabled`(全体ON/OFF) | SSM `PUT /v1/params {"enabled": …}`(私が操作可) | **即時**・媒体再デプロイ不要 |
| ② 媒体 ロールアウトゲート | `ADS_ROLLOUT`(対象コホート) | Vercel環境変数 → 再デプロイ | 再デプロイ要 |

- **両方が有効な時だけ**、あるユーザーに広告が出る。
- **一次ロールバックは①を `enabled=false`**(即時・全停止・媒体無変更)。
- ②は「誰に出すか」(Preview限定 / 10% / 100%)を制御。**本番の初期値は必ず `off`**。

---

## 1. 追加実装: ロールアウトゲート(フェーズAに追加)

### 1.1 `src/lib/ads/rollout.ts`(新設)
```ts
/**
 * 広告ロールアウトゲート。ADS_ROLLOUT でコホートを制御(サーバー側のみ)。
 *   'off'（既定） | 'on'/'100' | '10'（%数値） | 'internal'（allowlist）
 * key には安定値(sessionId 優先、無ければ chatId)を渡す。
 */
export function adsActiveFor(key: string): boolean {
  const mode = (process.env.ADS_ROLLOUT ?? 'off').trim();
  if (mode === 'off' || !key) return false;
  if (mode === 'on' || mode === '100') return true;
  if (mode === 'internal') {
    const allow = (process.env.ADS_INTERNAL_KEYS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    return allow.includes(key);
  }
  const pct = parseInt(mode, 10);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  // 安定ハッシュ(同一 key は常に同じ判定 = ユーザー体験が一貫)
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 100) < pct;
}
```

### 1.2 chat route での適用(`src/app/api/chat/route.ts`)
生成API(`finalizeAds`)を**ゲートで囲む**だけでよい。ゲート外のユーザーは Placement が作られないため、
page-ads は空を返し RagAds は自動的に collapse する(**表示側の追加ゲートは不要**=下流に自然に伝播)。

```ts
import { adsActiveFor } from '@/lib/ads/rollout';

// POST内(sessionId は既存 244行目、message.chatId も既存):
const adsActive = adsActiveFor(sessionId || message.chatId);

// handleEmitterEvents に adsActive と question を渡す:
handleEmitterEvents(stream, writer, encoder, message.chatId, message.content, adsActive);

// handleEmitterEvents の 'sources' 分岐:
if (adsActive) {
  void finalizeAds({ pageId: aiMessageId, question, articleContentIds });
}
```

> これにより **Production=off の間は誰にも広告が出ない**。Preview や %指定にした環境でのみ広告が有効化される。

---

## 2. Vercel 環境変数(Production と Preview で別値)

Vercel は Production / Preview で環境変数を分けられる。これを使って**本番を守りつつ Preview で検証**する。

| 変数 | Production(=本番) | Preview(検証用) |
|---|---|---|
| `RAG_ADS_API_BASE` | `https://r29apdxkdc.execute-api.ap-northeast-1.amazonaws.com`(将来prod用に差替) | 同左 |
| `RAG_ADS_SERVICE_API_KEY` | `dev-svc-key-8569dffecfce94a02bb9b738`(将来prod用に差替) | 同左 |
| **`ADS_ROLLOUT`** | **`off`(初期)** → 段階的に `10`→`50`→`100` | **`on`**(検証時) |
| `ADS_INTERNAL_KEYS` | (internal運用時のみ) | — |

- 3変数とも**サーバー側のみ**(`NEXT_PUBLIC_` は付けない)。
- `next.config.mjs` の `/r/:path*` rewrite は `RAG_ADS_API_BASE` がある時だけ追加するガード付きに(前述)。

---

## 3. フェーズB: 本番へ「広告OFF」で反映(安全)

1. フェーズAの実装(4改修 + ロールアウトゲート)を `main` にマージ。
2. Vercel Production 環境変数: **`ADS_ROLLOUT=off`**、広告システム: **`enabled=false`**(現状のまま)。
3. `main` へ push → 本番デプロイ。
4. **本番URLで確認**:
   - 既存の回答生成・Sources・Related が**完全に無影響**。
   - 広告ブロックは**一切表示されない**(縮退)。CLS/レイアウト崩れ無し。
   - コンソール/ネットワークにエラー無し(`/api/ads` は呼ばれても空、`finalizeAds` は未実行)。

> この時点で広告は誰にも出ない。**本番反映は完全に安全**。ここまでを先行して構わない。

---

## 4. フェーズC: Preview 環境でE2E検証(本番ユーザー無影響)

1. 検証用ブランチ(またはPR)を作り、Vercel **Preview** デプロイを取得(URLは本番ドメインと別)。
2. Preview環境変数: **`ADS_ROLLOUT=on`**。
3. 私に依頼 → 広告システムを **`enabled=true`** に切替(マスターON)。
   - このとき **Production は `ADS_ROLLOUT=off` のままなので本番ユーザーには出ない**。Preview のみ広告が有効。
4. Preview URL でブラウザ実操作QA(`DESIGN_…media-side.md` 9章):
   - 関連質問→広告表示 / 非関連→collapse
   - **impression は表示1回で+1**(生成では増えない)/ リロードで+1
   - クリック→landingへ302 + `clicks`+1
   - フェイルセーフ(広告不通でも回答正常)/ 「広告」ラベル常時 / エスケープ
5. 問題があれば修正して再検証。完了したら私に依頼 → 広告システムを **`enabled=false`** に戻す。

> Preview で検証している間、本番は広告OFFのまま。安全に妥協なく検証できる。

---

## 5. フェーズD: 本番の段階公開

検証OK後、本番へ段階的に広げる。各段でVercel Production の `ADS_ROLLOUT` を上げて再デプロイし、
広告システムは `enabled=true`(マスターON)にする。

| 段階 | Production `ADS_ROLLOUT` | 広告システム `enabled` | 監視して次へ |
|---|---|---|---|
| 1(社内/限定) | `internal`(+`ADS_INTERNAL_KEYS`)または `1`(1%) | `true` | 表示崩れ・アラーム無しを数日 |
| 2(10%) | `10` | `true` | AdFillRate・レイテンシ・エラー率が目標内で数日 |
| 3(50%) | `50` | `true` | 同上 |
| 4(100%) | `100` | `true` | 検証運用へ移行 |

- 各段は **Vercel Production の `ADS_ROLLOUT` を変更 → 再デプロイ**するだけ(コード変更不要)。
- ハッシュは sessionId ベースで安定 = 同一ユーザーは一貫して出る/出ない。

---

## 6. ロールバック(異常時)

| 手段 | 操作 | 速度 | 影響 |
|---|---|---|---|
| **一次(推奨)** | 広告システム `enabled=false`(私に依頼 or 管理コンソール/SSM) | **即時** | 全ユーザーで広告即停止。媒体再デプロイ不要 |
| 二次 | Vercel Production `ADS_ROLLOUT=off` → 再デプロイ | 数分 | 媒体側からも停止 |
| 三次 | 直前コミットへ revert → 再デプロイ | 数分 | コードごと撤去 |

> 回答生成はフェイルセーフ設計のため、広告側の異常で回答が止まることはない。まず一次で止め、原因調査。

---

## 7. 監視・観測(段階公開中)

- **広告システム側**: CloudWatch ダッシュボード `RAG-Ads_Dashboard-dev`、アラート SNS
  `rag-ads_alerts-dev`(Lambdaエラー/Duration)。生成/表示/クリックのログ(`ad_pipeline`/`page_ads`/`click`)。
- **媒体側で見る指標**: 回答生成のレイテンシ・エラー率が**広告導入前と不変**であること(フェイルセーフの実証)。
- **配信品質**: AdFillRate(表示された回答/全回答)、CTR。関連度が低ければ広告システム側 `theta_rel` を調整。

---

## 8. 最短チェックリスト

- [ ] フェーズA実装 + ロールアウトゲート(1章)を `main` にマージ
- [ ] Vercel Production: `ADS_ROLLOUT=off` / 広告システム `enabled=false`
- [ ] 本番デプロイ → 既存無影響・広告非表示を確認(フェーズB)
- [ ] Preview: `ADS_ROLLOUT=on` + 広告システム `enabled=true` でE2E検証(フェーズC)
- [ ] 検証後 `enabled=false` に戻す
- [ ] Production `ADS_ROLLOUT` を `internal/1 → 10 → 50 → 100` と上げて段階公開(フェーズD)
- [ ] 異常時は `enabled=false` で即時全停止(6章)

---

## 参照
- 実装設計: `integration/DESIGN_newfan-finance-media-side.md`
- 全体像・API契約: `integration/HANDOVER_newfan-finance.md`
- ドロップイン: `integration/newfan-finance/`
