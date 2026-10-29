// Gemini generateContent 스트리밍(Q10/Q22). POST /v1beta/models/{m}:streamGenerateContent?alt=sse, 헤더 x-goog-api-key.
// effort 경로: generation_config.thinking_level 은 Interactions API 의 필드다. 이 엔드포인트(GenerateContentRequest)에서는
// generationConfig.thinkingConfig.thinkingLevel 이므로 그 경로로 보낸다(snake_case 도 받는 proto JSON — system_instruction 과 같은 표기).
import type { Provider } from '@remath/shared/engine';
import { httpError, listModels, stream, streamError, type AdapterOpts, type Done } from './call.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta';

const STOP: Record<string, Done['stopReason']> = { STOP: 'end', MAX_TOKENS: 'length' };

interface Chunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string; error?: { code?: number; message?: string; status?: string };
}

export function geminiProvider(key: string, o: AdapterOpts): Provider {
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
  return {
    id: 'gemini',
    complete: req => stream('gemini', o, req, {
      url: `${API}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, headers,
      body: {
        system_instruction: { parts: [{ text: req.system }] },
        contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        ...req.effort && { generation_config: { thinking_config: { thinking_level: req.effort } } },
      },
    }, ev => {
      const d = JSON.parse(ev.data) as Chunk;
      if (d.error) throw typeof d.error.code === 'number' ? httpError('gemini', d.error.code, `stream error: ${d.error.message}`) : streamError('gemini', d.error.message, d.error.status);
      const c = d.candidates?.[0], text = c?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';
      if (!c?.finishReason) return text;
      // 마지막 청크는 텍스트와 finishReason·usageMetadata 를 함께 싣는다.
      const u = d.usageMetadata;
      return [text, { type: 'done', model: d.modelVersion ?? req.model, stopReason: STOP[c.finishReason] ?? 'other', ...u && { usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } } }];
    }),
    listModels: () => listModels('gemini', o, { url: `${API}/models`, headers }, (j: { models?: { name: string }[] }) => (j.models ?? []).map(m => m.name.replace(/^models\//, ''))),
  };
}
