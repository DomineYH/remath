// OpenAI Responses API(Q10). POST /v1/responses stream, instructions = system, reasoning.effort.
import type { Provider } from '@remath/shared/engine';
import { listModels, stream, streamError, type AdapterOpts, type Done } from './call.ts';

const API = 'https://api.openai.com/v1';

interface OaResponse { model: string; status: string; incomplete_details?: { reason?: string } | null; usage?: { input_tokens: number; output_tokens: number }; error?: { message?: string } | null }

const done = (r: OaResponse): Done => ({
  type: 'done', model: r.model,
  stopReason: r.status === 'completed' ? 'end' : r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'other',
  ...r.usage && { usage: { input: r.usage.input_tokens, output: r.usage.output_tokens } },
});

export function openaiProvider(key: string, o: AdapterOpts): Provider {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    id: 'openai',
    complete: req => stream('openai', o, req, {
      url: `${API}/responses`, headers,
      body: { model: req.model, instructions: req.system, input: req.messages, stream: true, ...req.effort && { reasoning: { effort: req.effort } } },
    }, ev => {
      const d = JSON.parse(ev.data);
      switch (d.type) {
        case 'response.output_text.delta': return d.delta as string;
        case 'response.completed': case 'response.incomplete': return done(d.response);
        case 'response.failed': throw streamError('openai', d.response?.error?.message, d.response?.error?.code);
        case 'error': throw streamError('openai', d.message, d.code);
      }
    }),
    listModels: () => listModels('openai', o, { url: `${API}/models`, headers }, (j: { data: { id: string }[] }) => j.data.map(m => m.id)),
  };
}
