/**
 * ランタイム設定。ローカル開発では空(window.RAG_ADS_CONFIG 未定義=簡易セッション認証)。
 * デプロイ時は FrontStack がこのファイルを実値で上書きする:
 *   window.RAG_ADS_CONFIG = { apiBase, region, userPoolId, userPoolClientId };
 */
