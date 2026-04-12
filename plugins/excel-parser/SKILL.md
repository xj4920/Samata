---
name: Excel 数据分析
description: 解析 Excel/CSV 文件并进行数据分析
---

## 何时使用
- 用户上传或提到 Excel/CSV 文件需要分析时
- 需要从表格文件中提取特定数据时
- 用户要求对电子表格进行汇总、筛选、对比

## 使用步骤
1. 先用 list_excel_sheets 查看文件结构（有哪些 sheet、各多少行列）
2. 用 parse_excel 读取目标 sheet 的数据
3. 根据返回的 headers 和 data 进行分析
4. 将分析结果格式化输出（表格、图表描述等）

## 注意事项
- 大文件请设置 max_rows 参数，避免 context 溢出
- 支持 .xlsx, .xls, .csv 格式
- 文件路径支持 ~/ 开头的 home 相对路径
