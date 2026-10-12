import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadFonts } from './engine/text';
import { applyTheme, initialTheme } from './theme';
import './styles.css';

applyTheme(initialTheme());
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
await loadFonts();
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
