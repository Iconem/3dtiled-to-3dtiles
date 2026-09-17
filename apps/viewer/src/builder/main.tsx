import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import BuilderApp from './BuilderApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BuilderApp />
  </StrictMode>,
);
