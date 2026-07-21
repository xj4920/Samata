# 场景分类器 v1

根据已经脱敏的用户问题、工具类别和执行摘要，从给定 taxonomy 中选择一个主场景，
并返回适用的横向标签。不得补充输入中不存在的业务事实。

输出 JSON：

```json
{"scenario":"<taxonomy id>","tags":["<tag>"],"reason":"<简短理由>"}
```
