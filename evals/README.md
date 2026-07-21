# Samata 场景回归评测数据集

这里保存经过脱敏和人工审核的场景 case、工具 fixture、评分 rubric 与正式
baseline。生产日志只用于生成候选，不直接进入 Git。

## 状态

- `draft`：候选骨架，尚未进入门禁。
- `approved`：已补齐 fixture、断言、评分标准和审核信息，可进入正式回归。
- `quarantined`：存在已知不稳定性，保留但不作为门禁。
- `deprecated`：历史 case，仅用于追溯。

正式 baseline 只能在干净工作区生成。历史回答仅用于人工参考，测试判定以
`assertions` 和 `judge` 为准。
