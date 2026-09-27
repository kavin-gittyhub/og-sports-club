import { useState } from 'react';
import { api } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/format.js';
import { Button, ErrorBox, Skeleton, useAsync } from '../../components/ui.jsx';
import { PageHead } from './shared.jsx';

export default function Audit() {
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useAsync(() => api(`/admin/audit?limit=100&offset=${offset}`), [offset]);
  return (
    <>
      <PageHead title="Audit log" sub="Every booking, payment, price and settings change — who did it and when." />
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {loading && !data && Array.from({ length: 8 }, (_, i) => <tr key={i}><td colSpan={4}><Skeleton h={18} /></td></tr>)}
            {data?.logs.map((l) => (
              <tr key={l.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(l.createdAt)}</td>
                <td>{l.actor}<div className="cell-sub">{l.role}</div></td>
                <td className="cell-strong">{l.action}</td>
                <td className="cell-sub" style={{ maxWidth: 420, wordBreak: 'break-word' }}>{l.details?.ref ? `${l.details.ref} · ` : ''}{JSON.stringify(l.details).slice(0, 180)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row gap-sm mt">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 100))}>Newer</Button>
        <Button variant="outline" size="sm" disabled={!data || data.logs.length < 100} onClick={() => setOffset((o) => o + 100)}>Older</Button>
      </div>
    </>
  );
}
