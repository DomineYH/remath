import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyStoredTheme } from './theme.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

applyStoredTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
