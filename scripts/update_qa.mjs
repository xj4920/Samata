import Database from 'better-sqlite3';

const db = new Database('data/samata.db');

const oldQuestion = '客户专线接入的费用标准是多少？';
const newQuestion = '上海同城4M带宽的客户专线接入费用标准是多少？';
const newAnswer = '上海同城4M带宽的客户专线接入费用包括：首次安装费1000元，月租费1980元/月，年度总费用约24760元（含安装费）。专线可用于北向极速交易等业务场景。场内业务是否可复用同一根专线需经技术评估和合规确认。不同带���规格、线路距离、运营商选择会影响具体费用，以上为上海同城4M带宽的参考标准。';

const row = db.prepare('SELECT * FROM knowledge WHERE question = ?').get(oldQuestion);
if (!row) {
  console.log('❌ 未找到目标QA');
  process.exit(1);
}

console.log(`找到QA，ID: ${row.id}`);
console.log(`原问题: ${row.question}`);
console.log(`原答案: ${row.answer}`);
console.log('---');

db.prepare(
  "UPDATE knowledge SET question = ?, answer = ?, updated_at = datetime('now') WHERE id = ?"
).run(newQuestion, newAnswer, row.id);

console.log(`✅ 已更新`);
console.log(`新问题: ${newQuestion}`);
console.log(`新答案: ${newAnswer}`);

db.close();
