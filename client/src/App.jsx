import { Link, Outlet, useLocation } from 'react-router-dom';

export default function App() {
  const { pathname } = useLocation();
  const onOrders = pathname === '/';

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">▣</span>
          <span className="brand-name">CompanyData</span>
        </Link>
        <nav className="topnav">
          <Link to="/" className={onOrders ? 'active' : ''}>
            Order Tracking
          </Link>
          <a
            href="https://www.screener.in"
            target="_blank"
            rel="noreferrer"
          >
            Powered by Screener
          </a>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
