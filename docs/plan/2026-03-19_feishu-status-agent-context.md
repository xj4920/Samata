# Plan: Fix /status skill count inconsistency between Feishu and CLI

## Context

`/status` shows different skill counts depending on the channel (Feishu vs CLI). For `alter-ego` agent, Feishu shows 1 skill while CLI shows 3.

Root cause: `fetchSystemStatus()` relies on `getCurrentAgent()` to scope the skill/knowledge counts. But in the Feishu bot, `setCurrentAgent()` is **never called** before `handleCommand()` is invoked. So `getCurrentAgent()` returns the wrong agent (or undefined), causing unscoped queries.

## Fix

In `src/feishu/bot.ts`, wrap the `handleCommand` call with user + agent context setup/restore, mirroring what `handleAIChat` does for `setCurrentUser`.

## Implementation Steps

1. Write plan doc (this file)
2. Add `setCurrentAgent` / `getCurrentAgent` imports to `src/feishu/bot.ts`
3. Wrap the `handleCommand` call in the message handler with user + agent context setup/restore
