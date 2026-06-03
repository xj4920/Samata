import { randomUUID } from 'node:crypto';

export interface ImageDescriber {
  name: string;
  describeImage(imageDataUrl: string, prompt: string): Promise<string>;
}

function getApiKey(): string {
  return process.env.BIGMODEL_API_KEY || process.env.CUSTOM_API_KEY || '';
}

function getBaseUrl(): string {
  return (process.env.BIGMODEL_OCR_BASE_URL || process.env.CUSTOM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4')
    .replace(/\/+$/, '');
}

function normalizeText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join('\n\n').trim();
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return normalizeText(obj.content ?? obj.text ?? obj.markdown ?? obj.md ?? obj.result);
  }
  return '';
}

export function extractBigModelOcrText(data: unknown): string {
  const root = data as any;
  return normalizeText(root?.md_results)
    || normalizeText(root?.data?.md_results)
    || normalizeText(root?.result?.md_results)
    || normalizeText(root?.choices?.map((choice: any) => choice?.message?.content ?? choice?.text))
    || normalizeText(root?.data?.content)
    || normalizeText(root?.content)
    || '';
}

export function hasBigModelOcrDescriber(): boolean {
  return !!getApiKey() && process.env.BIGMODEL_OCR_ENABLED !== 'false';
}

export function getBigModelOcrDescriber(): ImageDescriber | undefined {
  const apiKey = getApiKey();
  if (!apiKey || process.env.BIGMODEL_OCR_ENABLED === 'false') return undefined;

  const baseUrl = getBaseUrl();
  const model = process.env.BIGMODEL_OCR_MODEL || 'glm-ocr';

  return {
    name: 'bigmodel-ocr',
    async describeImage(imageDataUrl: string): Promise<string> {
      const match = imageDataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (!match) throw new Error('BigModel OCR: 无效的 imageDataUrl 格式');

      const res = await fetch(`${baseUrl}/layout_parsing`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          file: imageDataUrl,
          request_id: `samata-${randomUUID()}`,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`BigModel OCR ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      if (data?.error) throw new Error(`BigModel OCR error: ${JSON.stringify(data.error)}`);

      const text = extractBigModelOcrText(data);
      if (!text) throw new Error('BigModel OCR 返回为空');
      return text;
    },
  };
}
