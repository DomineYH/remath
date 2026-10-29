// Anthropic Messages API(Q10). POST /v1/messages stream, system 최상위, output_config.effort.
import type { Provider } from '@remath/shared/engine';
import { listModels, stream, streamError, type AdapterOpts, type Done } from './call.ts';

const API = 'https://api.anthropic.com/v1';
/** 현재 최신 버전(platform.claude.com/docs/en/api/versioning). temperature·top_p·top_k 를 보내면 400 — 보내지 않는다. */
const VERSION = '2026-10-21';

const STOP: Record<string, Done['stopReason']> = { end_turn: 'end', stop_sequence: 'end', max_tokens: 'length' };

export function anthropicProvider(key: string, o: AdapterOpts): Provider {
  const headers = { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' };
  // CompleteRequest 에 출력 상한이 없어 역할로 정한다: 분석은 JSON 판정·리포트라 더 길다.
  const maxTokens = o.role === 'analysis' ? 2048 : 1024;
  return {
    id: 'anthropic',
    complete: req => {
      // message_start 의 model·입력 토큰과 message_delta 의 stop_reason·출력 토큰을 모아 message_stop 에서 낸다.
      let model = req.model, input = 0, output = 0, stop: Done['stopReason'] = 'other';
      return stream('anthropic', o, req, {
        url: `${API}/messages`, headers, key,
        body: { model: req.model, max_tokens: maxTokens, system: req.system, messages: req.messages, stream: true, ...req.effort && { output_config: { effort: req.effort } } },
      }, ev => {
        const d = JSON.parse(ev.data);
        switch (d.type) {
          case 'message_start': model = d.message.model ?? model; input = d.message.usage?.input_tokens ?? 0; output = d.message.usage?.output_tokens ?? 0; return;
          case 'content_block_delta': return d.delta?.type === 'text_delta' ? d.delta.text as string : undefined;   // thinking_delta 등은 버린다
          case 'message_delta': stop = STOP[d.delta?.stop_reason] ?? 'other'; output = d.usage?.output_tokens ?? output; input = d.usage?.input_tokens ?? input; return;
          case 'message_stop': return { type: 'done', model, stopReason: stop, usage: { input, output } };
          case 'error': throw streamError('anthropic', d.error?.message, d.error?.type);
        }
      });
    },
    listModels: () => listModels('anthropic', o, { url: `${API}/models`, headers, key }, (j: { data: { id: string }[] }) => j.data.map(m => m.id)),
  };
}
