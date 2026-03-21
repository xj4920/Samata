import { initSchema } from '../src/db/schema.js';
import { saveSkill } from '../src/commands/skill.js';
import { setCurrentUser } from '../src/auth/rbac.js';
import { closeDb } from '../src/db/connection.js';

async function main() {
  initSchema();
  // 设置为系统管理员权限以更新全局 Skill
  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  const name = '按管理人查看交易日报';
  const prompt = '请获取 {date} 的交易日报汇总。请务必调用 trade_summary 工具（传入参数 date={date}），该工具会在后端完成所有数值累加和按名义本金排序。获取结果后，请直接以表格形式展示，不要尝试自己重新计算数值。';

  const result = saveSkill(name, prompt);
  if (result.success) {
    console.log(`✅ Skill "${name}" 已成功更新，现在它会强制使用 trade_summary 工具。`);
  } else {
    console.error(`❌ 更新失败: ${result.error}`);
  }

  closeDb();
}

main();
