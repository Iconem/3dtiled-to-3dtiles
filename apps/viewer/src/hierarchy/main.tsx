import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import HierarchyExplorer from './HierarchyExplorer';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HierarchyExplorer />
  </StrictMode>,
);
