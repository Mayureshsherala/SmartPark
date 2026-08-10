import React from 'react'; import { createRoot } from 'react-dom/client'; import './styles.css'; import './spec-alignment.css'; import App from './App.jsx';
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
if ('serviceWorker' in navigator) window.addEventListener('load', async () => { if (import.meta.env.PROD) await navigator.serviceWorker.register('/sw.js').catch(() => {}); else (await navigator.serviceWorker.getRegistrations()).forEach((registration) => registration.unregister()); });
