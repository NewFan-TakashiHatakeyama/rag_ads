/**
 * NewFan-Finance 回答ページ(/c/{pageId})。
 * 既存サイト(finance.newfan.co.jp)の回答ページ構成に準拠:
 *   Sources → Answer(引用マーカー付き) → [FE-01 広告ブロック] → Related → フォローアップ入力
 * 広告ブロックはRelated直上(DD-001 2.1節)。既存表示(回答本文・情報源・Related)には手を加えない。
 */
'use strict';

const pageId = location.pathname.split('/').pop();
const root = document.getElementById('page-body');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svgIcon(paths, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** 相対時刻(topbar表示用) */
function relativeTime(iso) {
  const diff = Date.now() - Date.parse(iso);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hours 前`.replace(`${h} hours`, `${h}時間`);
  return `${Math.floor(h / 24)}日前`;
}

/** 回答本文: 段落分割し、[n]マーカーを引用チップとして描画(すべてDOM APIで組み立て) */
function renderAnswer(answerText) {
  const box = el('div', 'ans-body');
  for (const para of String(answerText ?? '').split(/\n\n+/)) {
    if (!para.trim()) continue;
    const p = el('p');
    for (const part of para.split(/(\[\d+\])/)) {
      const m = /^\[(\d+)\]$/.exec(part);
      if (m) p.appendChild(el('sup', 'cite', m[1]));
      else p.appendChild(document.createTextNode(part));
    }
    box.appendChild(p);
  }
  return box;
}

function sectionHeading(iconPaths, label) {
  const h = el('h2', 'sec-h');
  h.appendChild(svgIcon(iconPaths, 20));
  h.appendChild(el('span', null, label));
  return h;
}

/** フォローアップ質問の送信(既存チャットフロー相当。home.jsと同じ経路) */
async function askFollowUp(question, button) {
  const q = question.trim();
  if (!q) return;
  button.disabled = true;
  try {
    const res = await fetch('/v1/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    if (!res.ok) throw new Error('failed');
    const page = await res.json();
    try {
      sessionStorage.setItem(`ads:${page.pageId}`, JSON.stringify(page.ads ?? []));
      const list = JSON.parse(localStorage.getItem('recentPages') ?? '[]');
      list.unshift({ pageId: page.pageId, question: q, at: Date.now() });
      localStorage.setItem('recentPages', JSON.stringify(list.slice(0, 10)));
    } catch { /* noop */ }
    location.href = `/c/${page.pageId}`;
  } catch {
    button.disabled = false;
    button.classList.add('err');
    setTimeout(() => button.classList.remove('err'), 1500);
  }
}

async function main() {
  let page;
  try {
    const res = await fetch(`/v1/pages/${encodeURIComponent(pageId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('not found');
    page = await res.json();
  } catch {
    root.textContent = '';
    root.appendChild(el('div', 'loading-note', 'ページが見つかりませんでした。'));
    const back = el('div', 'loading-note');
    const a = el('a', null, 'ホームへ戻る');
    a.href = '/';
    back.appendChild(a);
    root.appendChild(back);
    return;
  }

  document.title = `NewFan-Finance | ${page.question}`;
  document.getElementById('topbar-title').textContent = page.question;
  document.getElementById('page-ts-text').textContent = relativeTime(page.createdAt);

  root.textContent = '';

  // 質問タイトル
  root.appendChild(el('h1', 'thread-q', page.question));

  // Sources(情報源。既存UIではカード型で回答上部に表示)
  const sources = page.sources ?? [];
  if (sources.length) {
    root.appendChild(sectionHeading(['M4 5 H16 V17 H4 Z', 'M8 8 H20 V20 H8 Z'], 'Sources'));
    const grid = el('div', 'src-cards');
    sources.forEach((s, i) => {
      const card = el('div', 'src-card');
      card.appendChild(el('div', 'sc-title', s.title));
      const foot = el('div', 'sc-foot');
      const brand = el('span', 'sc-brand');
      brand.appendChild(el('b', null, 'NF'));
      brand.appendChild(el('span', null, 'NewFan-Finance'));
      foot.appendChild(brand);
      foot.appendChild(el('span', 'sc-no', `• ${i + 1}`));
      card.appendChild(foot);
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // Answer(回答本文・出典マーカー付き)
  root.appendChild(sectionHeading(['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M12 8 a4 4 0 1 0 0 8 a4 4 0 1 0 0 -8'], 'Answer'));
  root.appendChild(renderAnswer(page.answer));

  // 回答下部の操作行(既存UI準拠の装飾)
  const actions = el('div', 'ans-actions');
  const rewrite = el('button', 'act-btn');
  rewrite.type = 'button';
  rewrite.title = 'デモでは無効';
  rewrite.appendChild(svgIcon(['M4 7 H17 L14 4', 'M20 17 H7 L10 20'], 16));
  rewrite.appendChild(el('span', null, 'Rewrite'));
  const spacer = el('span', 'spacer');
  const copyBtn = el('button', 'act-icon');
  copyBtn.type = 'button';
  copyBtn.title = '回答をコピー';
  copyBtn.appendChild(svgIcon(['M8 8 H20 V20 H8 Z', 'M4 4 H16 V6', 'M4 4 V16 H6'], 16));
  copyBtn.addEventListener('click', () => navigator.clipboard?.writeText(page.answer ?? ''));
  const speaker = el('button', 'act-icon');
  speaker.type = 'button';
  speaker.title = 'デモでは無効';
  speaker.appendChild(svgIcon(['M4 10 V14 H8 L13 18 V6 L8 10 Z', 'M16 9 a4 4 0 0 1 0 6'], 16));
  actions.append(rewrite, spacer, copyBtn, speaker);
  root.appendChild(actions);

  // FE-01 広告ブロック(Related直上。DD-001 2.1節)
  const adBlock = el('div');
  adBlock.id = 'ad-slot-block';
  root.appendChild(adBlock);

  // Related(関連コンテンツ)
  const related = el('div', 'related');
  related.appendChild(el('h2', null, 'Related'));
  sources.forEach((s) => {
    const row = el('div', 'row');
    row.appendChild(el('span', null, s.title));
    row.appendChild(el('span', 'plus', '＋'));
    related.appendChild(row);
  });
  root.appendChild(related);

  // フォローアップ入力(既存UI準拠。送信で新しい回答ページを生成)
  const fu = el('div', 'followup');
  const fuIcon = el('span', 'fu-icon');
  fuIcon.appendChild(svgIcon(['M5 5 H13 V13 H5 Z', 'M13 9 H19 V19 H9 V13', 'M16 11 V15', 'M14 13 H18'], 18));
  const fuInput = el('input');
  fuInput.placeholder = 'フォローアップの質問をしてください';
  fuInput.maxLength = 500;
  const copilot = el('span', 'fu-copilot');
  copilot.appendChild(el('span', 'dot'));
  copilot.appendChild(el('span', null, 'Copilot'));
  copilot.title = 'デモでは無効';
  const fuSend = el('button', 'fu-send');
  fuSend.type = 'button';
  fuSend.setAttribute('aria-label', '質問する');
  fuSend.appendChild(svgIcon(['M12 19 V5', 'M6 11 L12 5 L18 11'], 16));
  fuSend.addEventListener('click', () => askFollowUp(fuInput.value, fuSend));
  fuInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは送信しない
    if (e.key === 'Enter') askFollowUp(fuInput.value, fuSend);
  });
  fu.append(fuIcon, fuInput, copilot, fuSend);
  root.appendChild(fu);

  // 初回生成応答のads[]が引き継がれていればフェッチ省略(DD-001 2.5節)
  let initialAds = null;
  try {
    const cached = sessionStorage.getItem(`ads:${pageId}`);
    if (cached != null) {
      initialAds = JSON.parse(cached);
      sessionStorage.removeItem(`ads:${pageId}`); // 再訪時は通常フェッチ(表示計測のため)
    }
  } catch { /* noop */ }
  mountAdSlotBlock(adBlock, pageId, initialAds);
}

main();
