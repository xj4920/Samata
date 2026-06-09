import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTool } from '../../../src/tools/web-tools.js';

const axiosMock = vi.hoisted(() => ({
  defaultRequest: vi.fn(),
  directRequest: vi.fn(),
  create: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    request: axiosMock.defaultRequest,
    create: axiosMock.create,
  },
}));

describe('web_search fallback', () => {
  beforeEach(() => {
    process.env.SERPER_API_KEY = 'test-serper-key';
    axiosMock.defaultRequest.mockReset();
    axiosMock.directRequest.mockReset();
    axiosMock.create.mockReset();
    axiosMock.create.mockReturnValue({ request: axiosMock.directRequest });
  });

  afterEach(() => {
    delete process.env.SERPER_API_KEY;
  });

  it('falls back to Sogou without proxy when Serper times out', async () => {
    axiosMock.defaultRequest.mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    axiosMock.directRequest.mockResolvedValueOnce({
      status: 200,
      data: `
        <div class="vrwrap">
          <h3><a href="https://example.com/weather">广州天气</a></h3>
          <p class="space-txt">今天大雨，气温 25 到 32 度。</p>
        </div>
        <div id="pagebar"></div>
      `,
    });

    const raw = await handleTool('web_search', { query: '广州天气', count: 3 });
    const result = JSON.parse(raw!);

    expect(result.engine).toBe('sogou');
    expect(result.results[0]).toMatchObject({
      title: '广州天气',
      url: 'https://example.com/weather',
      snippet: '今天大雨，气温 25 到 32 度。',
    });
    expect(axiosMock.create).toHaveBeenCalledWith({ proxy: false });
    expect(axiosMock.directRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.sogou.com/web?query=%E5%B9%BF%E5%B7%9E%E5%A4%A9%E6%B0%94',
      proxy: false,
    }));
  });

  it('continues to Bing without proxy when Sogou returns no parsed results', async () => {
    axiosMock.defaultRequest.mockResolvedValue({ status: 503, data: {} });
    axiosMock.directRequest
      .mockResolvedValueOnce({ status: 200, data: '<html>captcha</html>' })
      .mockResolvedValueOnce({
        status: 200,
        data: `
          <li class="b_algo">
            <h2><a href="https://bing.example/weather">Bing 广州天气</a></h2>
            <div class="b_caption"><p>广州今日天气预报。</p></div>
          </li>
        `,
      });

    const raw = await handleTool('web_search', { query: '广州天气', count: 3 });
    const result = JSON.parse(raw!);

    expect(result.engine).toBe('bing');
    expect(result.results[0]).toMatchObject({
      title: 'Bing 广州天气',
      url: 'https://bing.example/weather',
      snippet: '广州今日天气预报。',
    });
    expect(axiosMock.directRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: 'https://cn.bing.com/search?q=%E5%B9%BF%E5%B7%9E%E5%A4%A9%E6%B0%94&ensearch=0',
      proxy: false,
    }));
  });
});
