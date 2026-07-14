/**
 * NewFan RAG-Ads 管理コンソール SPA (NF-RAGAD-SD-001 準拠)
 * S-01 広告一覧 / S-02 広告登録・編集 / S-03 コンテンツ紐づけ / S-03-1 コンテンツ詳細 /
 * S-04 パフォーマンスレポート / S-05 審査キュー
 */
'use strict';

// ===== 共通ユーティリティ =====================================================
const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const yen = (n) => '¥' + Number(n ?? 0).toLocaleString('ja-JP');
const num = (n) => Number(n ?? 0).toLocaleString('ja-JP');

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso)).replace(/-/g, '/');
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
};
const jstToday = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  return p.format(new Date());
};
const jstOffset = (base, days) => {
  const d = new Date(Date.parse(base + 'T00:00:00+09:00') + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d);
};

const STATUS_LABEL = {
  draft: '下書き', reviewing: '審査中', needs_fix: '修正が必要', approved: '承認済',
  delivering: '配信中', paused: '停止', expired: '期限切れ',
};
const badge = (status) => `<span class="badge st-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;

// ===== APIクライアント ========================================================
const session = {
  get token() { return sessionStorage.getItem('ragads_token'); },
  set token(v) { v ? sessionStorage.setItem('ragads_token', v) : sessionStorage.removeItem('ragads_token'); },
  get user() { try { return JSON.parse(sessionStorage.getItem('ragads_user')); } catch { return null; } },
  set user(v) { v ? sessionStorage.setItem('ragads_user', JSON.stringify(v)) : sessionStorage.removeItem('ragads_user'); },
};

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session.token) headers['Authorization'] = `Bearer ${session.token}`;
  const base = window.RAGAuth?.apiBase ?? ''; // デプロイ時はAPI GatewayのベースURL
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', '時間をおいて再度お試しください');
  }
  let data = {};
  try { data = await res.json(); } catch { /* 空ボディ */ }
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && location.hash !== '#/login') {
      session.token = null; session.user = null;
      render();
    }
    throw new ApiError(res.status, e.code ?? 'API-5001', e.message ?? 'エラーが発生しました', e.details);
  }
  return data;
}

/** APIエラー → 画面表示文言(SD-001 2.4節の共通変換) */
function apiErrorMessage(e) {
  switch (e.code) {
    case 'API-4031': return 'この操作を行う権限がありません';
    case 'API-4091': return '他の操作と競合しました。画面を再読み込みしてください';
    case 'API-4011': return e.message;
    case 'API-4001': return e.message;
    default: return '時間をおいて再度お試しください';
  }
}

// ===== トースト・モーダル・ポップオーバー =====================================
function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/** 確認ダイアログ(破壊的操作の前に必須。SD-001 2.4節) */
function confirmModal(message, okLabel = 'OK', okClass = 'btn-p') {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="m-msg">${esc(message)}</div>
        <div class="m-actions">
          <button class="btn btn-n" data-act="cancel">キャンセル</button>
          <button class="btn ${okClass}" data-act="ok">${esc(okLabel)}</button>
        </div>
      </div>`;
    backdrop.addEventListener('click', (ev) => {
      const act = ev.target?.dataset?.act;
      if (act === 'ok') { backdrop.remove(); resolve(true); }
      else if (act === 'cancel' || ev.target === backdrop) { backdrop.remove(); resolve(false); }
    });
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

let popoverEl = null;
function showPopover(anchor, title, text) {
  hidePopover();
  popoverEl = document.createElement('div');
  popoverEl.className = 'popover';
  popoverEl.innerHTML = `<div class="p-title">${esc(title)}</div>${esc(text)}`;
  document.body.appendChild(popoverEl);
  const r = anchor.getBoundingClientRect();
  popoverEl.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 360) + 'px';
  popoverEl.style.top = (r.bottom + window.scrollY + 6) + 'px';
  setTimeout(() => document.addEventListener('click', hidePopover, { once: true }), 0);
}
function hidePopover() { popoverEl?.remove(); popoverEl = null; }

// ===== ルーター ==============================================================
const app = document.getElementById('app');
let dirtyGuard = null; // S-02の離脱ガード: () => boolean (true=未保存あり)
let lastHash = location.hash || '#/ads';
let bypassGuard = false;

window.addEventListener('hashchange', async () => {
  if (!bypassGuard && dirtyGuard && dirtyGuard() && location.hash !== lastHash) {
    const target = location.hash;
    bypassGuard = true;
    location.hash = lastHash; // 一旦戻す
    const ok = await confirmModal('編集中の内容が保存されていません。このページを離れますか？', '離れる', 'btn-d');
    if (ok) {
      dirtyGuard = null;
      location.hash = target;
    }
    setTimeout(() => { bypassGuard = false; }, 0);
    return;
  }
  if (bypassGuard) { bypassGuard = false; return; }
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (dirtyGuard && dirtyGuard()) { e.preventDefault(); e.returnValue = ''; }
});

function nav(hash) { location.hash = hash; }

function render() {
  hidePopover();
  dirtyGuard = null;
  lastHash = location.hash || '#/ads';
  if (!session.token) { renderLogin(); return; }
  const hash = location.hash || '#/ads';
  const m = (re) => re.exec(hash);
  let mt;
  if ((mt = m(/^#\/ads\/new$/))) return renderShell('ads', () => viewAdForm(null));
  if ((mt = m(/^#\/ads\/([\w-]+)\/edit$/))) return renderShell('ads', () => viewAdForm(mt[1]));
  if ((mt = m(/^#\/ads\/([\w-]+)\/links\/([\w-]+)$/))) return renderShell('ads', () => viewContentDetail(mt[1], mt[2]));
  if ((mt = m(/^#\/ads\/([\w-]+)\/links$/))) return renderShell('ads', () => viewLinks(mt[1]));
  if ((mt = m(/^#\/ads\/([\w-]+)\/report$/))) return renderShell('ads', () => viewReport(mt[1]));
  if ((mt = m(/^#\/review$/))) return renderShell('review', () => viewReview());
  return renderShell('ads', () => viewAdList());
}

function renderShell(navKey, viewFn) {
  const u = session.user ?? {};
  const isAdmin = u.role === 'admin';
  app.innerHTML = `
    <header class="app-header">
      <span class="logo">NewFan <span>RAG-Ads</span></span>
      <span class="spacer"></span>
      <span class="user">${esc(u.email ?? '')}${isAdmin ? '（管理者）' : ''}</span>
      <button class="logout" id="btn-logout">ログアウト</button>
    </header>
    <div class="app-body">
      <nav class="side-nav">
        <a href="#/ads" class="${navKey === 'ads' ? 'on' : ''}">広告一覧</a>
        ${isAdmin ? `<a href="#/review" class="${navKey === 'review' ? 'on' : ''}">審査キュー</a>` : ''}
      </nav>
      <main class="main" id="main"></main>
    </div>`;
  document.getElementById('btn-logout').addEventListener('click', async () => {
    try { await window.RAGAuth.logout(session.token); } catch { /* noop */ }
    session.token = null; session.user = null;
    render();
  });
  viewFn();
}

// ===== ログイン ==============================================================
function renderLogin(msg = '') {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>NewFan <span style="color:var(--rag-teal)">RAG-Ads</span> 管理コンソール</h1>
        <div class="docid">RAG広告配信システム PoC（NF-RAGAD-SD-001）</div>
        ${msg ? `<div class="errbox">${esc(msg)}</div>` : ''}
        <div class="field"><label>メールアドレス</label><input class="inp" id="login-email" type="email" autocomplete="username"></div>
        <div class="field"><label>パスワード</label><input class="inp" id="login-pass" type="password" autocomplete="current-password"></div>
        <button class="btn btn-p" id="btn-login" style="width:100%;justify-content:center">ログイン</button>
        ${window.RAGAuth?.mode === 'local' ? `<div class="login-hint">
          <b>デモアカウント（PoC検証用）</b><br>
          広告主: <code>advertiser01@example.co.jp</code> / <code>demo1234</code><br>
          管理者: <code>admin@newfan.co.jp</code> / <code>admin1234</code>
        </div>` : ''}
      </div>
    </div>`;
  const doLogin = async () => {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-pass').value;
    try {
      const r = await window.RAGAuth.login(email, password);
      session.token = r.token; session.user = r.user;
      location.hash = '#/ads';
      render();
    } catch (e) {
      renderLogin(e.status === 401 ? 'メールアドレスまたはパスワードが正しくありません' : apiErrorMessage(e));
    }
  };
  document.getElementById('btn-login').addEventListener('click', doLogin);
  app.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは送信しない
    if (e.key === 'Enter') doLogin();
  }));
}

// ===== S-01 広告一覧 =========================================================
async function viewAdList() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-title">
      <h1>広告一覧</h1><span class="spacer"></span>
      <button class="btn btn-p" id="btn-new">＋ 新規出稿</button>
    </div>
    <div class="hstack" style="margin-bottom:14px;max-width:560px">
      <select class="inp" id="f-status" style="max-width:200px">
        <option value="all">ステータス：すべて</option>
        ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <input class="inp" id="f-search" placeholder="タイトルで検索">
    </div>
    <div id="list-area">${skeletonRows()}</div>`;
  document.getElementById('btn-new').addEventListener('click', () => nav('#/ads/new'));

  let allAds = [];
  let truncated = false;
  const load = async () => {
    const area = document.getElementById('list-area');
    area.innerHTML = skeletonRows();
    const status = document.getElementById('f-status').value;
    try {
      const r = await api('GET', `/v1/ads?status=${encodeURIComponent(status)}`);
      allAds = r.ads; truncated = r.truncated;
      draw();
    } catch (e) {
      area.innerHTML = `
        <div class="empty"><b style="color:var(--rag-err)">一覧を取得できませんでした。</b><br>
        時間をおいて再度お試しください。 <button class="btn btn-o btn-s" id="btn-reload" style="margin-left:8px">再読み込み</button></div>`;
      document.getElementById('btn-reload')?.addEventListener('click', load);
    }
  };

  const draw = () => {
    const area = document.getElementById('list-area');
    const kw = document.getElementById('f-search').value.trim();
    const ads = kw ? allAds.filter((a) => (a.title ?? '').includes(kw)) : allAds;
    if (ads.length === 0) {
      area.innerHTML = `<div class="empty"><b>広告がまだありません。</b><br>「新規出稿」から最初の広告を作成してください。</div>`;
      return;
    }
    area.innerHTML = `
      <table class="gtable">
        <tr><th>広告タイトル</th><th>タグ・キーワード</th><th>ステータス</th><th>課金</th><th>紐づけ</th><th>更新日時</th><th>操作</th></tr>
        ${ads.map((a) => rowHtml(a)).join('')}
      </table>
      ${truncated ? '<div class="notebox">最新200件を表示しています。絞り込みで対象を減らしてください。</div>' : ''}`;
    area.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', (ev) => onAction(ev, el)));
  };

  const rowHtml = (a) => {
    const chips = [...(a.tags ?? []), ...(a.keywords ?? [])].slice(0, 4)
      .map((t) => `<span class="chip">${esc(t)}</span>`).join('');
    const canEdit = a.status !== 'reviewing';
    const canLink = !['draft', 'reviewing'].includes(a.status);
    const canPause = a.status === 'delivering';
    const canResubmit = ['paused', 'expired', 'needs_fix'].includes(a.status);
    return `<tr>
      <td><div class="ttl">${esc(a.title)}</div><div class="mini">${esc(a.category ?? '—')}</div></td>
      <td>${chips || '<span class="mini">—</span>'}</td>
      <td>${badge(a.status)}${a.status === 'needs_fix' && a.reviewNote ? `<div class="mini"><a href="javascript:void(0)" data-act="note" data-id="${esc(a.adId)}" style="color:var(--rag-err)">差戻し理由を見る</a></div>` : ''}</td>
      <td>${a.unitPriceCitation != null ? yen(a.unitPriceCitation) + '/回' : '—'}<div class="mini">予算 ${a.dailyBudget != null ? yen(a.dailyBudget) + '/日' : '未設定'}</div></td>
      <td>${a.linkCount > 0 ? `<a href="#/ads/${esc(a.adId)}/links">${a.linkCount}件</a>` : '<span class="mini">0件</span>'}</td>
      <td class="mini">${fmtDateTime(a.updatedAt)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-n btn-s" data-act="edit" data-id="${esc(a.adId)}" ${canEdit ? '' : 'disabled title="審査中は編集できません（審査対象の固定のため）"'}>編集</button>
        ${canLink ? `<button class="btn btn-o btn-s" data-act="links" data-id="${esc(a.adId)}">紐づけ</button>` : ''}
        <button class="btn btn-o btn-s" data-act="report" data-id="${esc(a.adId)}">実績</button>
        ${canPause ? `<button class="btn btn-w btn-s" data-act="pause" data-id="${esc(a.adId)}">停止</button>` : ''}
        ${canResubmit ? `<button class="btn btn-p btn-s" data-act="resubmit" data-id="${esc(a.adId)}">再出稿</button>` : ''}
      </td>
    </tr>`;
  };

  const onAction = async (ev, el) => {
    const id = el.dataset.id;
    const act = el.dataset.act;
    if (act === 'edit' || act === 'resubmit') return nav(`#/ads/${id}/edit`);
    if (act === 'links') return nav(`#/ads/${id}/links`);
    if (act === 'report') return nav(`#/ads/${id}/report`);
    if (act === 'note') {
      ev.stopPropagation();
      const ad = allAds.find((a) => a.adId === id);
      showPopover(el, '差戻し理由', ad?.reviewNote ?? '');
      return;
    }
    if (act === 'pause') {
      const ok = await confirmModal('この広告の配信を停止しますか？\n停止中は広告選択の対象から除外されます。', '停止する', 'btn-d');
      if (!ok) return;
      try {
        await api('PATCH', `/v1/ads/${id}/status`, { to: 'paused' });
        toast('広告を停止しました');
        load();
      } catch (e) { toast(apiErrorMessage(e), true); }
    }
  };

  document.getElementById('f-status').addEventListener('change', load);
  let debounce = null;
  document.getElementById('f-search').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(draw, 300); // デバウンス300ms(SD-001 3.1)
  });
  load();
}

function skeletonRows() {
  return `<div class="pane">${'<div class="skel"></div>'.repeat(5)}</div>`;
}

// ===== S-02 広告登録・編集 ====================================================
const CATEGORIES = ['金融・投資', '保険', 'ローン・クレジット', '不動産', 'その他'];
const QTYPES = ['情報検索', '相談', 'アクション', '提案要求'];

async function viewAdForm(adId) {
  const main = document.getElementById('main');
  main.innerHTML = skeletonRows();

  // フォームモデル
  const form = {
    title: '', category: '', adText: '', landingUrl: '', imageUrl: '',
    tags: [], keywords: [],
    ageMin: '', ageMax: '', region: '', questionTypes: [],
    unitPriceCitation: '10', campaignStart: '', campaignEnd: '', dailyBudget: '',
  };
  let step = 1;
  let savedAdId = adId;
  let origStatus = null;
  let reviewNote = null;
  let findings = [];
  let dirty = false;
  let fieldErrors = {}; // field -> message

  if (adId) {
    try {
      const r = await api('GET', `/v1/ads/${adId}`);
      const a = r.ad;
      if (a.status === 'reviewing') {
        main.innerHTML = `<div class="page-title"><h1>広告の編集</h1></div>
          <div class="notebox">この広告は<b>審査中</b>のため編集できません（審査対象の固定のため）。審査完了までお待ちください。</div>
          <button class="btn btn-n" onclick="location.hash='#/ads'">一覧へ戻る</button>`;
        return;
      }
      origStatus = a.status;
      reviewNote = a.reviewNote;
      findings = a.findings ?? [];
      Object.assign(form, {
        title: a.title ?? '', category: a.category ?? '', adText: a.adText ?? '',
        landingUrl: a.landingUrl ?? '', imageUrl: a.imageUrl ?? '',
        tags: [...(a.tags ?? [])], keywords: [...(a.keywords ?? [])],
        ageMin: a.target?.ageRange?.[0] ?? '', ageMax: a.target?.ageRange?.[1] ?? '',
        region: a.target?.region ?? '', questionTypes: [...(a.target?.questionTypes ?? [])],
        unitPriceCitation: a.unitPriceCitation != null ? String(a.unitPriceCitation) : '10',
        campaignStart: a.campaignStart ?? '', campaignEnd: a.campaignEnd ?? '',
        dailyBudget: a.dailyBudget != null ? String(a.dailyBudget) : '',
      });
    } catch (e) {
      main.innerHTML = `<div class="errbox">${esc(apiErrorMessage(e))}</div>`;
      return;
    }
  }

  dirtyGuard = () => dirty;

  const buildBody = (submit) => {
    const target = {};
    if (form.ageMin !== '' && form.ageMax !== '') target.ageRange = [Number(form.ageMin), Number(form.ageMax)];
    if (form.region) target.region = form.region;
    if (form.questionTypes.length) target.questionTypes = [...form.questionTypes];
    return {
      title: form.title,
      category: form.category || undefined,
      adText: form.adText || undefined,
      landingUrl: form.landingUrl || undefined,
      imageUrl: form.imageUrl || undefined,
      tags: form.tags,
      keywords: form.keywords,
      target: Object.keys(target).length ? target : undefined,
      unitPriceCitation: form.unitPriceCitation !== '' ? Number(form.unitPriceCitation) : undefined,
      campaignStart: form.campaignStart || undefined,
      campaignEnd: form.campaignEnd || undefined,
      dailyBudget: form.dailyBudget !== '' ? Number(String(form.dailyBudget).replaceAll(',', '')) : undefined,
      submit,
    };
  };

  // ---- クライアント側バリデーション(SD-001 付録A.1と同一文言。サーバー検証が正) ----
  const HTML_TAG = /<[a-zA-Z/!]/;
  const validateStep = (n) => {
    const errs = {};
    if (n === 1) {
      if (form.title.length < 1 || form.title.length > 50 || HTML_TAG.test(form.title)) errs.title = '広告タイトル：1〜50文字で入力してください';
      if (!CATEGORIES.includes(form.category)) errs.category = '広告カテゴリ：選択してください';
      if (form.adText.length < 100 || form.adText.length > 500) errs.adText = '広告テキスト：100〜500文字で入力してください';
      else if (HTML_TAG.test(form.adText) || /https?:\/\/|www\./i.test(form.adText)) errs.adText = '広告テキスト：URLやHTMLタグは使用できません';
      if (!/^https:\/\//.test(form.landingUrl)) errs.landingUrl = '遷移先URL：httpsのURLを入力してください';
      if (form.imageUrl && !/^https:\/\//.test(form.imageUrl)) errs.imageUrl = '広告画像URL：httpsのURLを入力してください';
    }
    if (n === 2) {
      if ((form.ageMin === '') !== (form.ageMax === '')) errs.target = 'ターゲット設定：年齢は下限・上限の両方を入力してください';
      else if (form.ageMin !== '') {
        const [lo, hi] = [Number(form.ageMin), Number(form.ageMax)];
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 18 || hi > 99 || lo > hi) errs.target = 'ターゲット設定：年齢は18〜99の範囲で下限≦上限としてください';
      }
      const price = Number(form.unitPriceCitation);
      if (form.unitPriceCitation === '' || !Number.isInteger(price) || price < 1 || price > 1000) errs.unitPriceCitation = '引用単価：1〜1,000の整数で入力してください';
      if (!form.campaignStart || !form.campaignEnd) errs.campaign = 'キャンペーン期間：開始日・終了日を入力してください';
      else {
        if (form.campaignEnd < form.campaignStart) errs.campaign = 'キャンペーン期間：終了日は開始日以降の日付を指定してください';
        else if (form.campaignEnd < jstToday()) errs.campaign = 'キャンペーン期間：終了日は本日以降の日付を指定してください';
      }
      const budget = Number(String(form.dailyBudget).replaceAll(',', ''));
      if (form.dailyBudget === '' || !Number.isInteger(budget) || budget < 100 || budget > 1000000) errs.dailyBudget = '日次予算上限：100〜1,000,000の整数で入力してください';
      else if (Number.isInteger(price) && budget < price) errs.dailyBudget = '日次予算上限：引用単価以上の金額を指定してください';
    }
    return errs;
  };

  /** サーバーのAPI-4001 detailsをフィールドへ反映(2.4節) */
  const applyServerErrors = (details) => {
    fieldErrors = {};
    for (const d of details ?? []) {
      const key = { campaignStart: 'campaign', campaignEnd: 'campaign' }[d.field] ?? d.field;
      fieldErrors[key] = d.reason;
    }
    step = ['title', 'category', 'adText', 'landingUrl', 'imageUrl'].some((f) => fieldErrors[f]) ? 1 : 2;
    draw();
  };

  const saveDraft = async ({ silent = false } = {}) => {
    try {
      const body = buildBody(false);
      let r;
      if (savedAdId) r = await api('PUT', `/v1/ads/${savedAdId}`, body);
      else { r = await api('POST', '/v1/ads', body); savedAdId = r.adId; }
      findings = r.findings ?? [];
      dirty = false;
      if (!silent) toast('下書きを保存しました');
      return true;
    } catch (e) {
      if (e.code === 'API-4001' && e.details) { applyServerErrors(e.details); toast(`入力内容に${e.details.length}件の誤りがあります`, true); }
      else toast(apiErrorMessage(e), true);
      return false;
    }
  };

  const submitAd = async () => {
    try {
      const body = buildBody(true);
      if (savedAdId) await api('PUT', `/v1/ads/${savedAdId}`, body);
      else await api('POST', '/v1/ads', body);
      dirty = false;
      dirtyGuard = null;
      toast('出稿しました。審査完了までお待ちください');
      nav('#/ads');
    } catch (e) {
      if (e.code === 'API-4001' && e.details) { applyServerErrors(e.details); toast(`入力内容に${e.details.length}件の誤りがあります`, true); }
      else toast(apiErrorMessage(e), true);
    }
  };

  const goNext = async () => {
    const errs = validateStep(step);
    fieldErrors = errs;
    if (Object.keys(errs).length) {
      draw();
      toast(`入力内容に${Object.keys(errs).length}件の誤りがあります`, true);
      return;
    }
    if (step === 2) {
      // Step3遷移時: 下書き保存を自動実行しfindingsを取得(SD-001 4.2)。
      // 配信中・承認済の広告は保存の時点で配信が停止するため、事前に明示的な確認を挟む
      if (dirty || !savedAdId) {
        if (['delivering', 'approved'].includes(origStatus)) {
          const proceed = await confirmModal(
            '確認画面へ進むには変更内容の下書き保存が必要です。\n保存した時点でこの広告の配信は停止し、再出稿して承認されるまで配信されません。よろしいですか？',
            '保存して進む'
          );
          if (!proceed) return;
        }
        const ok = await saveDraft({ silent: true });
        if (!ok) return;
        if (origStatus && origStatus !== 'needs_fix') origStatus = 'draft'; // サーバー側はdraftへ遷移済み
      }
      step = 3;
    } else {
      step += 1;
    }
    draw();
  };

  const fieldErr = (key) => fieldErrors[key] ? `<div class="ferr">${esc(fieldErrors[key])}</div>` : '';
  const errCls = (key) => fieldErrors[key] ? ' err' : '';

  const draw = () => {
    const stepHead = `
      <div class="steps">
        <div class="${step === 1 ? 'on' : 'done'}"><b>${step > 1 ? '✓' : '1'}</b>基本情報</div>
        <div class="${step === 2 ? 'on' : step > 2 ? 'done' : ''}"><b>${step > 2 ? '✓' : '2'}</b>広告設定・課金</div>
        <div class="${step === 3 ? 'on' : ''}"><b>3</b>確認</div>
      </div>`;

    const persistentNotes = `
      ${['delivering', 'approved'].includes(origStatus) ? '<div class="notebox">保存して出稿すると<b>再審査</b>となり、承認まで配信が停止します。</div>' : ''}
      ${origStatus === 'needs_fix' && reviewNote ? `<div class="errbox"><b>差戻し理由：</b>${esc(reviewNote)}</div>` : ''}`;

    let body = '';
    if (step === 1) {
      body = `
        <div class="field"><label>広告タイトル <span class="rq">必須</span><span class="cnt${form.title.length > 50 ? ' over' : ''}">${form.title.length} / 50</span></label>
          <input class="inp${errCls('title')}" id="f-title" value="${esc(form.title)}">${fieldErr('title')}</div>
        <div class="field"><label>広告カテゴリ <span class="rq">必須</span></label>
          <select class="inp${errCls('category')}" id="f-category">
            <option value="">選択してください</option>
            ${CATEGORIES.map((c) => `<option ${form.category === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>${fieldErr('category')}</div>
        <div class="field"><label>広告テキスト <span class="rq">必須</span><span class="cnt${form.adText.length > 500 ? ' over' : ''}">${form.adText.length} / 500</span></label>
          <textarea class="inp${errCls('adText')}" id="f-adtext" rows="5">${esc(form.adText)}</textarea>
          <div class="fhelp">この文章を根拠に、AIが回答ページ向けのリード文（20〜60字）を生成します。事実のみを記載してください。</div>${fieldErr('adText')}</div>
        <div class="field"><label>遷移先URL <span class="rq">必須</span></label>
          <input class="inp${errCls('landingUrl')}" id="f-url" value="${esc(form.landingUrl)}" placeholder="https://">${fieldErr('landingUrl')}</div>
        <div class="field"><label>広告画像URL <span class="opt">任意</span></label>
          <div class="hstack">
            <input class="inp${errCls('imageUrl')}" id="f-img" value="${esc(form.imageUrl)}" placeholder="https://（16:9推奨）" style="flex:3">
            <div style="flex:1;min-height:48px;border-radius:6px;background:linear-gradient(135deg,#DCE4EE,#C6D2E2);display:flex;align-items:center;justify-content:center;color:#8CA0BC;font-size:10.5px;overflow:hidden" id="img-preview">16:9 プレビュー</div>
          </div>${fieldErr('imageUrl')}</div>
        <div class="hstack" style="margin-top:18px">
          <button class="btn btn-n grow0" id="btn-draft">下書き保存</button>
          <span style="flex:6"></span>
          <button class="btn btn-p grow0" id="btn-next">次へ</button>
        </div>`;
    } else if (step === 2) {
      body = `
        <div class="field"><label>専門分野タグ <span class="opt">任意（5件まで）</span></label>
          <div class="inp" id="chips-tags" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;min-height:38px">
            ${form.tags.map((t, i) => `<span class="chip">${esc(t)}<span class="x" data-chip="tags" data-i="${i}">×</span></span>`).join('')}
            <input id="f-tag-input" style="border:none;outline:none;flex:1;min-width:120px;font-size:12.5px" placeholder="＋入力してEnter">
          </div>${fieldErr('tags')}</div>
        <div class="field"><label>関連キーワード <span class="opt">任意（10件まで）</span></label>
          <div class="inp" id="chips-keywords" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;min-height:38px">
            ${form.keywords.map((t, i) => `<span class="chip">${esc(t)}<span class="x" data-chip="keywords" data-i="${i}">×</span></span>`).join('')}
            <input id="f-kw-input" style="border:none;outline:none;flex:1;min-width:120px;font-size:12.5px" placeholder="＋入力してEnter">
          </div>${fieldErr('keywords')}</div>
        <div class="field"><label>ターゲット設定 <span class="opt">任意</span></label>
          <div style="border:1px solid var(--rag-line);border-radius:8px;padding:12px 14px">
            <div class="hstack" style="margin-bottom:10px">
              <div><div class="mini" style="font-size:11px;color:var(--rag-sub)">年齢</div>
                <div class="hstack"><input class="inp" id="f-agemin" value="${esc(form.ageMin)}" style="max-width:80px" inputmode="numeric"><span class="grow0" style="align-self:center">〜</span><input class="inp" id="f-agemax" value="${esc(form.ageMax)}" style="max-width:80px" inputmode="numeric"></div></div>
              <div><div class="mini" style="font-size:11px;color:var(--rag-sub)">地域</div>
                <select class="inp" id="f-region"><option value="">未設定</option><option ${form.region === '全国' ? 'selected' : ''}>全国</option></select></div>
            </div>
            <div class="mini" style="font-size:11px;color:var(--rag-sub);margin-bottom:4px">質問内容タイプ</div>
            ${QTYPES.map((q) => `<label style="font-weight:400;display:inline-flex;gap:5px;margin-right:14px;font-size:12.5px;align-items:center"><input type="checkbox" data-qtype="${q}" ${form.questionTypes.includes(q) ? 'checked' : ''}> ${q}</label>`).join('')}
          </div>${fieldErr('target')}</div>
        <div class="hstack">
          <div class="field"><label>引用単価（円/回） <span class="rq">必須</span></label>
            <input class="inp${errCls('unitPriceCitation')}" id="f-price" value="${esc(form.unitPriceCitation)}" inputmode="numeric">${fieldErr('unitPriceCitation')}</div>
          <div class="field"><label>日次予算上限（円） <span class="rq">必須</span></label>
            <input class="inp${errCls('dailyBudget')}" id="f-budget" value="${esc(form.dailyBudget)}" inputmode="numeric">${fieldErr('dailyBudget')}</div>
        </div>
        <div class="field"><label>キャンペーン期間 <span class="rq">必須</span></label>
          <div class="hstack">
            <input class="inp${errCls('campaign')}" type="date" id="f-start" value="${esc(form.campaignStart)}">
            <span class="grow0" style="align-self:center">〜</span>
            <input class="inp${errCls('campaign')}" type="date" id="f-end" value="${esc(form.campaignEnd)}">
          </div>${fieldErr('campaign')}</div>
        <div class="hstack" style="margin-top:16px">
          <button class="btn btn-n grow0" id="btn-draft">下書き保存</button>
          <button class="btn btn-n grow0" id="btn-back">戻る</button>
          <span style="flex:5"></span>
          <button class="btn btn-p grow0" id="btn-next">次へ</button>
        </div>`;
    } else {
      const findingsHtml = findings.length
        ? `<div class="alertbox"><b>⚠ 表現チェック：${findings.length}件の警告</b><br>
            ${findings.map((f) => `${highlightIn(form.adText + '／' + form.title, f.text)} — ${esc(f.reason)}（${esc(f.law)}）`).map((s) => `<div style="margin-top:6px">${s}</div>`).join('')}
            <div class="mini" style="margin-top:6px;color:var(--rag-sub)">このまま出稿した場合、審査で確認されます。</div>
          </div>`
        : '<div class="notebox">表現チェック：問題となる表現は検出されませんでした。</div>';
      const qt = form.questionTypes.length ? form.questionTypes.join('／') : '未設定';
      body = `
        <table class="gtable" style="margin-bottom:12px">
          <tr><th style="width:30%">広告タイトル</th><td>${esc(form.title)}</td></tr>
          <tr><th>カテゴリ / 期間</th><td>${esc(form.category)} ／ ${esc(form.campaignStart)} 〜 ${esc(form.campaignEnd)}</td></tr>
          <tr><th>広告テキスト</th><td style="white-space:pre-wrap">${esc(form.adText)}</td></tr>
          <tr><th>遷移先URL</th><td class="mono" style="font-size:12px">${esc(form.landingUrl)}</td></tr>
          <tr><th>課金</th><td>RAG引用課金　${yen(Number(form.unitPriceCitation))}/回（日次予算 ${yen(Number(String(form.dailyBudget).replaceAll(',', '')))}）</td></tr>
          <tr><th>ターゲット</th><td>${form.ageMin !== '' ? `${esc(form.ageMin)}〜${esc(form.ageMax)}歳・` : ''}${esc(form.region || '地域未設定')}・${esc(qt)}</td></tr>
          <tr><th>タグ / キーワード</th><td>${[...form.tags, ...form.keywords].map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '—'}</td></tr>
        </table>
        ${findingsHtml}
        <p class="note-fixed">出稿すると<b>審査中</b>となり、承認後にキャンペーン期間内で自動的に配信が開始されます。</p>
        <div class="hstack" style="margin-top:14px">
          <button class="btn btn-n grow0" id="btn-back">戻る</button>
          <span style="flex:5"></span>
          <button class="btn btn-p grow0" id="btn-submit">出稿する</button>
        </div>`;
    }

    document.getElementById('main').innerHTML = `
      <div class="page-title"><h1>${adId ? '広告の編集' : '新規出稿'}</h1>${origStatus ? badge(origStatus) : ''}</div>
      ${persistentNotes}
      <div style="max-width:680px">${stepHead}${body}</div>`;
    bind();
  };

  const markDirty = () => { dirty = true; };
  const bind = () => {
    const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
    // Step1
    on('f-title', 'input', (e) => { form.title = e.target.value; markDirty(); e.target.closest('.field').querySelector('.cnt').textContent = `${form.title.length} / 50`; });
    on('f-category', 'change', (e) => { form.category = e.target.value; markDirty(); });
    on('f-adtext', 'input', (e) => { form.adText = e.target.value; markDirty(); e.target.closest('.field').querySelector('.cnt').textContent = `${form.adText.length} / 500`; });
    on('f-url', 'input', (e) => { form.landingUrl = e.target.value.trim(); markDirty(); });
    on('f-img', 'input', (e) => { form.imageUrl = e.target.value.trim(); markDirty(); updatePreview(); });
    const updatePreview = () => {
      const box = document.getElementById('img-preview');
      if (!box) return;
      if (form.imageUrl && /^https:\/\//.test(form.imageUrl)) {
        box.innerHTML = `<img src="${esc(form.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentNode.textContent='画像を読み込めません'">`;
      } else {
        box.textContent = '16:9 プレビュー';
      }
    };
    if (step === 1) updatePreview();
    // Step2: チップ入力
    const chipAdd = (kind, inputId, max, label) => {
      on(inputId, 'keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは追加しない
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = e.target.value.trim();
        if (!v) return;
        if (v.length > 20) { toast(`${label}：各項目は1〜20文字で入力してください`, true); return; }
        if (form[kind].length >= max) { toast(`${label}：${max}件以内で入力してください`, true); return; }
        if (form[kind].includes(v)) { e.target.value = ''; return; }
        form[kind].push(v); markDirty(); draw();
        setTimeout(() => document.getElementById(inputId)?.focus(), 0);
      });
    };
    chipAdd('tags', 'f-tag-input', 5, '専門分野タグ');
    chipAdd('keywords', 'f-kw-input', 10, '関連キーワード');
    document.querySelectorAll('[data-chip]').forEach((x) => x.addEventListener('click', () => {
      form[x.dataset.chip].splice(Number(x.dataset.i), 1); markDirty(); draw();
    }));
    on('f-agemin', 'input', (e) => { form.ageMin = e.target.value.trim(); markDirty(); });
    on('f-agemax', 'input', (e) => { form.ageMax = e.target.value.trim(); markDirty(); });
    on('f-region', 'change', (e) => { form.region = e.target.value; markDirty(); });
    document.querySelectorAll('[data-qtype]').forEach((cb) => cb.addEventListener('change', () => {
      form.questionTypes = [...document.querySelectorAll('[data-qtype]:checked')].map((c) => c.dataset.qtype);
      markDirty();
    }));
    on('f-price', 'input', (e) => { form.unitPriceCitation = e.target.value.trim(); markDirty(); });
    on('f-budget', 'input', (e) => { form.dailyBudget = e.target.value.trim(); markDirty(); });
    on('f-start', 'change', (e) => { form.campaignStart = e.target.value; markDirty(); });
    on('f-end', 'change', (e) => { form.campaignEnd = e.target.value; markDirty(); });
    // ナビゲーション
    on('btn-next', 'click', goNext);
    on('btn-back', 'click', () => { step -= 1; fieldErrors = {}; draw(); });
    on('btn-draft', 'click', () => saveDraft());
    on('btn-submit', 'click', submitAd);
  };

  draw();
}

/** テキストをエスケープし、警告該当箇所を<mark>でハイライト(SD-001 S-05 #3)。needleは文字列または配列 */
function highlightIn(text, needles) {
  let escaped = esc(text);
  for (const needle of [].concat(needles ?? [])) {
    if (needle) escaped = escaped.replaceAll(esc(needle), `<mark class="hl">${esc(needle)}</mark>`);
  }
  return escaped;
}

// ===== S-03 コンテンツ紐づけ ==================================================
async function viewLinks(adId) {
  const main = document.getElementById('main');
  main.innerHTML = skeletonRows();
  let detail, cands;
  try {
    [detail, cands] = await Promise.all([
      api('GET', `/v1/ads/${adId}`),
      api('GET', `/v1/ads/${adId}/link-candidates`),
    ]);
  } catch (e) {
    main.innerHTML = `<div class="errbox">${esc(apiErrorMessage(e))}</div>`;
    return;
  }
  const ad = detail.ad;
  const locked = ['draft', 'reviewing'].includes(ad.status);

  const candRow = (c) => {
    const pct = Math.round(c.relevance * 100);
    return `<tr>
      <td><a href="#/ads/${esc(adId)}/links/${esc(c.contentId)}" class="ttl" style="text-decoration:none">${esc(c.title)}</a></td>
      <td class="mini">${esc(c.genre)}</td>
      <td><span class="relbar"><span class="bar"><i style="width:${pct}%"></i></span><b>${pct}%</b></span></td>
      <td>${esc(String(c.citationsPerDay))}</td>
      <td>${c.competingAds}件</td>
      <td><select class="inp" data-pri="${esc(c.contentId)}" style="padding:4px 6px;font-size:12px;max-width:74px" ${locked ? 'disabled' : ''}>
        <option>高</option><option selected>中</option><option>低</option></select></td>
      <td><button class="btn btn-o btn-s" data-link="${esc(c.contentId)}" ${locked ? 'disabled' : ''}>紐づける</button></td>
    </tr>`;
  };

  main.innerHTML = `
    <div class="page-title"><h1>コンテンツ紐づけ</h1>${badge(ad.status)}</div>
    <div class="pane">対象広告：<b style="color:var(--rag-navy)">${esc(ad.title)}</b>
      <span class="mini" style="color:var(--rag-sub);margin-left:8px">${esc(ad.category ?? '')} ／ ${yen(ad.unitPriceCitation)}/回</span></div>
    ${locked ? '<div class="notebox">下書き・審査中の広告は紐づけ操作を行えません（承認後に有効化されます）。</div>' : ''}
    <div class="section-h">おすすめの記事（関連度順・上位10件）</div>
    ${cands.candidates.length ? `
      <table class="gtable">
        <tr><th>記事タイトル</th><th>ジャンル</th><th>関連度</th><th>引用回数/日</th><th>競合広告</th><th>優先度</th><th></th></tr>
        ${cands.candidates.map(candRow).join('')}
      </table>` : '<div class="empty">関連する記事が見つかりませんでした。タグ・キーワードを追加すると候補が改善されます。</div>'}
    <div class="section-h">紐づけ済み（${detail.links.length}件）</div>
    ${detail.links.length ? `
      <table class="gtable">
        ${detail.links.map((l) => `<tr>
          <td style="width:55%"><a href="#/ads/${esc(adId)}/links/${esc(l.contentId)}" class="ttl" style="text-decoration:none">${esc(l.title)}</a></td>
          <td><span class="chip">優先度：${esc(l.priority)}</span></td>
          <td class="mini">${fmtDate(l.createdAt)} 紐づけ</td>
          <td><button class="btn btn-w btn-s" data-unlink="${esc(l.contentId)}" ${locked ? 'disabled' : ''}>解除</button></td>
        </tr>`).join('')}
      </table>` : '<div class="notebox">紐づけ済みの記事はありません。</div>'}
    <p class="note-fixed">※ 紐づけは配信の必須条件ではありません。未紐づけの広告も、質問との関連度に基づくベクトル検索により配信対象となります（紐づけは広告選択時の加点要素です）。</p>`;

  main.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', async () => {
    const contentId = b.dataset.link;
    const priority = main.querySelector(`[data-pri="${CSS.escape(contentId)}"]`)?.value ?? '中';
    try {
      await api('PUT', `/v1/ads/${adId}/links/${contentId}`, { priority });
      toast('記事を紐づけました');
      viewLinks(adId);
    } catch (e) { toast(apiErrorMessage(e), true); }
  }));
  main.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmModal('この記事との紐づけを解除しますか？', '解除する', 'btn-d');
    if (!ok) return;
    try {
      await api('DELETE', `/v1/ads/${adId}/links/${b.dataset.unlink}`);
      toast('紐づけを解除しました');
      viewLinks(adId);
    } catch (e) { toast(apiErrorMessage(e), true); }
  }));
}

// ===== S-03-1 コンテンツ詳細 ==================================================
async function viewContentDetail(adId, contentId) {
  const main = document.getElementById('main');
  main.innerHTML = skeletonRows();
  let c, ad;
  try {
    [c, ad] = await Promise.all([
      api('GET', `/v1/contents/${contentId}?adId=${encodeURIComponent(adId)}`),
      api('GET', `/v1/ads/${adId}`).then((r) => r.ad),
    ]);
  } catch (e) {
    main.innerHTML = `<div class="errbox">${e.code === 'API-4041' ? '記事が見つかりません。' : esc(apiErrorMessage(e))}</div>
      <button class="btn btn-n" onclick="history.back()">戻る</button>`;
    return;
  }
  const locked = ['draft', 'reviewing'].includes(ad.status);
  const pct = c.relevance != null ? Math.round(c.relevance * 100) : null;
  const statsHtml = c.stats ? `
    <div class="pane">
      <b>引用実績</b>　直近7日平均 <b class="mono">${esc(String(c.stats.citationsPerDay))}</b> 回/日
      <table class="gtable" style="margin-top:8px">
        <tr>${c.stats.daily.map((d) => `<th class="mono" style="text-align:center">${esc(d.date.slice(5))}</th>`).join('')}</tr>
        <tr>${c.stats.daily.map((d) => `<td class="mono" style="text-align:center">${d.count}</td>`).join('')}</tr>
      </table>
      ${c.stats.questionTypeShare ? `<div class="mini" style="margin-top:6px">質問タイプ内訳: ${Object.entries(c.stats.questionTypeShare).map(([k, v]) => `${esc(k)} ${v}件`).join('・')}</div>` : ''}
    </div>` : '';

  main.innerHTML = `
    <div class="page-title">
      <h1>コンテンツ詳細</h1><span class="sub">紐づけ前の記事確認（読み取り専用）</span>
      <span class="spacer"></span>
      <a href="#/ads/${esc(adId)}/links" class="btn btn-n btn-s" style="text-decoration:none">← 紐づけ一覧へ</a>
    </div>
    <div class="pane">
      <div style="font-size:15px;font-weight:800;color:var(--rag-navy)">${esc(c.title)}</div>
      <div class="mini" style="margin:4px 0 8px">${esc(c.genre)} ／ 公開 ${fmtDate(c.publishedAt)} ／ 更新 ${fmtDate(c.updatedAt)}</div>
      <div class="mini"><b>一次情報（出典）:</b> ${c.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>`).join('　')}</div>
    </div>
    ${pct != null ? `
    <div class="pane">
      <b>対象広告との関連度</b>　<span class="relbar"><span class="bar" style="width:80px"><i style="width:${pct}%"></i></span><b>${pct}%</b></span>
      <span class="mini" style="margin-left:10px">広告: ${esc(ad.title)}</span>
      <div class="mini" style="margin-top:6px">一致キーワード: ${(c.matchedKeywords ?? []).length ? c.matchedKeywords.map((k) => `<span class="chip">${esc(k)}</span>`).join('') : 'なし'}</div>
    </div>` : ''}
    ${statsHtml}
    <div class="pane">
      <b>競合状況</b>　この記事に紐づく他の広告: <b class="mono">${c.competingAds.count}</b>件
      ${Object.keys(c.competingAds.byCategory ?? {}).length ? `<span class="mini" style="margin-left:8px">（${Object.entries(c.competingAds.byCategory).map(([k, v]) => `${esc(k)} ${v}件`).join('・')}）</span>` : ''}
      <div class="mini" style="margin-top:4px;color:var(--rag-sub)">※ 広告主名・広告タイトルは表示されません。</div>
    </div>
    <div class="pane">
      <b>本文プレビュー${c.hasMore ? '（先頭2,000字）' : ''}</b>
      <div id="body-preview" style="white-space:pre-wrap;margin-top:8px;font-size:12.5px;line-height:1.9;color:var(--rag-ink)">${esc(c.bodyPreview)}</div>
      ${c.hasMore ? '<button class="btn btn-o btn-s" id="btn-full" style="margin-top:10px">全文を表示</button>' : ''}
    </div>
    <div class="pane">
      <b>この記事との紐づけ</b>
      ${c.linked ? `
        <span class="chip" style="margin-left:8px">優先度：${esc(c.linkedPriority)}</span>
        <button class="btn btn-w btn-s" id="btn-unlink" style="margin-left:10px" ${locked ? 'disabled' : ''}>解除</button>` : `
        <select class="inp" id="pri" style="max-width:90px;display:inline-block;padding:4px 6px;margin-left:10px" ${locked ? 'disabled' : ''}>
          <option>高</option><option selected>中</option><option>低</option></select>
        <button class="btn btn-p btn-s" id="btn-link" style="margin-left:8px" ${locked ? 'disabled' : ''}>紐づける</button>`}
      ${locked ? '<div class="mini" style="margin-top:6px">下書き・審査中の広告は紐づけ操作を行えません。</div>' : ''}
    </div>`;

  document.getElementById('btn-full')?.addEventListener('click', async () => {
    try {
      const full = await api('GET', `/v1/contents/${contentId}?full=true`);
      document.getElementById('body-preview').textContent = full.bodyPreview;
      document.getElementById('btn-full').remove();
    } catch (e) { toast(apiErrorMessage(e), true); }
  });
  document.getElementById('btn-link')?.addEventListener('click', async () => {
    try {
      await api('PUT', `/v1/ads/${adId}/links/${contentId}`, { priority: document.getElementById('pri').value });
      toast('記事を紐づけました');
      viewContentDetail(adId, contentId);
    } catch (e) { toast(apiErrorMessage(e), true); }
  });
  document.getElementById('btn-unlink')?.addEventListener('click', async () => {
    const ok = await confirmModal('この記事との紐づけを解除しますか？', '解除する', 'btn-d');
    if (!ok) return;
    try {
      await api('DELETE', `/v1/ads/${adId}/links/${contentId}`);
      toast('紐づけを解除しました');
      viewContentDetail(adId, contentId);
    } catch (e) { toast(apiErrorMessage(e), true); }
  });
}

// ===== S-04 パフォーマンスレポート ============================================
async function viewReport(adId) {
  const main = document.getElementById('main');
  const today = jstToday();
  let period = '7d';
  let from = jstOffset(today, -6);
  let to = today;

  main.innerHTML = `
    <div class="page-title">
      <h1>パフォーマンスレポート</h1><span class="sub" id="rep-title"></span>
      <span class="spacer"></span>
      <select class="inp" id="rep-period" style="max-width:150px;padding:6px 8px;font-size:12px">
        <option value="7d">過去7日間</option><option value="30d">過去30日間</option><option value="custom">期間指定</option>
      </select>
      <span id="rep-custom" style="display:none">
        <input class="inp" type="date" id="rep-from" style="width:145px;display:inline-block">
        〜 <input class="inp" type="date" id="rep-to" style="width:145px;display:inline-block">
        <button class="btn btn-o btn-s" id="rep-apply">適用</button>
      </span>
      <button class="btn btn-o btn-s" id="btn-csv">CSVダウンロード</button>
    </div>
    <div id="rep-body">${skeletonRows()}</div>`;

  let report = null;
  const load = async () => {
    const body = document.getElementById('rep-body');
    body.innerHTML = skeletonRows();
    try {
      report = await api('GET', `/v1/reports/ads/${adId}?from=${from}&to=${to}`);
      document.getElementById('rep-title').textContent = report.title;
      draw();
    } catch (e) {
      body.innerHTML = `<div class="errbox">${esc(e.code === 'API-4001' ? (e.details?.[0]?.reason ?? e.message) : apiErrorMessage(e))}</div>`;
    }
  };

  const draw = () => {
    const body = document.getElementById('rep-body');
    const rows = [...report.rows];
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    const t = byDate[today] ?? { citations: 0, cost: 0, impressions: 0, clicks: 0 };
    const p = byDate[jstOffset(today, -1)] ?? { citations: 0, cost: 0, impressions: 0, clicks: 0 };
    const hasAny = rows.some((r) => r.citations || r.impressions || r.clicks || r.cost);

    const delta = (cur, prev) => {
      if (!prev) return '<span class="flat d">—</span>';
      const pctv = ((cur - prev) / prev) * 100;
      const cls = pctv > 0 ? 'up' : pctv < 0 ? 'dn' : 'flat';
      const arrow = pctv > 0 ? '▲' : pctv < 0 ? '▼' : '＝';
      return `<span class="${cls} d">${arrow} ${Math.abs(pctv).toFixed(1)}%（前日比）</span>`;
    };
    const ctr = (r) => (r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null);
    const ctrT = ctr(t); const ctrP = ctr(p);
    const ctrDelta = (ctrT == null || ctrP == null)
      ? '<span class="flat d">—</span>'
      : `<span class="${ctrT >= ctrP ? 'up' : 'dn'} d">${ctrT >= ctrP ? '▲' : '▼'} ${Math.abs(ctrT - ctrP).toFixed(2)}pt</span>`;

    body.innerHTML = `
      <div class="kpi">
        <div class="card" title="本日の値は速報値です（日次バッチで確定します）"><div class="k">本日の引用（配置）数</div><div class="v">${num(t.citations)}<small> 件</small></div>${delta(t.citations, p.citations)}</div>
        <div class="card" title="本日の値は速報値です（日次バッチで確定します）"><div class="k">本日の引用課金額</div><div class="v">${yen(t.cost)}</div>${delta(t.cost, p.cost)}</div>
        <div class="card"><div class="k">本日の表示数 <span style="font-weight:400">*</span></div><div class="v">${num(t.impressions)}<small> 回</small></div>${delta(t.impressions, p.impressions)}</div>
        <div class="card"><div class="k">クリック / CTR <span style="font-weight:400">*</span></div><div class="v">${num(t.clicks)}<small> 回 / ${ctrT == null ? '—' : ctrT.toFixed(2) + '%'}</small></div>${ctrDelta}</div>
      </div>
      ${hasAny ? `
      <table class="gtable">
        <tr><th>日付</th><th>引用数</th><th>課金額</th><th>表示数 *</th><th>クリック *</th><th>CTR *</th><th></th></tr>
        ${rows.slice().reverse().map((r) => `<tr>
          <td class="mono">${esc(r.date.replaceAll('-', '/'))}</td>
          <td>${num(r.citations)}</td><td>${yen(r.cost)}</td>
          <td>${num(r.impressions)}</td><td>${num(r.clicks)}</td>
          <td>${r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(2) + '%' : '—'}</td>
          <td class="mini">${r.finalized ? '確定' : '速報値'}</td>
        </tr>`).join('')}
      </table>` : '<div class="empty">選択期間の実績がまだありません。配信開始後、翌日から確定値が表示されます。</div>'}
      <p class="note-fixed">* 表示数・クリック数は課金対象外の参考指標です。同一ユーザーの再閲覧・再読み込みを含みます。</p>`;
  };

  document.getElementById('rep-period').addEventListener('change', (e) => {
    period = e.target.value;
    document.getElementById('rep-custom').style.display = period === 'custom' ? 'inline' : 'none';
    if (period === '7d') { from = jstOffset(today, -6); to = today; load(); }
    else if (period === '30d') { from = jstOffset(today, -29); to = today; load(); }
  });
  document.getElementById('rep-apply').addEventListener('click', () => {
    const f = document.getElementById('rep-from').value;
    const t2 = document.getElementById('rep-to').value;
    if (!f || !t2 || f > t2) { toast('期間：日付の指定が不正です', true); return; }
    const days = (Date.parse(t2) - Date.parse(f)) / 86400000 + 1;
    if (days > 93) { toast('期間：最大93日まで指定できます', true); return; }
    from = f; to = t2; load();
  });
  document.getElementById('btn-csv').addEventListener('click', () => {
    if (!report) return;
    const head = '日付,引用数,課金額,表示数,クリック数,CTR';
    const lines = report.rows.map((r) => [
      r.date, r.citations, r.cost, r.impressions, r.clicks,
      r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(2) + '%' : '',
    ].join(','));
    const csv = '﻿' + [head, ...lines].join('\r\n'); // BOM付きUTF-8(SD-001 6.2 #4)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rag-ads_report_${adId}_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  load();
}

// ===== S-05 審査キュー(管理者) ================================================
async function viewReview() {
  const main = document.getElementById('main');
  if (session.user?.role !== 'admin') {
    main.innerHTML = `<div class="forbidden"><h2>403</h2><p>このページにアクセスする権限がありません。</p></div>`;
    return;
  }
  main.innerHTML = `<div class="page-title"><h1>審査キュー</h1></div><div id="rev-area">${skeletonRows()}</div>`;

  let queue = [];
  let selected = null;

  const load = async () => {
    try {
      const r = await api('GET', '/v1/ads?status=reviewing');
      queue = r.ads.sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '')); // 先入れ先出し
      if (!queue.find((q) => q.adId === selected)) selected = queue[0]?.adId ?? null;
      draw();
    } catch (e) {
      // 401時はapi()がログイン画面へ再描画済みでrev-areaが存在しないことがある
      const area = document.getElementById('rev-area');
      if (area) area.innerHTML = `<div class="errbox">${esc(apiErrorMessage(e))}</div>`;
    }
  };

  const warnBadge = (findings) => {
    if (!findings?.length) return '<span class="badge badge-warn-none">警告なし</span>';
    const cls = findings.some((f) => f.severity === 'high') ? 'badge-warn-high' : 'badge-warn-mid';
    return `<span class="badge ${cls}">警告 ${findings.length}件</span>`;
  };

  const draw = async () => {
    const area = document.getElementById('rev-area');
    if (!area) return; // 画面遷移済み(ログイン画面等)なら何もしない
    if (queue.length === 0) {
      area.innerHTML = '<div class="empty"><b>審査待ちの広告はありません。</b></div>';
      return;
    }
    area.innerHTML = `
      <div class="review-layout">
        <div class="review-list">
          ${queue.map((q) => `
            <div class="review-item ${q.adId === selected ? 'sel' : ''}" data-sel="${esc(q.adId)}">
              <b>${esc(q.title)}</b>
              <div class="mini">${esc(q.category ?? '')} ／ ${fmtDateTime(q.submittedAt)}</div>
              <div style="margin-top:4px">${warnBadge(q.findings)}</div>
            </div>`).join('')}
        </div>
        <div class="review-detail" id="rev-detail">${'<div class="skel"></div>'.repeat(3)}</div>
      </div>`;
    area.querySelectorAll('[data-sel]').forEach((el) => el.addEventListener('click', () => {
      selected = el.dataset.sel;
      draw();
    }));
    if (selected) drawDetail();
  };

  const drawDetail = async () => {
    const box = document.getElementById('rev-detail');
    let d;
    try {
      d = await api('GET', `/v1/ads/${selected}`);
    } catch (e) {
      box.innerHTML = `<div class="errbox">${esc(apiErrorMessage(e))}</div>`;
      return;
    }
    const ad = d.ad;
    const adTextHtml = highlightIn(ad.adText ?? '', (ad.findings ?? []).map((f) => f.text));
    const sevColor = { high: 'var(--rag-err)', mid: 'var(--rag-warn)', low: 'var(--rag-sub)' };
    box.innerHTML = `
      <div class="page-title" style="margin-bottom:10px"><h1 style="font-size:15px">${esc(ad.title)}</h1>${badge(ad.status)}</div>
      <table class="gtable" style="margin-bottom:12px;font-size:12px">
        <tr><th style="width:26%">広告主 / カテゴリ</th><td>${esc(ad.advertiserEmail ?? ad.advertiserId)} ／ ${esc(ad.category ?? '')}</td></tr>
        <tr><th>広告テキスト</th><td style="white-space:pre-wrap">${adTextHtml}</td></tr>
        <tr><th>URL / 単価 / 期間</th><td><span class="mono" style="font-size:11.5px">${esc(ad.landingUrl ?? '')}</span> ／ ${yen(ad.unitPriceCitation)}/回 ／ ${esc(ad.campaignStart)}〜${esc(ad.campaignEnd)}</td></tr>
        <tr><th>ターゲット / タグ</th><td>${ad.target?.ageRange ? `${ad.target.ageRange[0]}〜${ad.target.ageRange[1]}歳・` : ''}${esc(ad.target?.region ?? '地域未設定')}${ad.target?.questionTypes?.length ? '・' + ad.target.questionTypes.map(esc).join('／') : ''}　${[...(ad.tags ?? []), ...(ad.keywords ?? [])].map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td></tr>
      </table>
      ${ad.findings?.length ? `
      <div class="alertbox" style="margin-top:0"><b>⚠ 表現チェック結果（${ad.findings.length}件）</b>
        <table class="gtable" style="margin-top:8px;font-size:11.5px">
          <tr><th>該当箇所</th><th>関連法令</th><th>理由</th><th>重要度</th></tr>
          ${ad.findings.map((f) => `<tr>
            <td>「${esc(f.text)}」</td><td>${esc(f.law)}</td><td>${esc(f.reason)}</td>
            <td><b style="color:${sevColor[f.severity] ?? 'inherit'}">${esc(f.severity)}</b></td>
          </tr>`).join('')}
        </table>
      </div>` : '<div class="notebox">表現チェック：問題となる表現は検出されませんでした。</div>'}
      <div class="field" style="margin-top:12px">
        <label>差戻し理由 <span class="rq">差戻し時必須</span><span class="cnt" id="note-cnt">0 / 500</span></label>
        <textarea class="inp" id="rev-note" rows="3" placeholder="修正が必要な箇所と理由を記入（広告主に通知されます）"></textarea>
        <div class="ferr" id="note-err" style="display:none"></div>
      </div>
      <div class="hstack" style="margin-top:6px">
        <span style="flex:5"></span>
        <button class="btn btn-w grow0" id="btn-reject">差戻す</button>
        <button class="btn btn-p grow0" id="btn-approve">承認する</button>
      </div>`;

    document.getElementById('rev-note').addEventListener('input', (e) => {
      const c = document.getElementById('note-cnt');
      c.textContent = `${e.target.value.length} / 500`;
      c.classList.toggle('over', e.target.value.length > 500);
    });
    document.getElementById('btn-approve').addEventListener('click', async () => {
      const ok = await confirmModal('承認して配信登録しますか？（開始日以降、自動的に配信されます）', '承認する');
      if (!ok) return;
      try {
        await api('PATCH', `/v1/ads/${selected}/status`, { to: 'approved' });
        toast('承認しました');
        load();
      } catch (e) {
        toast(apiErrorMessage(e), true);
        if (e.code === 'API-4091') load();
      }
    });
    document.getElementById('btn-reject').addEventListener('click', async () => {
      const note = document.getElementById('rev-note').value;
      const errBox = document.getElementById('note-err');
      if (note.length < 1 || note.length > 500) {
        errBox.textContent = '差戻し理由：入力してください（500文字以内）';
        errBox.style.display = '';
        return;
      }
      errBox.style.display = 'none';
      const ok = await confirmModal('この広告を差戻しますか？入力した理由が広告主に表示されます。', '差戻す', 'btn-d');
      if (!ok) return;
      try {
        await api('PATCH', `/v1/ads/${selected}/status`, { to: 'needs_fix', reviewNote: note });
        toast('差戻しました。広告主に理由が表示されます');
        load();
      } catch (e) {
        toast(apiErrorMessage(e), true);
        if (e.code === 'API-4091') load();
      }
    });
  };

  load();
}

// ===== 起動 ==================================================================
(async () => {
  if (session.token) {
    const user = await window.RAGAuth.validateToken(session.token);
    if (user) session.user = user; else { session.token = null; session.user = null; }
  }
  render();
})();
