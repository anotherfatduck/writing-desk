import React from 'react';
import ReactDOM from 'react-dom/client';

import { RightRailProvider } from './right-rail/RightRailContext';
import App from './App';

import { initAppearance } from './themes/appearance-store';
import './themes/vendored-fonts.css';
import './themes/colors-base.css';
import './themes/colors-extra.css';
import './themes/typefaces.css';
import './themes/canvas-styles.css';
import './themes/spacing-presets.css';
import './App.css';

// RightRailProvider is hoisted above <App> (not nested inside App's return) so
// App itself can read rail open/width + push the responsive overlay flag down
// into the rail. Every rail consumer still sits under this single provider.
initAppearance();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RightRailProvider>
      <App />
    </RightRailProvider>
  </React.StrictMode>,
);
