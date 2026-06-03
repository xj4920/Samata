# Fix Google CAPTCHA Issue for Web Search

## Problem

- `config/agents/otcclaw.md` line 76 instructs the LLM: "优先使用 Google（google.com）搜索"
- Google reliably serves CAPTCHAs to server IPs, wasting a tool call round-trip
- The native `web_search` tool (Sogou + Bing fallback) is defined in `src/tools/web-tools.ts` but NOT exposed to any agent — missing from `COMMON_SET`

## Solution (5 steps)

### 1. Integrate Serper.dev as primary search engine

In `src/tools/web-tools.ts`, add a `searchSerper()` function as the first-priority engine, with Sogou+Bing as fallback when Serper fails or key is missing:

```typescript
async function searchSerper(query: string, count: number, axios: any): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  const resp = await axios.request({
    method: 'POST',
    url: 'https://google.serper.dev/search',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    data: JSON.stringify({ q: query, num: count }),
    timeout: 10000,
    validateStatus: () => true,
  });
  if (resp.status !== 200) return [];
  const data = resp.data;
  return (data.organic || []).map((item: any) => ({
    title: item.title || '',
    url: item.link || '',
    snippet: item.snippet || '',
  }));
}
```

Update `handleWebSearch` fallback chain: **Serper -> Sogou -> Bing**

### 2. Add env variable

In `.env`:
```
SERPER_API_KEY=<key>
```

In `.env.example`:
```
# SERPER_API_KEY=your_serper_api_key
```

### 3. Add `web_search` to COMMON_SET

In `src/llm/agents/config.ts` line 36:

```typescript
// Web
'web_search', 'web_fetch',
```

### 4. Block Google domains in browser guard

In `src/services/mcp-manager.ts` `guardDevtoolsNavigation` (after `isSuspiciousGeneratedUrl` check):

```typescript
if (/^https?:\/\/(www\.)?google\.[a-z.]+\//i.test(url)) {
  return mcpError('Google 搜索在服务器 IP 上会触发验证码，已拒绝。请改用 web_search 工具或通过浏览器打开 bing.com', { url });
}
```

### 5. Update otcclaw prompt

In `config/agents/otcclaw.md` line 73-79:

- Remove "优先使用 Google" instruction
- Add: 需要搜索公开信息时优先使用 `web_search` 工具
- 浏览器仅在需要浏览特定页面时使用，不要用浏览器做搜索
