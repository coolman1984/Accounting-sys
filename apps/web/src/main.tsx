import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
