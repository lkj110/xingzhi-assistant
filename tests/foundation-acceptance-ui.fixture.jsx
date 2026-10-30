import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../src/App.jsx';
import '../src/styles.css';

// This bridge is supplied by the offline harness before the actual App mounts.
window.assistant = {desktop: true, call: window.offlineAcceptanceCall};
createRoot(document.getElementById('root')).render(<App/>);
