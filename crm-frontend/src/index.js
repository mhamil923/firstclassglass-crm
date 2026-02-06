// File: src/index.js

import React from 'react';
import ReactDOM from 'react-dom/client';

// 1️⃣ Load Bootstrap FIRST so we can override it:
import 'bootstrap/dist/css/bootstrap.min.css';

// 2️⃣ Load Apple Design System variables:
import './styles/AppleDesignSystem.css';

// 3️⃣ Load global styles (overrides Bootstrap):
import './index.css';

// 4️⃣ Load App styles:
import './App.css';

import App from './App';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
