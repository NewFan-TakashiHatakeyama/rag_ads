/**
 * FE-01 AdSlotBlock — NewFan-Finance 回答ページ用 広告ブロック
 * (NF-RAGAD-SD-001 8章 / NF-RAGAD-DD-001 2章)
 *
 * 配置: 回答ページのRelated直上に1箇所(DD-001 2.1節)。
 * 挙動(ローカルPoCのweb/site/adslot.jsで検証済みの仕様と同一):
 *  - initialAds があればフェッチせず直接描画(初回生成応答のads[]。2.5節)
 *  - マウント時に GET {apiBase}/v1/pages/{pageId}/ads をクライアントフェッチ
 *    (回答本文のストリーミング描画とは完全独立。タイムアウト3秒・リトライなし・no-store)
 *  - 0件・エラー・タイムアウトはブロックごと非表示(collapse)。エラーは閲覧者に表示しない
 *  - 取得完了まで高さを予約(PC 240px / SP 160px)しCLSを防止(2.4節)
 *  - 「広告」ラベルは全カード必須。非表示化・文言変更のコードパスを設けない(景表法対応)
 *  - 広告由来テキストはReactの既定エスケープで描画。dangerouslySetInnerHTMLは使用禁止(11.2節)
 */
'use client';

import { useEffect, useState } from 'react';
import styles from './AdSlotBlock.module.css';

export type Ad = {
  slot: number;
  adId: string;
  label: string;
  lead: string;
  title: string;
  imageUrl: string | null;
  clickUrl: string;
};

type Props = {
  pageId: string;
  /** 初回生成応答のads[]。指定時はフェッチを省略して直接描画(DD-001 2.5節) */
  initialAds?: Ad[];
  /** 広告APIのベースURL。同一ドメイン配下に統合する場合は省略(既定: '') */
  apiBase?: string;
};

type State =
  | { phase: 'loading' }
  | { phase: 'resolved'; ads: Ad[] };

export default function AdSlotBlock({ pageId, initialAds, apiBase = '' }: Props) {
  const [state, setState] = useState<State>(
    Array.isArray(initialAds) ? { phase: 'resolved', ads: initialAds } : { phase: 'loading' }
  );

  useEffect(() => {
    if (Array.isArray(initialAds)) return; // フェッチ省略
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000); // タイムアウト3秒(2.5節)
    fetch(`${apiBase}/v1/pages/${encodeURIComponent(pageId)}/ads`, {
      cache: 'no-store',
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : { ads: [] }))
      .then((data: { ads?: Ad[] }) => setState({ phase: 'resolved', ads: data.ads ?? [] }))
      .catch(() => setState({ phase: 'resolved', ads: [] })) // 失敗時は非表示・リトライなし
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [pageId, apiBase, initialAds]);

  // 取得完了まで高さのみ予約(スケルトンは表示しない。SD-001 8.1)
  if (state.phase === 'loading') {
    return <div className={styles.reserve} aria-hidden="true" />;
  }
  // 0件時は「スポンサー」見出しごと非表示(collapse)
  if (state.ads.length === 0) return null;

  const ads = [...state.ads].sort((a, b) => a.slot - b.slot); // slot昇順=生成時スコア降順

  return (
    <aside className={styles.block} aria-label="スポンサー">
      <div className={styles.heading}>スポンサー</div>
      <div className={styles.cards}>
        {ads.map((ad) => (
          <AdCard key={ad.slot} ad={ad} apiBase={apiBase} />
        ))}
      </div>
    </aside>
  );
}

function AdCard({ ad, apiBase }: { ad: Ad; apiBase: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <a
      className={styles.card}
      href={`${apiBase}${ad.clickUrl}`} // 計測URL(/r/{pageId}/{slot})経由。宛先の偽装はしない
      target="_blank"
      rel="nofollow sponsored noopener"
    >
      {/* ラベルは常時表示・省略不可(F-13) */}
      <span className={styles.label}>{ad.label || '広告'}</span>
      <div className={styles.lead}>{ad.lead}</div>
      {ad.imageUrl && !imgFailed && (
        <div className={styles.imgBox}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 外部CDN画像のためnext/image最適化対象外 */}
          <img src={ad.imageUrl} alt="" loading="lazy" onError={() => setImgFailed(true)} />
        </div>
      )}
      <div className={styles.title}>{ad.title}</div>
      <div className={styles.cta}>詳細を見る →</div>
    </a>
  );
}
