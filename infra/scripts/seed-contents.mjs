/**
 * dev記事テーブル(rag_ads_contents_{env})へのシード投入。
 * 本番は媒体側NewFan-Finance既存記事テーブルを参照するため不要。dev検証用。
 * 使い方: node seed-contents.mjs [env] [region]
 *   例: node infra/scripts/seed-contents.mjs dev ap-northeast-1
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const ENV = process.argv[2] || 'dev';
const REGION = process.argv[3] || 'ap-northeast-1';
const TABLE = `rag_ads_contents_${ENV}`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const nowIso = () => new Date().toISOString();
const publishedAt = new Date(Date.now() - 20 * 86400000).toISOString();

const CONTENTS = [
  {
    contentId: 'FIN-001', genre: '経済・市況', title: '日銀利上げは住宅ローン金利にどう波及するか',
    sources: [{ name: '日本銀行 金融政策決定会合資料', url: 'https://www.boj.or.jp/' }],
    body: '日本銀行が政策金利を引き上げると、住宅ローン金利には二つの経路で影響が及ぶ。変動金利は短期プライムレートに連動し、固定金利は長期金利を基準に決まるため市場が利上げを織り込む段階で先行して上昇する。家計への影響は、現在の金利タイプ・残存期間・金利上昇時の返済額増分・貯蓄余力を整理して試算するとよい。',
  },
  {
    contentId: 'FIN-002', genre: 'ローン・クレジット', title: '変動と固定、2026年はどちらを選ぶべきか',
    sources: [{ name: '住宅金融支援機構 民間住宅ローン利用者調査', url: 'https://www.jhf.go.jp/' }],
    body: '住宅ローンの金利タイプ選びは「どちらが得か」ではなく「どちらのリスクを取れるか」で考える。変動金利は当初金利が低い一方で金利上昇リスクを借り手が負い、固定金利は金利を確定できる安心と引き換えに当初金利が高い。返済期間が短く金利上昇に耐えられる家計は変動、長期で安定重視なら固定が向く。',
  },
  {
    contentId: 'FIN-003', genre: 'ローン・クレジット', title: '住宅ローン借り換えの損益分岐点を試算する',
    sources: [{ name: '全国銀行協会 住宅ローン関連統計', url: 'https://www.zenginkyo.or.jp/' }],
    body: '住宅ローンの借り換えで得になるかは金利差だけでは判断できない。事務手数料・保証料・登記費用などの諸費用を含めた総返済額で比較する。損益分岐点は「諸費用の総額 ÷ 借り換えによる毎月の削減額」で回収月数を概算できる。残りの返済期間が回収期間より十分長ければ効果が見込める。変動から固定への借り換えでは金利確定という保険の価値も加味する。',
  },
  {
    contentId: 'FIN-004', genre: 'ローン・クレジット', title: '固定金利への借り換え、金利上昇局面の判断基準',
    sources: [{ name: '金融庁 住宅ローン利用実態調査', url: 'https://www.fsa.go.jp/' }],
    body: '金利上昇局面で変動から固定へ借り換える判断は「これから上がるか」の予想ではなく「上がったときに家計が耐えられるか」で行う。固定金利は長期金利を基準に決まるため市場が利上げを織り込んだ時点で既に上昇している。金利が2〜3%上昇した場合の返済額を試算し耐えられないなら固定化を優先する。固定への切り替えは保険料を払って安心を買う行為と整理できる。',
  },
  {
    contentId: 'FIN-005', genre: '株式・投信', title: 'つみたて投資の基本と2026年の制度ポイント',
    sources: [{ name: '金融庁 NISA特設サイト', url: 'https://www.fsa.go.jp/policy/nisa2/' }],
    body: 'つみたて投資は少額を定期的に長期で積み立て、価格変動リスクを平準化する。非課税制度を使う場合の基本は「長期・分散・低コスト」。全世界株式や米国株式に広く分散されたインデックスファンドを軸に、信託報酬が低い商品を選び、下落しても積立を止めない。老後資金など10年以上使わない資金を生活防衛資金と分けて積み立てる。',
  },
  {
    contentId: 'FIN-007', genre: 'FX・為替', title: '外貨預金の金利とリスクを整理する',
    sources: [{ name: '預金保険機構 制度解説', url: 'https://www.dic.go.jp/' }],
    body: '外貨預金は金利の高さが強調されがちだが、損益は金利と為替の両方で決まる。年利4%でも1年後に円高が4%進めば利息は相殺される。為替手数料は預入時と払戻時の両方でかかる。外貨預金は預金保険の対象外である点も円預金との本質的な違いとして理解しておきたい。実質利回りで判断する。',
  },
  {
    contentId: 'FIN-008', genre: '保険', title: '個人年金保険は本当に必要か、公的年金との関係',
    sources: [{ name: '生命保険文化センター 生活保障に関する調査', url: 'https://www.jili.or.jp/' }],
    body: '個人年金保険は老後資金準備の一手段だが、加入前に公的年金の受給見込みを確認するのが先決。定額型は予定利率が低く長期のインフレに弱く、中途解約すると解約返戻金が払込保険料を下回る期間が長い。一方で個人年金保険料控除による節税は他の積立手段にないメリット。税制優遇のある積立投資を優先し、保険料控除を重視する保守的な資金に限って検討する。',
  },
  {
    contentId: 'FIN-010', genre: '家計・節約', title: 'インフレ局面の家計防衛、固定費の見直し術',
    sources: [{ name: '総務省 家計調査', url: 'https://www.stat.go.jp/' }],
    body: 'インフレ局面では変動費を切り詰めるより固定費の見直しが持続的な効果を生む。優先度が高いのは通信費・保険・住宅ローン・サブスクリプションの4項目。住宅ローンは固定費の中で最も金額インパクトが大きく、金利タイプの見直しや借り換えは金利上昇局面での防衛の第一歩になる。年に1回、固定費の棚卸しを習慣にするとよい。',
  },
];

async function main() {
  console.log(`記事シード投入: ${TABLE} (${REGION})`);
  const items = CONTENTS.map((c) => ({
    PutRequest: { Item: { PK: `CONTENT#${c.contentId}`, SK: 'META', ...c, publishedAt, updatedAt: nowIso() } },
  }));
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: items.slice(i, i + 25) } }));
  }
  console.log(`完了: ${CONTENTS.length}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
