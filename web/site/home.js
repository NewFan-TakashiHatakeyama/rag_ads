/* NewFan-Finance デモ: 質問受付 → 回答ページ生成(既存チャットフロー相当) */
'use strict';

const input = document.getElementById('q');
const askBtn = document.getElementById('ask');
const loading = document.getElementById('loading');

async function ask(question) {
  if (!question.trim()) return;
  askBtn.disabled = true;
  loading.style.display = '';
  try {
    const res = await fetch('/v1/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.trim() }),
    });
    if (!res.ok) throw new Error('failed');
    const page = await res.json();
    // 初回生成応答のads[]を回答ページへ引き継ぐ(FE-01: initialAdsがあればフェッチ省略)
    try { sessionStorage.setItem(`ads:${page.pageId}`, JSON.stringify(page.ads ?? [])); } catch { /* noop */ }
    rememberRecent(page.pageId, question.trim());
    location.href = `/c/${page.pageId}`;
  } catch {
    loading.textContent = '回答の生成に失敗しました。時間をおいて再度お試しください。';
    askBtn.disabled = false;
  }
}

function rememberRecent(pageId, question) {
  try {
    const list = JSON.parse(localStorage.getItem('recentPages') ?? '[]');
    list.unshift({ pageId, question, at: Date.now() });
    localStorage.setItem('recentPages', JSON.stringify(list.slice(0, 10)));
  } catch { /* noop */ }
}

function renderRecent() {
  try {
    const list = JSON.parse(localStorage.getItem('recentPages') ?? '[]');
    if (!list.length) return;
    document.getElementById('recent').style.display = '';
    const box = document.getElementById('recent-list');
    box.textContent = '';
    for (const item of list) {
      const a = document.createElement('a');
      a.href = `/c/${item.pageId}`;
      a.textContent = item.question;
      box.appendChild(a);
    }
  } catch { /* noop */ }
}

askBtn.addEventListener('click', () => ask(input.value));
input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは送信しない
  if (e.key === 'Enter') ask(input.value);
});
document.getElementById('samples').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') { input.value = e.target.textContent; ask(e.target.textContent); }
});
renderRecent();
