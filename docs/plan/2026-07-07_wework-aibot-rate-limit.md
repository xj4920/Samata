# 企微 AI Bot 主动推送限流修复

## 背景

公司 Code issue I7H0 / #32 记录了 hedge-ratio 后台推送触发企微 AI Bot 限流的问题。线上日志显示企微 WebSocket ACK 返回 `errcode=846607`、`errmsg=aibot send msg frequency limit exceeded`，业务侧只打印 `推送/标记失败: undefined`，不利于判断失败原因。

主仓中 `src/services/deliver.ts` 与 `src/plugins/registry.ts` 的企微主动通知路径此前直接调用 `ws.sendMessage(...)`，多个业务模块或插件连续推送时缺少统一排队、主动限速和限流退避。

## 决策

- 在主仓新增企微主动通知队列，统一承接 `deliverWework` 和插件 `sendNotification('wework...')`。
- 队列按 bot 维度串行，默认发送最小间隔为 `WEWORK_SEND_MIN_INTERVAL_MS=2000`，环境变量可覆盖但最低钳制为 `800ms`。
- 对企微 `846607` 或 `frequency limit exceeded` 执行 `5s / 15s / 30s` 退避重试；重试耗尽后抛出带 `errcode / errmsg / hint / reqId / botIdOrName / targetId` 的结构化错误。
- hedge-ratio 插件侧同轮多条未处理记录合并/分片发送，发送成功后再标记 processed；发送失败不标记成功。

## 改动清单

- 新增 `src/wework/notification-queue.ts`，实现按 bot FIFO 队列、最小发送间隔、846607 退避重试和结构化错误。
- 更新 `src/services/deliver.ts` 与 `src/plugins/registry.ts`，企微主动推送改走统一队列。
- 补充 `tests/unit/services/deliver.test.ts` 和 `tests/unit/plugins/registry-delivery.test.ts`，覆盖串行发送、不同 bot 独立队列、846607 重试/失败，以及插件指定 bot 通知。
- 递增根包版本：`3.0.22 -> 3.0.23`，并同步 `package-lock.json` 根包版本。

## 验证命令

```bash
npm run test:unit -- tests/unit/services/deliver.test.ts tests/unit/plugins/registry-delivery.test.ts
```

## Commit

- implementation commit hash：5fefb44
