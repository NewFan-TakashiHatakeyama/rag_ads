/**
 * FE-01 AdSlotBlock (NF-RAGAD-SD-001 8章 / DD-001 2.5節)
 * 回答ページのRelated直上に表示する広告ブロック。
 *  - マウント時に GET /v1/pages/{pageId}/ads をクライアントフェッチ(回答描画と独立)
 *  - initialAds があればフェッチを省略して直接描画
 *  - タイムアウト3秒・リトライなし・失敗/0件はブロックごと非表示(collapse)。エラーは表示しない
 *  - 広告由来テキストは必ずエスケープ描画(DOM API使用。innerHTML不使用)
 *  - 「広告」ラベルは全カード必須。非表示化・文言変更のコードパスは設けない(景表法対応)
 */
'use strict';

function mountAdSlotBlock(container, pageId, initialAds) {
  container.classList.add('ad-slot');

  const renderCards = (ads) => {
    container.classList.add('resolved');
    if (!ads || ads.length === 0) {
      container.classList.add('hidden'); // 「スポンサー」見出しごと非表示(collapse)
      container.textContent = '';
      return;
    }
    container.textContent = '';
    const inner = document.createElement('div');
    inner.className = 'ad-block-inner';
    const heading = document.createElement('div');
    heading.className = 'bh';
    heading.textContent = 'スポンサー';
    inner.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'ad-cards';
    // slot昇順(=生成時スコア降順)。無効枠はAPI側で除外済み、返却分を左詰めで描画
    for (const ad of [...ads].sort((a, b) => a.slot - b.slot)) {
      grid.appendChild(buildCard(ad));
    }
    inner.appendChild(grid);
    container.appendChild(inner);
  };

  const buildCard = (ad) => {
    const card = document.createElement('a');
    card.className = 'ad-card';
    card.href = ad.clickUrl; // 計測URL(/r/{pageId}/{slot})経由。宛先の偽装はしない
    card.target = '_blank';
    card.rel = 'nofollow sponsored noopener';

    const label = document.createElement('span');
    label.className = 'ad-label';
    label.textContent = ad.label || '広告'; // ラベルは常時表示(省略不可)
    card.appendChild(label);

    const lead = document.createElement('div');
    lead.className = 'ad-lead';
    lead.textContent = ad.lead ?? '';
    card.appendChild(lead);

    if (ad.imageUrl) {
      const imgBox = document.createElement('div');
      imgBox.className = 'ad-img';
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => imgBox.remove()); // 読込失敗時は画像領域を非表示
      img.src = ad.imageUrl;
      imgBox.appendChild(img);
      card.appendChild(imgBox);
    }

    const title = document.createElement('div');
    title.className = 'ad-title';
    title.textContent = ad.title ?? '';
    card.appendChild(title);

    const cta = document.createElement('div');
    cta.className = 'ad-cta';
    cta.textContent = '詳細を見る →';
    card.appendChild(cta);
    return card;
  };

  if (Array.isArray(initialAds)) {
    renderCards(initialAds);
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000); // タイムアウト3秒
  fetch(`/v1/pages/${encodeURIComponent(pageId)}/ads`, { cache: 'no-store', signal: ctrl.signal })
    .then((res) => (res.ok ? res.json() : { ads: [] }))
    .then((data) => renderCards(data.ads ?? []))
    .catch(() => renderCards([])) // 失敗時は非表示・リトライなし・エラー非表示
    .finally(() => clearTimeout(timer));
}
