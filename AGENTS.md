# Samata Agent Instructions

## 提交版本号规则

- 每次提交代码前，必须递增根目录 `package.json` 的 `version`。
- 若 `package-lock.json` 存在，必须同步更新锁文件中的根包版本信息。
- 版本递增应与改动性质匹配；未特别说明时，默认递增 patch 版本。
