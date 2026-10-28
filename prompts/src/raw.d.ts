// Vite `?raw` import (the client tsconfig gets this from vite/client).
declare module '*.md?raw' { const text: string; export default text; }
