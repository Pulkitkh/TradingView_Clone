import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchOrders, fetchFacets } from '../api/client.js';

const fmtCr = (v) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })} Cr`;

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

function orderSizeClass(pct) {
  if (pct == null) return 'pill pill-grey';
  if (pct >= 20) return 'pill pill-green-strong';
  if (pct >= 5) return 'pill pill-green';
  return 'pill pill-amber';
}

function contractValueClass(v) {
  if (v >= 250) return 'val-green';
  if (v >= 50) return 'val-blue';
  return '';
}

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  const [facets, setFacets] = useState({ companies: [], customers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [company, setCompany] = useState('');
  const [customer, setCustomer] = useState('');
  const [minOrderSize, setMinOrderSize] = useState('');

  async function load(filters = {}) {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrders(filters);
      setOrders(data.orders);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchFacets().then(setFacets).catch(() => {});
    load();
  }, []);

  const applyFilters = () =>
    load({ company, customer, minOrderSize });

  const refresh = () => {
    setCompany('');
    setCustomer('');
    setMinOrderSize('');
    load();
  };

  const totalValue = useMemo(
    () => orders.reduce((sum, o) => sum + (o.contractValueCr || 0), 0),
    [orders]
  );

  return (
    <div className="orders-page">
      <div className="warning-banner">
        <span className="warn-icon">⚠</span>
        <span>
          <strong>Important:</strong> Order details are extracted using AI and may
          contain errors. Please verify the information by checking the PDF
          documents before making any business decisions.
        </span>
      </div>

      <div className="page-head">
        <h1>All Orders</h1>
        <div className="page-summary">
          {orders.length} orders &middot; {fmtCr(totalValue)} total contract value
        </div>
      </div>

      <div className="filter-bar">
        <select
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="filter-field"
        >
          <option value="">Company</option>
          {facets.companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          className="filter-field"
        >
          <option value="">Customer</option>
          {facets.customers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <input
          type="number"
          placeholder="Min Order Size %"
          value={minOrderSize}
          onChange={(e) => setMinOrderSize(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
          className="filter-field"
        />

        <button className="btn-refresh" onClick={applyFilters}>
          Apply
        </button>
        <button className="btn-refresh ghost" onClick={refresh}>
          ⟳ Refresh
        </button>
      </div>

      <div className="table-wrap">
        <table className="orders-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Customer</th>
              <th>Order Type</th>
              <th>Date ↓</th>
              <th>Contract Value</th>
              <th>Duration</th>
              <th>Annual Value</th>
              <th>Order Size %</th>
              <th>Company Revenue</th>
              <th>PDF</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="table-msg">
                  Loading orders…
                </td>
              </tr>
            )}
            {error && !loading && (
              <tr>
                <td colSpan={10} className="table-msg error">
                  {error}
                </td>
              </tr>
            )}
            {!loading && !error && orders.length === 0 && (
              <tr>
                <td colSpan={10} className="table-msg">
                  No orders match the current filters.
                </td>
              </tr>
            )}
            {!loading &&
              orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="company-link" to={`/company/${o.symbol}`}>
                      {o.company}
                    </Link>
                  </td>
                  <td className={o.customer === 'Not mentioned' ? 'muted' : ''}>
                    {o.customer}
                  </td>
                  <td className={o.orderType === 'Not mentioned' ? 'muted' : ''}>
                    {o.orderType}
                  </td>
                  <td>{fmtDate(o.date)}</td>
                  <td className={contractValueClass(o.contractValueCr)}>
                    {fmtCr(o.contractValueCr)}
                  </td>
                  <td className={o.duration === 'Not mentioned' ? 'muted' : ''}>
                    {o.duration}
                  </td>
                  <td>{fmtCr(o.annualValueCr)}</td>
                  <td>
                    <span className={orderSizeClass(o.orderSizePct)}>
                      {o.orderSizePct != null ? `${o.orderSizePct}%` : '—'}
                    </span>
                  </td>
                  <td className="muted">
                    {fmtCr(o.companyRevenueCr)} ({o.revenueFy})
                  </td>
                  <td>
                    {o.pdfUrl ? (
                      <a
                        href={o.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="pdf-chip"
                        title="Open source document"
                      >
                        PDF
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
