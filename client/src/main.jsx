import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.jsx';
import OrdersPage from './pages/OrdersPage.jsx';
import CompanyPage from './pages/CompanyPage.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<OrdersPage />} />
          <Route path="company/:symbol" element={<CompanyPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
