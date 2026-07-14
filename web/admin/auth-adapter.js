/**
 * 認証アダプタ。デプロイ環境(Cognito)とローカル開発(簡易セッション)を透過的に切り替える。
 *
 * デプロイ時: FrontStackが config.js を配信し window.RAG_ADS_CONFIG を定義する
 *   → Cognito USER_PASSWORD_AUTH(ブラウザから直接InitiateAuth)でIdTokenを取得し、
 *     API Gateway(apiBase)へBearerで送る。
 * ローカル時: config.js が無ければ /v1/auth/login の簡易セッション(同一オリジン)を使う。
 *
 * app.js はこの window.RAGAuth を経由して認証する(apiBaseの付与もここで一元化)。
 */
(function () {
  'use strict';
  const cfg = window.RAG_ADS_CONFIG || null;
  const mode = cfg ? 'cognito' : 'local';
  const apiBase = cfg?.apiBase ?? '';

  /** JWTのペイロードをデコード(検証はAPI Gateway側。ここでは表示・期限判定のみ) */
  function decodeJwt(token) {
    try {
      const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(payload).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch { return null; }
  }

  function userFromClaims(claims) {
    let groups = claims['cognito:groups'] ?? [];
    if (typeof groups === 'string') groups = groups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
    return {
      email: claims.email ?? claims['cognito:username'] ?? claims.sub,
      role: groups.includes('admin') ? 'admin' : 'advertiser',
      advertiserId: claims.sub,
    };
  }

  async function cognitoLogin(email, password) {
    const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: cfg.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.AuthenticationResult) {
      const err = new Error(data.message ?? 'ログインに失敗しました');
      err.status = 401;
      throw err;
    }
    const token = data.AuthenticationResult.IdToken;
    const claims = decodeJwt(token);
    return { token, user: userFromClaims(claims) };
  }

  async function localLogin(email, password) {
    const res = await fetch('/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error('認証失敗'); err.status = res.status; throw err; }
    return { token: data.token, user: data.user };
  }

  window.RAGAuth = {
    mode,
    apiBase,
    login: (email, password) => (mode === 'cognito' ? cognitoLogin(email, password) : localLogin(email, password)),
    async logout(token) {
      if (mode === 'local') { try { await fetch('/v1/auth/logout', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} }); } catch { /* noop */ } }
      // Cognitoはクライアント側でトークン破棄すれば十分(IdTokenは失効まで有効)
    },
    /** トークンから現在ユーザーを復元(起動時)。Cognitoはexp検証、ローカルは/v1/auth/me */
    async validateToken(token) {
      if (mode === 'cognito') {
        const claims = decodeJwt(token);
        if (!claims || (claims.exp && claims.exp * 1000 < Date.now())) return null;
        return userFromClaims(claims);
      }
      try {
        const res = await fetch('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return null;
        return (await res.json()).user;
      } catch { return null; }
    },
  };
})();
