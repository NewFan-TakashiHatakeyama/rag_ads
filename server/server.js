/**
 * HTTPサーバー(ローカルPoC)。
 * 本番構成(API Gateway+Lambda群+S3/CloudFront)の全エンドポイントを単一プロセスで提供する。
 *  - /admin/*  広告管理コンソールSPA(S-01〜S-05)
 *  - /, /c/*   NewFan-Financeデモ(回答ページ+FE-01広告ブロック)
 *  - /v1/*     管理系・配信系API   - /r/*  クリック計測
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFromDisk, tables } from './store.js';
import { login, logout, authenticate, publicUser } from './auth.js';
import * as admin from './adminApi.js';
import { ApiError } from './adminApi.js';
import { answerQuestion, getPageAds, recordClick } from './pipeline.js';
import { runDailyAgg } from './batch.js';
import { seedAll } from './seed.js';
import { log } from './util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
const SITE_TOP = '/'; // クリック不正時のリダイレクト先(本番: https://finance.newfan.co.jp/)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': headers['Content-Type'] ?? 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function sendError(res, e) {
  if (e instanceof ApiError) {
    send(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
  } else {
    log('ERROR', 'admin_api', 'unhandled_error', { msg: e.message });
    send(res, 500, { error: { code: 'API-5001', message: '内部エラー' } });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new ApiError(400, 'API-4001', 'リクエストが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'API-4001', 'JSONの形式が不正です')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, fs.readFileSync(filePath), { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  return true;
}

const routes = [
  // ---- 認証 ----
  ['POST', /^\/v1\/auth\/login$/, async (req, res, m, url) => {
    const body = await readBody(req);
    const result = login(body.email, body.password);
    if (!result) throw new ApiError(401, 'API-4011', 'メールアドレスまたはパスワードが正しくありません');
    send(res, 200, result);
  }],
  ['POST', /^\/v1\/auth\/logout$/, async (req, res) => {
    const h = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] ?? '');
    if (h) logout(h[1]);
    send(res, 200, { ok: true });
  }],
  ['GET', /^\/v1\/auth\/me$/, async (req, res) => {
    const s = authenticate(req);
    if (!s) throw new ApiError(401, 'API-4011', '認証エラー(トークン欠落・失効)');
    send(res, 200, { user: publicUser(s) });
  }],

  // ---- 管理系API(Cognito JWT相当) ----
  ['GET', /^\/v1\/ads$/, async (req, res, m, url) => {
    const r = admin.listAds(authenticate(req), url.searchParams);
    send(res, r.status, r.body);
  }],
  ['POST', /^\/v1\/ads$/, async (req, res) => {
    const r = admin.createAd(authenticate(req), await readBody(req));
    send(res, r.status, r.body);
  }],
  ['GET', /^\/v1\/ads\/([A-Za-z0-9-]+)$/, async (req, res, m) => {
    const r = admin.getAd(authenticate(req), m[1]);
    send(res, r.status, r.body);
  }],
  ['PUT', /^\/v1\/ads\/([A-Za-z0-9-]+)$/, async (req, res, m) => {
    const r = admin.updateAd(authenticate(req), m[1], await readBody(req));
    send(res, r.status, r.body);
  }],
  ['PATCH', /^\/v1\/ads\/([A-Za-z0-9-]+)\/status$/, async (req, res, m) => {
    const r = admin.patchStatus(authenticate(req), m[1], await readBody(req));
    send(res, r.status, r.body);
  }],
  ['GET', /^\/v1\/ads\/([A-Za-z0-9-]+)\/link-candidates$/, async (req, res, m) => {
    const r = admin.linkCandidates(authenticate(req), m[1]);
    send(res, r.status, r.body);
  }],
  ['PUT', /^\/v1\/ads\/([A-Za-z0-9-]+)\/links\/([A-Za-z0-9_-]+)$/, async (req, res, m) => {
    const r = admin.putLink(authenticate(req), m[1], m[2], await readBody(req));
    send(res, r.status, r.body);
  }],
  ['DELETE', /^\/v1\/ads\/([A-Za-z0-9-]+)\/links\/([A-Za-z0-9_-]+)$/, async (req, res, m) => {
    const r = admin.deleteLink(authenticate(req), m[1], m[2]);
    send(res, r.status, r.body);
  }],
  ['GET', /^\/v1\/reports\/ads\/([A-Za-z0-9-]+)$/, async (req, res, m, url) => {
    const r = admin.getReport(authenticate(req), m[1], url.searchParams);
    send(res, r.status, r.body);
  }],
  ['GET', /^\/v1\/contents\/([A-Za-z0-9_-]+)$/, async (req, res, m, url) => {
    const r = admin.getContent(authenticate(req), m[1], url.searchParams);
    send(res, r.status, r.body);
  }],
  ['GET', /^\/v1\/params$/, async (req, res) => {
    const r = admin.getParamsApi(authenticate(req));
    send(res, r.status, r.body);
  }],
  ['PUT', /^\/v1\/params$/, async (req, res) => {
    const r = admin.putParamsApi(authenticate(req), await readBody(req));
    send(res, r.status, r.body);
  }],
  ['POST', /^\/v1\/batch\/daily-agg$/, async (req, res) => {
    const s = authenticate(req);
    if (!s) throw new ApiError(401, 'API-4011', '認証エラー(トークン欠落・失効)');
    if (s.role !== 'admin') throw new ApiError(403, 'API-4031', '権限エラー(管理者専用操作)');
    const body = await readBody(req);
    send(res, 200, runDailyAgg(body.date));
  }],

  // ---- 配信系API(公開) ----
  ['POST', /^\/v1\/questions$/, async (req, res) => {
    const body = await readBody(req);
    const q = typeof body.question === 'string' ? body.question.trim() : '';
    if (!q || q.length > 500) {
      throw new ApiError(400, 'API-4001', 'バリデーションエラー', [{ field: 'question', reason: '質問：1〜500文字で入力してください' }]);
    }
    send(res, 200, answerQuestion(q));
  }],
  ['GET', /^\/v1\/pages\/([0-9a-f]{8,64})$/i, async (req, res, m) => {
    const page = tables.pages.get(`PAGE#${m[1]}`, 'META');
    if (!page) throw new ApiError(404, 'API-4041', 'リソースが存在しません');
    const { PK, SK, ...rest } = page;
    send(res, 200, rest, { 'Cache-Control': 'no-store' });
  }],
  ['GET', /^\/v1\/pages\/([^/]+)\/ads$/, async (req, res, m) => {
    // pageId形式不正・未存在も200の空配列(6.2.2)
    const pageId = m[1];
    const ads = /^[0-9a-f]{8,64}$/i.test(pageId) ? getPageAds(pageId) : [];
    send(res, 200, { pageId, ads }, { 'Cache-Control': 'no-store' });
  }],
  ['GET', /^\/r\/([^/]+)\/([^/]+)$/, async (req, res, m) => {
    const target = recordClick(m[1], m[2]);
    // 不正時はサイトトップへ302(ADS-3001)。宛先はPlacementスナップショットのみ(オープンリダイレクト防止)
    res.writeHead(302, { Location: target ?? SITE_TOP });
    res.end();
  }],
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // 不正なパーセントエンコーディング(/%zz等)はリクエストエラーであり、サーバー障害にしない
      send(res, 400, { error: { code: 'API-4001', message: 'リクエストパスが不正です' } });
      return;
    }
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = pattern.exec(pathname);
      if (!m) continue;
      await handler(req, res, m, url);
      return;
    }
    // ---- 静的配信 ----
    if (req.method === 'GET' || req.method === 'HEAD') {
      // 管理コンソール
      if (pathname === '/admin' || pathname === '/admin/') {
        if (serveStatic(res, path.join(WEB, 'admin', 'index.html'))) return;
      }
      if (pathname.startsWith('/admin/')) {
        const rel = path.normalize(pathname.slice('/admin/'.length)).replace(/^([.][.][\\/])+/, '');
        if (serveStatic(res, path.join(WEB, 'admin', rel))) return;
        if (serveStatic(res, path.join(WEB, 'admin', 'index.html'))) return;
      }
      // デモサイト(回答ページは /c/{pageId})
      if (pathname === '/' ) {
        if (serveStatic(res, path.join(WEB, 'site', 'index.html'))) return;
      }
      if (/^\/c\/[0-9a-f]{8,64}$/i.test(pathname)) {
        if (serveStatic(res, path.join(WEB, 'site', 'page.html'))) return;
      }
      if (pathname.startsWith('/site/')) {
        const rel = path.normalize(pathname.slice('/site/'.length)).replace(/^([.][.][\\/])+/, '');
        if (serveStatic(res, path.join(WEB, 'site', rel))) return;
      }
    }
    if (pathname.startsWith('/v1/') || pathname.startsWith('/r/')) {
      throw new ApiError(404, 'API-4041', 'リソースが存在しません');
    }
    send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    sendError(res, e);
  }
});

// 最後の砦: 想定外の例外・rejectionでプロセスを落とさない(広告システムのフェイルセーフ方針)
process.on('unhandledRejection', (e) => {
  log('ERROR', 'admin_api', 'unhandled_rejection', { msg: e instanceof Error ? e.message : String(e) });
});
process.on('uncaughtException', (e) => {
  log('ERROR', 'admin_api', 'uncaught_exception', { msg: e.message });
});

// 起動: 永続データがあれば読み込み、なければシード投入
if (!loadFromDisk()) {
  seedAll();
  log('INFO', 'admin_api', 'seeded', { msg: '初期データを投入しました' });
}
server.listen(PORT, () => {
  log('INFO', 'admin_api', 'server_started', { msg: `http://localhost:${PORT}` });
  console.log(`RAG-Ads PoC server: http://localhost:${PORT}  (admin: /admin, demo site: /)`);
});
