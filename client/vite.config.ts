import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// es2022: top-level await in src/api/index.ts (the mock import boundary, A-4).
// Dev: /api goes to the server workspace (npm run dev -w server, PORT 3000), A-5.
export default defineConfig({ plugins: [react()], build: { target: 'es2022' }, server: { proxy: { '/api': 'http://localhost:3000' } } });
