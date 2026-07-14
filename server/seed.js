/**
 * 初期データ投入。
 * 記事(既存NewFan-Finance記事テーブル相当)・ユーザー(Cognito相当)・サンプル広告・
 * 過去7日分の日次統計(デモ用)を投入する。広告データはSD-001のモックアップに登場する
 * サンプルに準拠する。
 */
import { tables, resetAll, saveNow } from './store.js';
import { createUser } from './auth.js';
import { screenAd } from './llm.js';
import { syncVector } from './adminApi.js';
import { validateAd } from './validate.js';
import { embed, similarity, adEmbeddingText, contentEmbeddingText } from './vector.js';
import { round4 } from './util.js';
import { nowIso, jstDate, jstDateOffset } from './util.js';

// ---- 記事(読み取り専用参照。既存スキーマ相当) ------------------------------
const CONTENTS = [
  {
    contentId: 'FIN-001', genre: '経済・市況',
    title: '日銀利上げは住宅ローン金利にどう波及するか',
    summary: '日銀の政策金利引き上げは、まず短期プライムレートに連動する変動金利へ波及し、固定金利は長期金利の動向を通じて先行して変化する傾向があります。利上げが返済額に反映されるまでのタイムラグ(5年ルール・125%ルールの有無)を確認することが重要です。',
    sources: [{ name: '日本銀行 金融政策決定会合資料', url: 'https://www.boj.or.jp/' }],
    baseCitationsDaily: [38, 41, 35, 44, 40, 39, 41],
    body: '日本銀行が政策金利を引き上げると、住宅ローン金利には二つの経路で影響が及ぶ。第一の経路は変動金利型への影響である。変動金利は多くの銀行で短期プライムレートに連動しており、政策金利の引き上げが短プラの引き上げにつながると、適用金利が見直される。ただし、多くの契約には返済額の見直しを5年ごとに行う「5年ルール」や、見直し後の返済額を従前の125%までに抑える「125%ルール」があり、金利上昇が即座に毎月の返済額へ反映されるわけではない。\n\n第二の経路は固定金利型への影響である。固定金利は主に10年国債利回りなどの長期金利を基準に決まるため、市場が将来の利上げを織り込む段階で先行して上昇する傾向がある。実際、過去の利上げ局面では、政策変更の発表前から固定金利が段階的に引き上げられてきた。\n\n家計への影響を試算する際は、①現在の金利タイプと残存期間、②金利が1%上昇した場合の返済額増分、③貯蓄や収入の余力、の3点を整理するとよい。特に変動金利で借りている場合、未払利息が発生する水準まで金利が上昇するケースも理論上はあり得るため、返済額の内訳(元金と利息の比率)を定期的に確認したい。',
  },
  {
    contentId: 'FIN-002', genre: 'ローン・クレジット',
    title: '変動と固定、2026年はどちらを選ぶべきか',
    summary: '2026年の金利環境では、返済期間が短く金利上昇に耐えられる家計は変動金利、返済期間が長く安定性を重視する家計は固定金利が有力です。金利差だけでなく、家計の余力と金利上昇時の対応策で選ぶことが大切です。',
    sources: [{ name: '住宅金融支援機構 民間住宅ローン利用者調査', url: 'https://www.jhf.go.jp/' }],
    baseCitationsDaily: [22, 27, 25, 24, 26, 23, 27],
    body: '住宅ローンの金利タイプ選びは「どちらが得か」ではなく「どちらのリスクを取れるか」で考えるのが基本である。変動金利は当初の適用金利が低い一方、将来の金利上昇リスクを借り手が負う。固定金利は金利を確定できる安心と引き換えに、当初金利が変動より高い。\n\n2026年の環境では、政策金利の正常化が進み、変動と固定の金利差は以前より縮小している。判断の目安として、①返済期間が10年以内、②金利が2%上昇しても家計が耐えられる、③繰上げ返済の余力がある、の多くに当てはまるなら変動金利の合理性が高い。逆に、返済期間が25年以上に及ぶ、教育費などで今後の支出増が見込まれる、金利動向を追いかけたくない、という場合は固定金利や固定期間選択型が向いている。\n\nまた、変動で借りて浮いた返済額を貯蓄・運用に回し、金利上昇時に繰上げ返済で対応する「変動+備え」の戦略も広く用いられる。この場合は、備えの資金を生活費と分けて管理できるかが成否を分ける。',
  },
  {
    contentId: 'FIN-003', genre: 'ローン・クレジット',
    title: '住宅ローン借り換えの損益分岐点を試算する',
    summary: '借り換えの効果は「金利差1%・残高1,000万円以上・残期間10年以上」が目安とされますが、実際には事務手数料・保証料・登記費用などの諸費用を含めた総返済額で比較する必要があります。損益分岐点は諸費用を月々の削減額で割ることで概算できます。',
    sources: [{ name: '全国銀行協会 住宅ローン関連統計', url: 'https://www.zenginkyo.or.jp/' }],
    baseCitationsDaily: [15, 18, 17, 16, 19, 18, 17],
    body: '住宅ローンの借り換えで実際に得になるかどうかは、金利差だけでは判断できない。借り換えには、事務手数料(定額型で3万〜33万円、定率型で借入額の2.2%程度)、保証料、抵当権の抹消・設定登記の費用、印紙税、司法書士報酬といった諸費用がかかるためである。借入額3,000万円の定率型手数料であれば、それだけで66万円程度になる。\n\n損益分岐点の考え方はシンプルで、「諸費用の総額 ÷ 借り換えによる毎月の返済削減額」で、何ヶ月で諸費用を回収できるかを概算できる。たとえば諸費用が60万円、毎月の削減額が1万5,000円なら、回収には40ヶ月(約3年4ヶ月)かかる。残りの返済期間がこの回収期間より十分に長ければ、借り換えの効果が見込める。\n\n従来から「金利差1%以上・ローン残高1,000万円以上・残存期間10年以上」が借り換えの目安といわれてきたが、近年はネット銀行を中心に手数料体系が多様化しており、金利差0.5%程度でも効果が出るケースがある。逆に、残高が少ない・残期間が短い場合は、金利差が大きくても諸費用倒れになりやすい。\n\n試算の手順は次のとおりである。第一に、現在のローンの残高・残期間・適用金利を返済予定表で確認する。第二に、借り換え候補の金利・手数料体系で新しい毎月返済額を計算する。第三に、諸費用込みの総返済額どうしを比較する。このとき、変動から固定への借り換えでは、金利確定という保険の価値も加味して判断したい。\n\nなお、借り換えでは団体信用生命保険(団信)も新しく加入し直すことになる。健康状態によっては団信に加入できず借り換え自体ができないことがあるほか、がん保障付きなど団信の保障内容を手厚くすると金利が上乗せされる。金利差の比較では、団信の保障内容を揃えて比べることが公平な比較の前提となる。また、収入が下がっている場合や転職直後の場合は審査面の考慮も必要である。借り換えは「審査に通る健康状態と収入があるうちに検討する」のが原則であり、金利動向を眺めて待ち続けることにもリスクがあることは意識しておきたい。',
  },
  {
    contentId: 'FIN-004', genre: 'ローン・クレジット',
    title: '固定金利への借り換え、金利上昇局面の判断基準',
    summary: '金利上昇局面で変動から固定へ借り換える判断は、「これから上がるか」の予想ではなく、「上がったときに家計が耐えられるか」で行うのが原則です。固定への切り替えは保険料を払って安心を買う行為と整理できます。',
    sources: [{ name: '金融庁 住宅ローン利用実態調査', url: 'https://www.fsa.go.jp/' }],
    baseCitationsDaily: [10, 12, 11, 13, 12, 11, 12],
    body: '金利が上がり始めると「固定に借り換えるべきか」という相談が増える。しかし、変動から固定への切り替えを金利予想で判断するのは危うい。固定金利は長期金利を基準に決まるため、市場が利上げを織り込んだ時点で既に上昇しており、「上がってから固定にする」のでは遅くなりがちだからである。\n\n実務的な判断基準は次の3つに整理できる。①金利が2〜3%上昇した場合の返済額を試算し、家計が耐えられないなら固定化を優先する。②残存期間が長い(20年以上)ほど金利上昇の影響が大きく、固定化の価値が高い。③貯蓄が十分にあり、いざとなれば繰上げ返済で残高を大きく減らせるなら、変動を維持する選択にも合理性がある。\n\n固定への借り換えは「保険」と考えるとよい。保険料(変動との金利差)を払って、将来の返済額を確定させる。保険が不要な家計(余力が大きい)には割高で、保険が必要な家計(余力が小さい)には価値がある。自分の家計がどちらかを見極めることが、金利予想より先にやるべきことである。',
  },
  {
    contentId: 'FIN-005', genre: '株式・投信',
    title: 'つみたて投資の基本と2026年の制度ポイント',
    summary: 'つみたて投資は、少額を定期的に長期で積み立てることで価格変動リスクを平準化する投資手法です。非課税制度を活用する場合は、生涯投資枠と年間投資枠、対象商品の範囲を確認したうえで、長期・分散・低コストの原則を守ることが重要です。',
    sources: [{ name: '金融庁 NISA特設サイト', url: 'https://www.fsa.go.jp/policy/nisa2/' }],
    baseCitationsDaily: [30, 28, 33, 31, 29, 32, 30],
    body: 'つみたて投資の最大の利点は、購入タイミングの判断を手放せることにある。毎月一定額を買い付けることで、価格が高いときは少なく、安いときは多く買うことになり、平均取得単価が平準化される(ドル・コスト平均法)。\n\n非課税制度を使う場合の基本は「長期・分散・低コスト」である。具体的には、①全世界株式や米国株式などに広く分散されたインデックスファンドを軸にする、②信託報酬などの保有コストが低い商品を選ぶ、③相場が下落しても積立を止めない、の3点が実践の柱になる。\n\n制度面では、年間投資枠と生涯投資枠の範囲内で、いつでも売却でき、売却した分の枠が翌年以降に復活する点が使い勝手を高めている。一方で、非課税の恩恵は利益が出て初めて意味を持つため、短期売買や集中投資で枠を消費するのは制度の趣旨に合わない。老後資金など10年以上使わない資金を、生活防衛資金(生活費の6ヶ月〜1年分)と分けたうえで積み立てるのが原則である。',
  },
  {
    contentId: 'FIN-006', genre: '株式・投信',
    title: '成長投資枠の使い方と高配当株投資の注意点',
    summary: '成長投資枠は個別株やアクティブファンドにも使える柔軟な枠ですが、非課税メリットを最大化するには、長期保有を前提とした銘柄選びが重要です。高配当株投資では減配リスクと株価下落リスクを分けて考える必要があります。',
    sources: [{ name: '日本取引所グループ 統計資料', url: 'https://www.jpx.co.jp/' }],
    baseCitationsDaily: [12, 14, 13, 15, 12, 14, 13],
    body: '成長投資枠では、つみたて対象の投資信託に加えて、上場株式やETF、アクティブファンドも購入できる。自由度が高い分、使い方の巧拙が結果に直結する。\n\n高配当株を非課税枠で保有する戦略は、配当への課税(約20%)がゼロになるため人気がある。ただし注意点が二つある。第一に、非課税枠では損益通算ができないため、値下がりした場合に他の利益と相殺できない。第二に、高配当の背景に業績悪化がある「罠銘柄」を掴むと、減配と株価下落の二重の損失を被る。配当利回りの高さだけでなく、配当性向、フリーキャッシュフロー、減配履歴を確認したい。\n\n初心者が成長投資枠を使う場合も、まずは分散されたインデックスファンドを軸にし、個別株は資産の一部にとどめるのが無難である。',
  },
  {
    contentId: 'FIN-007', genre: 'FX・為替',
    title: '外貨預金の金利とリスクを整理する',
    summary: '外貨預金の高金利は魅力的に見えますが、為替変動リスク・為替手数料・預金保険の対象外という3つのコストとリスクを差し引いて実質利回りで判断する必要があります。金利差だけで選ぶと為替差損で元本割れすることがあります。',
    sources: [{ name: '預金保険機構 制度解説', url: 'https://www.dic.go.jp/' }],
    baseCitationsDaily: [8, 9, 7, 10, 9, 8, 9],
    body: '外貨預金は「金利の高さ」が強調されがちだが、実際の損益は金利と為替の両方で決まる。たとえば年利4%の米ドル預金でも、1年後に円高が4%進めば利息は為替差損で相殺され、手数料分だけマイナスになる。\n\n見落とされやすいコストが為替手数料である。預入時と払戻時の両方でかかり、往復で1円/ドル程度になる銀行もある。1ドル150円なら往復で約0.67%のコストであり、金利の一部が確実に削られる。ネット銀行では手数料が数銭〜25銭程度と安い場合が多く、同じ通貨でも実質利回りに差が出る。\n\nまた、外貨預金は預金保険(ペイオフ)の対象外である。銀行が破綻した場合の保護がない点は、円預金との本質的な違いとして理解しておきたい。外貨建て資産を持つこと自体は分散の観点で合理性があるが、その手段としては、コストの低い外貨建てMMFや為替ヘッジなしの投資信託との比較検討が有益である。',
  },
  {
    contentId: 'FIN-008', genre: '保険',
    title: '個人年金保険は本当に必要か、公的年金との関係',
    summary: '個人年金保険は老後資金準備の一手段ですが、予定利率・中途解約時の元本割れ・インフレへの弱さを踏まえると、税制優遇口座での積立投資と比較して選ぶべき商品です。個人年金保険料控除の節税効果は加入判断の補助材料になります。',
    sources: [{ name: '生命保険文化センター 生活保障に関する調査', url: 'https://www.jili.or.jp/' }],
    baseCitationsDaily: [6, 7, 6, 8, 7, 6, 7],
    body: '個人年金保険は、契約時に定めた年齢から年金を受け取る貯蓄型の保険である。老後資金の準備手段として広く販売されているが、加入判断の前に公的年金の受給見込みを確認することが先決である。ねんきん定期便やねんきんネットで将来の受給額を把握し、不足分を私的に準備するという順序で考える。\n\n定額型の個人年金保険は予定利率が低く、長期のインフレに弱い。また、中途解約すると解約返戻金が払込保険料を下回る期間が長い。一方で、個人年金保険料控除により所得税・住民税の負担が軽減される点は、他の積立手段にはないメリットである。\n\n実務的には、①税制優遇のある積立投資(投資信託)を優先し、②元本確保性と保険料控除を重視する保守的な資金に限って個人年金保険を検討する、という整理が合理的である。すでに加入している契約は、解約より払済保険への変更が有利な場合もあるため、解約返戻金の推移を確認してから判断したい。',
  },
  {
    contentId: 'FIN-009', genre: '家計・節約',
    title: 'クレジットカードのポイント還元を最大化する',
    summary: 'ポイント還元の最大化は、メインカード1枚への集約、固定費の支払い集約、年会費と還元率の損益分岐の確認が基本です。還元率だけでなくポイントの使い道(交換先の価値)まで含めて実質還元率で比較することが重要です。',
    sources: [{ name: '日本クレジット協会 統計', url: 'https://www.j-credit.or.jp/' }],
    baseCitationsDaily: [9, 11, 10, 9, 12, 10, 11],
    body: 'カードのポイントを効率よく貯める第一歩は、支払いをメインカード1枚に集約することである。複数カードに分散するとポイントが端数のまま失効しやすい。水道光熱費・通信費・保険料などの固定費をカード払いにまとめると、生活を変えずに毎月数千円分の決済が上乗せされる。\n\n年会費のあるカードは「年会費 ÷ 還元率の差」で損益分岐の決済額を計算する。たとえば年会費1万1,000円、還元率が無料カードより0.5%高いカードなら、年間220万円以上使わなければ元が取れない。\n\n見落とされがちなのがポイントの出口である。同じ1万ポイントでも、交換先によって価値は変わる。マイルへの交換は価値が高くなり得る一方、使い勝手は下がる。自分が確実に使う交換先での価値を基準に「実質還元率」で比較するのが実践的である。',
  },
  {
    contentId: 'FIN-010', genre: '家計・節約',
    title: 'インフレ局面の家計防衛、固定費の見直し術',
    summary: '物価上昇局面の家計防衛は、変動費の節約より固定費の見直しが効果的です。通信費・保険・住宅ローン・サブスクリプションの4大固定費を年1回棚卸しし、金利負担と保障の重複を点検することで、無理なく支出を圧縮できます。',
    sources: [{ name: '総務省 家計調査', url: 'https://www.stat.go.jp/' }],
    baseCitationsDaily: [11, 13, 12, 14, 12, 13, 12],
    body: 'インフレ局面では、日々の変動費を切り詰めるより、固定費の見直しが持続的な効果を生む。優先順位が高いのは次の4項目である。\n\n第一に通信費。大手キャリアからオンライン専用プランや格安SIMへの乗り換えで、家族全体では年間数万円の削減になることが多い。第二に保険。加入時から家族構成が変わっている場合、保障の重複や過剰保障が生じやすい。公的保障(高額療養費制度・遺族年金)を踏まえて必要保障額を再計算する。\n\n第三に住宅ローン。金利タイプの見直しや借り換えは、固定費の中で最も金額インパクトが大きい。金利上昇局面では、変動金利の返済額試算を最新の金利で更新しておくことが防衛の第一歩になる。第四にサブスクリプション。利用頻度が月1回未満のサービスは解約候補として棚卸しする。\n\nこれらは一度見直せば効果が毎月続く。年に1回、家計の固定費棚卸しの日を決めて点検する習慣が、インフレ下の実質所得の目減りを緩和する。',
  },
  {
    contentId: 'FIN-011', genre: '税金・年金',
    title: 'ふるさと納税と住宅ローン控除の併用の注意点',
    summary: 'ふるさと納税と住宅ローン控除は併用できますが、ワンストップ特例を使うか確定申告をするかで控除の計算経路が変わります。住宅ローン控除の初年度は確定申告が必須のため、ふるさと納税の限度額への影響を事前に試算することが大切です。',
    sources: [{ name: '国税庁 タックスアンサー', url: 'https://www.nta.go.jp/' }],
    baseCitationsDaily: [7, 8, 7, 9, 8, 7, 8],
    body: 'ふるさと納税と住宅ローン控除は制度上併用できるが、手続きの選び方で実質負担が変わることがある。ポイントは控除される税金の種類である。ふるさと納税(ワンストップ特例)は全額が住民税から控除されるのに対し、確定申告で行うと所得税と住民税に分かれて控除される。住宅ローン控除は所得税から控除され、引き切れない分が住民税から控除される(上限あり)。\n\n住宅ローン控除で所得税が全額還付されている人が確定申告でふるさと納税を行うと、ふるさと納税の所得税控除分が活かせず、自己負担が2,000円を超えるケースが生じ得る。この場合、ワンストップ特例を使えば全額住民税側で控除されるため影響を回避できる。\n\nただし、住宅ローン控除の初年度は確定申告が必須であり、ワンストップ特例は使えない(申告すると特例申請は無効になる)。初年度は限度額シミュレーションで影響額を確認してから寄付額を決めるとよい。2年目以降は年末調整で完結するため、ワンストップ特例との併用が選択肢に戻る。',
  },
  {
    contentId: 'FIN-012', genre: '債券・金利',
    title: '金利上昇局面の債券投資、個人向け国債の選び方',
    summary: '金利上昇局面では既発債券の価格は下落しますが、個人向け国債(変動10年)は実勢金利に連動して利率が見直されるため金利上昇の恩恵を受けられます。中途換金時のペナルティ(直前2回分の利子相当額)を含めて商品性を理解することが大切です。',
    sources: [{ name: '財務省 個人向け国債', url: 'https://www.mof.go.jp/' }],
    baseCitationsDaily: [5, 6, 5, 7, 6, 5, 6],
    body: '金利が上がると債券価格は下がる。この逆相関は債券投資の基本だが、個人が買える商品の中には金利上昇に強いものがある。代表が個人向け国債の変動10年である。半年ごとに利率が実勢金利(基準金利×0.66)に連動して見直されるため、金利上昇局面では受取利子が増えていく。\n\n個人向け国債は、発行後1年経てば額面で中途換金できる(直前2回分の利子相当額が差し引かれる)。価格変動による元本割れがない点で、市場で売買する利付国債や債券ファンドとは商品性が根本的に異なる。\n\n一方、固定3年・固定5年は購入時の利率が満期まで変わらないため、今後の金利上昇を見込むなら変動10年が合理的な選択になる。debt市場全体に投資する債券ファンドは、金利上昇局面では基準価額の下落が先行するが、その後の再投資利回りは改善していく。投資期間が長いなら、下落を過度に恐れる必要はない。',
  },
];

// ---- ユーザー(Cognitoユーザープール相当) -----------------------------------
const USERS = [
  { email: 'advertiser01@example.co.jp', password: 'demo1234', role: 'advertiser', advertiserId: 'ADV-0001', name: '広告主01(デモ)' },
  { email: 'advertiser02@example.co.jp', password: 'demo1234', role: 'advertiser', advertiserId: 'ADV-0002', name: '広告主02(デモ)' },
  { email: 'advertiser03@example.co.jp', password: 'demo1234', role: 'advertiser', advertiserId: 'ADV-0003', name: '広告主03(デモ)' },
  { email: 'admin@newfan.co.jp', password: 'admin1234', role: 'admin', advertiserId: null, name: '管理者(デモ)' },
];

// ---- 広告 -------------------------------------------------------------------
function seedAds() {
  const today = jstDate();
  const ads = [
    {
      adId: 'SEEDLOAN01', advertiserId: 'ADV-0001', advertiserEmail: 'advertiser01@example.co.jp',
      status: 'delivering',
      title: '住宅ローン借り換え無料診断',
      category: 'ローン・クレジット',
      adText: '現在の住宅ローンの返済額を無料で診断し、借り換えによる削減余地をご提示します。変動・固定の比較シミュレーション、諸費用込みの損益分岐点の試算に対応。金利タイプの見直しだけでなく、繰上げ返済や返済期間の調整もあわせてご提案します。オンラインで最短10分、営業の電話は行いません。',
      landingUrl: 'https://www.example.co.jp/loan-checkup',
      imageUrl: null,
      tags: ['住宅ローン', 'ファイナンシャルプランニング'],
      keywords: ['借り換え', '変動金利', '固定金利', '返済額'],
      target: { ageRange: [30, 55], region: '全国' },
      unitPriceCitation: 12, dailyBudget: 10000,
      campaignStart: jstDateOffset(-7), campaignEnd: jstDateOffset(45),
      links: [{ contentId: 'FIN-004', priority: '高' }, { contentId: 'FIN-003', priority: '中' }, { contentId: 'FIN-002', priority: '中' }],
      updatedDaysAgo: 2,
    },
    {
      adId: 'SEEDNISA01', advertiserId: 'ADV-0001', advertiserEmail: 'advertiser01@example.co.jp',
      status: 'reviewing',
      title: 'つみたてNISA口座開設サポート',
      category: '金融・投資',
      adText: 'これからの資産形成に、つみたてNISAの口座開設を無料でサポート。値動きがあっても元本保証だから安心、必ず増やせる積立プランをご提案します。手数料や商品の選び方も、専任スタッフがオンラインでわかりやすくご説明します。最短5分で申込完了。',
      landingUrl: 'https://www.example.co.jp/nisa',
      imageUrl: null,
      tags: ['資産形成'],
      keywords: ['NISA', '積立', '口座開設'],
      target: { ageRange: [25, 45], region: '全国', questionTypes: ['相談', 'アクション', '提案要求'] },
      unitPriceCitation: 10, dailyBudget: 5000,
      campaignStart: jstDateOffset(14), campaignEnd: jstDateOffset(78),
      links: [],
      updatedDaysAgo: 0.5,
    },
    {
      adId: 'SEEDCARD01', advertiserId: 'ADV-0002', advertiserEmail: 'advertiser02@example.co.jp',
      status: 'approved',
      title: 'クレジットカード比較ナビ',
      category: 'ローン・クレジット',
      adText: '年会費・ポイント還元率・付帯保険を一覧で比較できるクレジットカード比較サービスです。ライフスタイルに関する簡単な質問に答えるだけで、あなたの使い方に合ったカードを診断します。比較結果は保存でき、申込手続きもオンラインで完結します。',
      landingUrl: 'https://www.example.co.jp/card-navi',
      imageUrl: null,
      tags: ['キャッシュレス'],
      keywords: ['年会費無料', 'ポイント', 'クレジットカード'],
      target: null,
      unitPriceCitation: 8, dailyBudget: 3000,
      campaignStart: jstDateOffset(14), campaignEnd: jstDateOffset(74),
      links: [{ contentId: 'FIN-009', priority: '中' }],
      updatedDaysAgo: 3,
    },
    {
      adId: 'SEEDFXCP01', advertiserId: 'ADV-0002', advertiserEmail: 'advertiser02@example.co.jp',
      status: 'paused',
      title: '外貨預金 夏の金利キャンペーン',
      category: '金融・投資',
      adText: '対象通貨の外貨定期預金の金利を期間限定で優遇するキャンペーンを実施中です。米ドル・ユーロ・豪ドルの3通貨が対象で、インターネットバンキングからのお預け入れなら為替手数料も優遇されます。外貨預金の仕組みやリスクの説明ページもご用意しています。',
      landingUrl: 'https://www.example.co.jp/fx-campaign',
      imageUrl: null,
      tags: ['外貨'],
      keywords: ['外貨預金', '金利', 'ドル'],
      target: null,
      unitPriceCitation: 15, dailyBudget: 8000,
      campaignStart: jstDateOffset(-30), campaignEnd: jstDateOffset(30),
      links: [{ contentId: 'FIN-007', priority: '高' }, { contentId: 'FIN-012', priority: '低' }],
      updatedDaysAgo: 6,
    },
    {
      adId: 'SEEDPENS01', advertiserId: 'ADV-0001', advertiserEmail: 'advertiser01@example.co.jp',
      status: 'needs_fix',
      title: '個人年金保険の見直し相談',
      category: '保険',
      adText: '加入中の個人年金保険を無料で診断し、老後の不安がすべて解消する最適なプランをご提案します。公的年金の受給見込みと合わせた必要額の試算、保険料控除の活用方法まで、ファイナンシャルプランナーがオンラインでご相談を承ります。',
      landingUrl: 'https://www.example.co.jp/pension-review',
      imageUrl: null,
      tags: ['年金', '保険見直し'],
      keywords: ['個人年金', '保険料控除', '老後資金'],
      target: { ageRange: [40, 65], region: '全国' },
      unitPriceCitation: 10, dailyBudget: 5000,
      campaignStart: jstDateOffset(7), campaignEnd: jstDateOffset(67),
      reviewNote: '「老後の不安がすべて解消する」は効果を保証する誇大表現と受け取られるおそれがあります(景品表示法・優良誤認)。具体的なサービス内容に基づく表現へ修正のうえ、再出稿してください。',
      links: [],
      updatedDaysAgo: 7,
    },
    {
      adId: 'SEEDFIXD01', advertiserId: 'ADV-0002', advertiserEmail: 'advertiser02@example.co.jp',
      status: 'delivering',
      title: '固定金利プラン比較ナビ',
      category: 'ローン・クレジット',
      adText: '金利上昇局面では固定型への借り換え比較が有効です。主要銀行の固定金利プランを一括で試算し、事務手数料や保証料などの諸費用を含む総返済額で比較できます。現在の返済予定表をアップロードするだけで、切り替え効果のレポートを無料で作成します。',
      landingUrl: 'https://www.example.co.jp/fixed-rate-navi',
      imageUrl: 'https://cdn.example.com/fixed-rate-navi.jpg',
      tags: ['住宅ローン'],
      keywords: ['固定金利', '借り換え', '金利上昇', '住宅ローン'],
      target: null,
      unitPriceCitation: 10, dailyBudget: 8000,
      campaignStart: jstDateOffset(-14), campaignEnd: jstDateOffset(30),
      links: [{ contentId: 'FIN-004', priority: '中' }],
      updatedDaysAgo: 4,
    },
    {
      adId: 'SEEDHOME01', advertiserId: 'ADV-0003', advertiserEmail: 'advertiser03@example.co.jp',
      status: 'delivering',
      title: '家計まるごと金利チェック',
      category: '金融・投資',
      adText: '住宅ローンだけでなく、保険・クレジットカード・リボ払いを含む家計全体の金利負担をまとめて見直せる無料サービスです。毎月の支払いを登録すると、金利コストの内訳と削減余地を見える化し、優先して見直すべき項目をレポートでお届けします。',
      landingUrl: 'https://www.example.co.jp/kakei-kinri-check',
      imageUrl: null,
      tags: ['家計改善', '金利'],
      keywords: ['家計', '金利', '住宅ローン', '返済', '金利上昇', '固定費'],
      target: null,
      unitPriceCitation: 8, dailyBudget: 6000,
      campaignStart: jstDateOffset(-3), campaignEnd: jstDateOffset(60),
      links: [{ contentId: 'FIN-010', priority: '高' }],
      updatedDaysAgo: 1,
    },
    {
      adId: 'SEEDDRFT01', advertiserId: 'ADV-0001', advertiserEmail: 'advertiser01@example.co.jp',
      status: 'draft',
      title: '住み替え・住宅購入の資金計画ガイド',
      category: '不動産',
      adText: null,
      landingUrl: null,
      imageUrl: null,
      tags: [],
      keywords: ['住み替え', '頭金'],
      target: null,
      unitPriceCitation: 10, dailyBudget: null,
      campaignStart: null, campaignEnd: null,
      links: [],
      updatedDaysAgo: 9,
    },
  ];

  for (const def of ads) {
    const { links, updatedDaysAgo, reviewNote, ...attrs } = def;
    const updatedAt = new Date(Date.now() - updatedDaysAgo * 86400000).toISOString();
    const ad = {
      PK: `AD#${def.adId}`, SK: 'META',
      GSI1PK: `STATUS#${def.status}`, GSI1SK: `UPDATED#${updatedAt}`,
      ...attrs,
      billingModel: 'citation',
      findings: screenAd(attrs),
      reviewNote: reviewNote ?? null,
      submittedAt: def.status === 'draft' ? null : updatedAt,
      createdAt: new Date(Date.now() - (updatedDaysAgo + 3) * 86400000).toISOString(),
      updatedAt,
    };
    tables.ads.put(ad);
    syncVector(ad);
    for (const link of links) {
      const c = tables.contents.get(`CONTENT#${link.contentId}`, 'META');
      tables.ads.put({
        PK: ad.PK, SK: `LINK#${link.contentId}`,
        GSI2PK: `CONTENT#${link.contentId}`, GSI2SK: `AD#${def.adId}`,
        adId: def.adId, contentId: link.contentId,
        relevanceScore: round4(similarity(embed(adEmbeddingText(ad)), embed(contentEmbeddingText(c)))),
        priority: link.priority,
        createdAt: updatedAt,
      });
    }
    // シード広告が設計書のバリデーション規則(6.3.1)を満たすことを保証(下書きを除く)
    if (def.status !== 'draft') {
      const errors = validateAd(ad, { draft: false });
      const fatal = errors.filter((e) => !e.reason.startsWith('キャンペーン期間：終了日は本日以降'));
      if (fatal.length) {
        throw new Error(`シード広告 ${def.adId} がバリデーション違反: ${JSON.stringify(fatal)}`);
      }
    }
  }
}

/** 過去7日分の日次統計(デモ用の履歴。finalized=true) */
function seedStats() {
  const series = {
    SEEDLOAN01: { citations: [96, 104, 121, 114, 109, 117, 111], impRate: 28, ctr: 0.027, unit: 12, chars: 38 },
    SEEDFIXD01: { citations: [61, 66, 72, 69, 74, 70, 68], impRate: 25, ctr: 0.022, unit: 10, chars: 36 },
    SEEDHOME01: { citations: [22, 25, 28, 24, 27, 26, 25], impRate: 22, ctr: 0.019, unit: 8, chars: 35 },
    SEEDFXCP01: { citations: [40, 38, 0, 0, 0, 0, 0], impRate: 24, ctr: 0.02, unit: 15, chars: 37 },
  };
  for (const [adId, s] of Object.entries(series)) {
    for (let i = 0; i < 7; i++) {
      const date = jstDateOffset(i - 7); // 7日前〜昨日
      const citations = s.citations[i];
      if (citations === 0) continue;
      const impressions = Math.round(citations * s.impRate);
      const clicks = Math.round(impressions * s.ctr);
      tables.stats.update(`AD#${adId}`, `DATE#${date}`, {
        set: {
          adId, date,
          citations, cost: citations * s.unit, citationChars: citations * s.chars,
          impressions, clicks,
          finalized: true, updatedAt: nowIso(),
        },
      });
    }
  }
}

export function seedAll() {
  resetAll();
  const now = nowIso();
  for (const c of CONTENTS) {
    tables.contents.put({
      PK: `CONTENT#${c.contentId}`, SK: 'META',
      ...c,
      publishedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
      updatedAt: now,
    });
  }
  for (const u of USERS) createUser(u);
  seedAds();
  seedStats();
  saveNow();
  return { contents: CONTENTS.length, users: USERS.length };
}

// CLI: node server/seed.js --reset
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const result = seedAll();
  console.log(`シード完了: 記事${result.contents}件・ユーザー${result.users}名・広告8件`);
}
