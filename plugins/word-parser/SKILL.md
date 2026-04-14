---
name: Word 文档解析
description: 解析 Word (.docx) 文件，提取文本或 Markdown 内容
---

## 何时使用
- 用户上传或提到 Word 文档需要提取内容时
- 用户要求分析、总结 Word 文档

## 使用步骤
1. 用 parse_word 解析文件，提取文本或 markdown
2. 根据提取的内容进行分析、总结

## 注意事项
- 仅支持 .docx 格式（不支持旧版 .doc）
- 超长文档会自动截断，默认上限 50000 字符
- 文件路径支持 ~/ 开头的 home 相对路径
- format 参数可选 "text"（纯文本）或 "markdown"（保留标题/列表等结构）
