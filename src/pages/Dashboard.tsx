import { TrendingUp, Wallet, BarChart3, ChevronRight } from 'lucide-react';
import { useStore, leadValue, receivableBalance } from '../store';
import { OPEN_STAGES } from '../lib/types';
import { inr, inrShort, todayISO } from '../lib/format';
import { PageHead, InfoTip } from '../ui/kit';
import { nav } from '../ui/router';

const crmStage = (stage: string) => nav(`crm?stage=${encodeURIComponent(stage)}`);

export default function Dashboard() {
  const db = useStore(s => s.db);
  // Pipeline = the five open stages only; Closed (won) and Lost never count.
  const byStage = OPEN_STAGES.map(s => {
    const ls = db.leads.filter(l => l.stage === s);
    return { stage: s, count: ls.length, value: ls.reduce((a, l) => a + leadValue(db, l), 0) };
  });
  const pipeline = byStage.reduce((a, b) => a + b.value, 0);
  const openCount = byStage.reduce((a, b) => a + b.count, 0);
  const max = Math.max(...byStage.map(b => b.value));

  const today = todayISO();
  let outstanding = 0, unpaidCount = 0, overdue = 0, overdueCount = 0;
  for (const r of db.receivables) {
    const b = receivableBalance(r);
    if (b.outstanding <= 0) continue;
    outstanding += b.outstanding; unpaidCount++;
    if (r.dueDate < today) { overdue += b.outstanding; overdueCount++; }
  }

  return <>
    <PageHead title="Dashboard" sub="Live figures computed from your CRM and finance records." />

    <div className="grid g2">
      <button className="card kpi kpi-link" onClick={() => crmStage('open')} title="Open leads in New, Warm, Hot, Quote sent and Negotiation, valued at the saved quote total (or the lead estimate). Closed (won) and Lost are excluded. Click to view them in CRM.">
        <div className="row"><TrendingUp size={16} className="muted" /><span className="label">Pipeline value</span>
          <ChevronRight size={15} className="go" /></div>
        <div className="value" title={inr(pipeline)}>{inrShort(pipeline)}</div>
        <div className="supp">{openCount ? `${openCount} open lead${openCount === 1 ? '' : 's'}` : 'No open leads'}</div>
      </button>
      <button className="card kpi kpi-link" onClick={() => nav('finance/receivables')} title="Outstanding: every unpaid balance after recorded receipts. Overdue: only unpaid balances past their due date. Fully paid receivables are excluded. Click to open Finance → Receivables.">
        <div className="row"><Wallet size={16} className="muted" /><span className="label">Outstanding receivables</span>
          <ChevronRight size={15} className="go" /></div>
        <div className="value" title={inr(outstanding)}>{inrShort(outstanding)}</div>
        <div className="supp">{unpaidCount === 0 ? 'Nothing outstanding'
          : <>{unpaidCount} unpaid · {overdue > 0
            ? <span className="overdue" title={inr(overdue)}>{inrShort(overdue)} overdue · {overdueCount} record{overdueCount === 1 ? '' : 's'}</span>
            : 'nothing overdue'}</>}</div>
      </button>
    </div>

    <div className="card mt12">
      <div className="card-head"><BarChart3 size={16} className="muted" /><h2>Pipeline by stage</h2>
        <InfoTip text="Open stages only. Stage totals add up to the pipeline value. Click a stage to see its leads in CRM." /></div>
      <div className="stage-bars">
        {byStage.map(b => <button className="bar-row" key={b.stage} onClick={() => crmStage(b.stage)} aria-label={`${b.stage}: ${b.count} leads, ${inr(b.value)}. Open in CRM`}>
          <span className="bar-label">{b.stage}</span>
          <span className="bar-count">{b.count}</span>
          <span className="bar-track" aria-hidden><span className="bar-fill" style={{ width: max > 0 ? `${(b.value / max) * 100}%` : 0 }} /></span>
          <span className="bar-val" title={inr(b.value)}>{inrShort(b.value)}</span>
        </button>)}
        <div className="bar-row total" aria-label={`Total ${inr(pipeline)}`}>
          <span className="bar-label">Total</span><span className="bar-count">{openCount}</span><span /><span className="bar-val">{inrShort(pipeline)}</span>
        </div>
      </div>
    </div>
  </>;
}
