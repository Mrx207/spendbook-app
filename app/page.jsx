"use client";
import React, { useState, useEffect, useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { parseSMS, splitMessages, categorise, matchAccount, dupStatus, settle } from "@/lib/parser";

const inr = (n, compact = false) => {
  const v = Math.abs(Number(n) || 0);
  if (compact) {
    if (v >= 1e7) return "₹" + (v/1e7).toFixed(2).replace(/\.00$/,"") + "Cr";
    if (v >= 1e5) return "₹" + (v/1e5).toFixed(2).replace(/\.00$/,"") + "L";
    if (v >= 1e3) return "₹" + (v/1e3).toFixed(1).replace(/\.0$/,"") + "k";
  }
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};
const todayISO = () => new Date().toISOString().slice(0,10);

export default function Page() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("home");
  const [blob, setBlob] = useState("");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const load = () => fetch("/api/transactions").then(r=>r.json()).then(setData);
  useEffect(() => { load(); }, []);

  const flash = (m) => { setToast(m); setTimeout(()=>setToast(""), 2200); };

  // Everything derived from `data` lives in one memo above the early return so
  // the hook count stays the same before and after the fetch resolves.
  const view = useMemo(() => {
    if (!data) return null;
    const { txns, categories, accounts } = data;
    const catMap = Object.fromEntries(categories.map(c=>[c.id,c]));
    const accMap = Object.fromEntries(accounts.map(a=>[a.id,a]));
    const isSpend = (t) => t.type === "debit" && !catMap[t.category_id]?.excluded;

    const now = new Date();
    const monthTxns = txns.filter(t => { const d = new Date(t.date); return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth(); });
    const spends = monthTxns.filter(isSpend);
    const out = spends.reduce((s,t)=>s+Number(t.amount),0);

    const m = {}; spends.forEach(t => { m[t.category_id] = (m[t.category_id]||0) + Number(t.amount); });
    const byCat = Object.entries(m).map(([id,value]) => ({ id, value, ...catMap[id] })).sort((a,b)=>b.value-a.value);

    return { catMap, accMap, monthTxns, out, byCat };
  }, [data]);

  if (!data) return <div style={S.boot}><div style={S.bootMark}>₹</div><div style={S.bootLabel}>Opening your passbook</div></div>;

  const { txns, categories, accounts, rules } = data;
  const { catMap, accMap, monthTxns, out, byCat } = view;

  const runSMS = () => {
    const parts = splitMessages(blob);
    const parsed = parts.map(parseSMS).filter(Boolean);
    if (!parsed.length) return flash("No transactions found in that text");
    const seen = [];
    const rows = parsed.map(p => {
      const account_id = matchAccount(p.last4, p.hint, accounts);
      const acc = accMap[account_id];
      const s = settle(p.money, Object.fromEntries((data.rates||[]).map(r=>[r.currency,Number(r.rate)])), acc?.markup ?? 3.5) || { amount: 0 };
      const txn = { ...p, ...s, account_id, category_id: categorise({ ...p, ...s }, rules.map(r=>({pattern:r.pattern,categoryId:r.category_id})), categories) };
      const status = dupStatus(txn, [...txns, ...seen]);
      seen.push(txn);
      return { txn, dup: status, keep: status === "new" };
    });
    setDraft(rows);
  };

  const commitDraft = async () => {
    setBusy(true);
    const keep = draft.filter(d=>d.keep);
    for (const d of keep) {
      await fetch("/api/transactions", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({
        type: d.txn.type, amount: d.txn.amount, date: d.txn.date, time: d.txn.time,
        merchant: d.txn.merchant, categoryId: d.txn.category_id, accountId: d.txn.account_id,
      })});
    }
    setBusy(false); setDraft(null); setBlob(""); flash(`${keep.length} entries added`);
    load(); setTab("log");
  };

  return (
    <div style={S.root}>
      <div style={S.main}>
        {tab === "home" && (
          <>
            <div style={S.slab}>
              <div style={S.slabLabel}>Spent this month</div>
              <div style={S.slabAmt}>{inr(out)}</div>
              <div style={S.slabMeta}>{monthTxns.length} entries</div>
            </div>
            {byCat.length > 0 && (
              <div style={S.card}>
                <div style={S.cardHead}>Where it went</div>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={byCat} dataKey="value" innerRadius={48} outerRadius={80} paddingAngle={2} stroke="none">
                      {byCat.map(s => <Cell key={s.id} fill={s.color} />)}
                    </Pie>
                    <Tooltip contentStyle={S.tip} formatter={(v,n,p)=>[inr(v), p.payload.name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
            <div style={S.card}>
              <div style={S.cardHead}>Latest</div>
              {monthTxns.slice(0,8).map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} />)}
              {monthTxns.length === 0 && <div style={S.empty}>Nothing logged yet. Import bank messages to start.</div>}
            </div>
          </>
        )}

        {tab === "log" && (
          <div style={{padding:"12px 16px"}}>
            {txns.map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} />)}
          </div>
        )}

        {tab === "import" && !draft && (
          <div style={{padding:"16px"}}>
            <p style={S.help}>Paste bank SMS text — one or many, separated by blank lines.</p>
            <textarea style={S.textarea} rows={8} value={blob} onChange={e=>setBlob(e.target.value)}
              placeholder="Rs.450.00 debited from a/c XX1234 to VPA swiggy@ybl on 20-08-26..." />
            <button style={S.btnPrimary} onClick={runSMS} disabled={!blob.trim()}>Read messages</button>
            <div style={{marginTop:28}}>
              <div style={S.cardHead}>Capture bank SMS automatically</div>
              <ol style={S.steps}>
                <li>In <b>Shortcuts</b> on iPhone, open the <b>Automation</b> tab and create a new one of type <b>Message</b>.</li>
                <li>Set it to run when a message <b>contains</b> any of: <i>debited</i>, <i>credited</i>, <i>spent</i>. Turn <b>Ask Before Running</b> off.</li>
                <li>Add the action <b>Get Contents of URL</b> and point it at:<br/>
                  <code style={S.code}>https://spendbook-app.vercel.app/api/ingest</code></li>
                <li>Set <b>Method</b> to <code style={S.code}>POST</code> and <b>Request Body</b> to <code style={S.code}>JSON</code>.</li>
                <li>Add two text fields to the body:<br/>
                  <code style={S.code}>secret</code> — the value stored as <code style={S.code}>INGEST_SECRET</code> in your Vercel project<br/>
                  <code style={S.code}>text</code> — the <b>Shortcut Input</b> variable, which holds the SMS body</li>
              </ol>
              <p style={S.help}>Each message is parsed, categorised, and checked against your ledger, so repeats are skipped rather than double-counted.</p>
            </div>
          </div>
        )}

        {tab === "import" && draft && (
          <div style={{padding:"12px 16px"}}>
            {draft.map((d,i) => (
              <div key={d.txn.id} style={{...S.slip, opacity: d.keep?1:0.5}}>
                <button style={S.check} onClick={()=>setDraft(draft.map((x,j)=>j===i?{...x,keep:!x.keep}:x))}>{d.keep?"✓":""}</button>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <b>{d.txn.merchant}</b><span>{inr(d.txn.amount)}</span>
                  </div>
                  <div style={S.small}>{d.txn.date} · {catMap[d.txn.category_id]?.name}
                    {d.dup==="exact" && <span style={S.badgeDup}> already in ledger</span>}
                    {d.dup==="likely" && <span style={S.badgeMaybe}> possible repeat</span>}
                  </div>
                </div>
              </div>
            ))}
            <button style={S.btnPrimary} disabled={busy} onClick={commitDraft}>
              Add {draft.filter(d=>d.keep).length} entries
            </button>
          </div>
        )}
      </div>

      <nav style={S.tabs}>
        {[["home","Summary"],["log","Ledger"],["import","Import"]].map(([id,label])=>(
          <button key={id} style={{...S.tab, color: tab===id?"#E8EDF5":"#8494AC"}} onClick={()=>setTab(id)}>{label}</button>
        ))}
      </nav>
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

function Row({ t, cat, acc }) {
  return (
    <div style={S.row}>
      <span style={{...S.chip, background:(cat?.color||"#666")+"22", color:cat?.color||"#666"}}>{cat?.icon||"❔"}</span>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14}}>{t.merchant}</div>
        <div style={S.small}>{t.date} · {cat?.name} {acc ? `· ${acc.name}` : ""}</div>
      </div>
      <span style={{color: t.type==="credit" ? "#4BB6A8" : "#E8EDF5"}}>{t.type==="credit"?"+":"−"}{inr(t.amount).slice(1)}</span>
    </div>
  );
}

const S = {
  root: { position:"fixed", inset:0, background:"#0E1420", color:"#E8EDF5", fontFamily:"system-ui", display:"flex", flexDirection:"column" },
  main: { flex:1, overflowY:"auto" },
  boot: { position:"fixed", inset:0, background:"#0E1420", color:"#F2C14E", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"system-ui" },
  bootMark: { fontSize:44 }, bootLabel: { color:"#8494AC", fontSize:13, marginTop:8 },
  slab: { padding:"20px 16px" }, slabLabel: { fontSize:11, color:"#8494AC", textTransform:"uppercase" },
  slabAmt: { fontSize:38, fontWeight:500, margin:"4px 0" }, slabMeta: { fontSize:12, color:"#8494AC" },
  card: { padding:"16px", borderTop:"1px solid #2A3549" }, cardHead: { fontSize:12, color:"#8494AC", textTransform:"uppercase", marginBottom:10 },
  row: { display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:"1px solid #2A354980" },
  chip: { width:32, height:32, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  small: { fontSize:11, color:"#8494AC" }, empty: { padding:"30px 0", textAlign:"center", color:"#8494AC", fontSize:13 },
  help: { fontSize:13, color:"#8494AC", lineHeight:1.6 },
  steps: { fontSize:13, color:"#8494AC", lineHeight:1.7, paddingLeft:18, margin:"0 0 12px" },
  textarea: { width:"100%", background:"#171F2E", border:"1px solid #2A3549", borderRadius:11, color:"#E8EDF5", padding:12, fontSize:12, margin:"10px 0", fontFamily:"monospace" },
  btnPrimary: { width:"100%", background:"#F2C14E", color:"#141A12", border:"none", borderRadius:12, padding:14, fontWeight:600, fontSize:15 },
  code: { background:"#171F2E", padding:"2px 6px", borderRadius:5, fontSize:11 },
  slip: { display:"flex", gap:10, background:"#171F2E", border:"1px solid #2A3549", borderRadius:12, padding:12, marginBottom:8 },
  check: { width:22, height:22, borderRadius:7, border:"1.5px solid #2A3549", background:"transparent", color:"#F2C14E", flexShrink:0 },
  badgeDup: { color:"#EF6F63" }, badgeMaybe: { color:"#F2C14E" },
  tabs: { display:"flex", borderTop:"1px solid #2A3549", background:"#0E1420" },
  tab: { flex:1, background:"none", border:"none", padding:"14px 4px", fontSize:13 },
  toast: { position:"fixed", left:"50%", transform:"translateX(-50%)", bottom:70, background:"#212B3D", border:"1px solid #2A3549", borderRadius:11, padding:"10px 16px", fontSize:13 },
};
