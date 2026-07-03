import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import App from './App';
import './index.css';

// No StrictMode: Cesium.Viewer holds a real WebGL context + skybox textures; StrictMode's dev-only
// mount→unmount→remount double-invoke isn't worth the churn against a real GL context here.
createRoot(document.getElementById('root')!).render(
  <NuqsAdapter>
    <App />
  </NuqsAdapter>,
);
