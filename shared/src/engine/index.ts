// 턴 엔진 진입점(`@remath/shared/engine`, E-24~E-28). 서버(2·3단계)와 1단계 목 API가 같은 코드를 import 한다. fs·process 없음.
// API 스키마(`@remath/shared`)와 이름이 겹치는 타입(Provider·Lang·Translation…)이 있어 별도 진입점으로 둔다.
export * from './adapter.ts';
export * from './classification.ts';
export * from './engine.ts';
export * from './pipeline.ts';
export { mockProvider, mockText, TXT } from './mock/provider.ts';
