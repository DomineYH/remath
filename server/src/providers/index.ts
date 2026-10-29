// 실 어댑터 진입점(#56). 앱·턴 배선은 #57.
import { anthropicProvider } from './anthropic.ts';
import { geminiProvider } from './gemini.ts';
import { openaiProvider } from './openai.ts';
import type { ProvidersFor } from './types.ts';

const MAKE = { openai: openaiProvider, anthropic: anthropicProvider, gemini: geminiProvider };

export const providersFor: ProvidersFor = (provider, key, opts) => MAKE[provider](key, opts);
