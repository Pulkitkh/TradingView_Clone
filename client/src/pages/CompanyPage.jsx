import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchCompany } from '../api/client.js';

function FinancialTable({ title, table }) {
  if (!table || !table.rows?.length) return null;
  return (
    <section className="fin-section">
      <h3>{title}</h3>
      <div className="fin-scroll">
        <table className="fin-table">
          <thead>
            <tr>
              <th className="sticky-col"></th>
              {table.headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                <td className="sticky-col row-label">{row.label}</td>
                {row.values.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function CompanyPage() {
  const { symbol } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchCompany(symbol)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [symbol]);

  if (loading) return <div className="company-page"><p className="table-msg">Loading {symbol} from Screener…</p></div>;
  if (error)
    return (
      <div className="company-page">
        <Link to="/" className="back-link">← Back to orders</Link>
        <p className="table-msg error">Could not load data for “{symbol}”: {error}</p>
      </div>
    );

  const f = data.financials;

  return (
    <div className="company-page">
      <Link to="/" className="back-link">← Back to orders</Link>

      <div className="company-head">
        <div>
          <h1>{data.name}</h1>
          {data.about && <p className="company-about">{data.about}</p>}
        </div>
        <a
          className="btn-refresh ghost"
          href={data.screenerUrl}
          target="_blank"
          rel="noreferrer"
        >
          View on Screener ↗
        </a>
      </div>

      {data.ratios?.length > 0 && (
        <div className="ratio-grid">
          {data.ratios.map((r, i) => (
            <div className="ratio-card" key={i}>
              <div className="ratio-name">{r.name}</div>
              <div className="ratio-value">{r.value}</div>
            </div>
          ))}
        </div>
      )}

      {(data.prosCons?.pros?.length > 0 || data.prosCons?.cons?.length > 0) && (
        <div className="proscons">
          {data.prosCons.pros.length > 0 && (
            <div className="pros-card">
              <h4>Pros</h4>
              <ul>
                {data.prosCons.pros.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {data.prosCons.cons.length > 0 && (
            <div className="cons-card">
              <h4>Cons</h4>
              <ul>
                {data.prosCons.cons.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <FinancialTable title="Quarterly Results" table={f.quarters} />
      <FinancialTable title="Profit & Loss" table={f.profitLoss} />
      <FinancialTable title="Balance Sheet" table={f.balanceSheet} />
      <FinancialTable title="Cash Flow" table={f.cashFlow} />
      <FinancialTable title="Ratios" table={f.ratios} />
      <FinancialTable title="Shareholding Pattern" table={f.shareholding} />

      <p className="fetched-note">
        Data sourced live from Screener.in · fetched {new Date(data.fetchedAt).toLocaleString()}
      </p>
    </div>
  );
}
