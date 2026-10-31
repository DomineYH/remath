// `?raw` = 파일 텍스트(Vite·raw-hooks.ts·build-vercel.mjs 의 raw 플러그인이 같은 뜻으로 읽는다). `*.md?raw` 는 prompts/src/raw.d.ts.
declare module '*.json?raw' { const text: string; export default text; }
