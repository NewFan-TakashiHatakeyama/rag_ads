// テストはインメモリで実行(data/db.jsonを汚染しない)。store.jsより先に評価されること
process.env.RAG_ADS_MEMORY = '1';
