"use client";
import React, { useState, useEffect, useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { parseSMS, splitMessages, categorise, matchAccount, dupStatus, settle, kindOf } from "@/lib/parser";

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
  const [kindFilter, setKindFilter] = useState("all");
  const fileRef = React.useRef(null);

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

    const now = new Date();
    const monthTxns = txns.filter(t => { const d = new Date(t.date); return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth(); });

    const sum = (list) => list.reduce((s,t)=>s+Number(t.amount),0);
    const of = (kind) => monthTxns.filter(t => kindOf(t, catMap) === kind);

    const spends = of("expense");
    const out = sum(spends);
    const income = sum(of("income"));
    const moved = sum(of("transfer"));

    // Only expenses belong in the breakdown - transfers would double-count
    // money you still own, and income isn't spending at all.
    const m = {}; spends.forEach(t => { m[t.category_id] = (m[t.category_id]||0) + Number(t.amount); });
    const byCat = Object.entries(m).map(([id,value]) => ({ id, value, ...catMap[id] })).sort((a,b)=>b.value-a.value);

    return { catMap, accMap, monthTxns, out, income, moved, net: income - out, byCat };
  }, [data]);

  if (!data) return <div style={S.boot}><div style={S.bootMark}>₹</div><div style={S.bootLabel}>Opening your passbook</div></div>;

  const { txns, categories, accounts, rules } = data;
  const { catMap, accMap, monthTxns, out, income, moved, net, byCat } = view;

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

  const uploadStatement = async (file) => {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    const r = await fetch("/api/import", { method: "POST", body: form });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (!r.ok) return flash(body.error || "Could not read that file");
    setDraft(body.draft);
    const dupes = body.draft.filter(d => d.dup !== "new").length;
    flash(`${body.draft.length} rows read${dupes ? `, ${dupes} already in ledger` : ""}`);
  };

  const commitDraft = async () => {
    setBusy(true);
    const keep = draft.filter(d=>d.keep);
    const r = await fetch("/api/transactions", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ txns: keep.map(d => d.txn) }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return flash(body.error || "Could not save those entries");
    setDraft(null); setBlob(""); flash(`${body.added} entries added`);
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

            <div style={S.statRow}>
              <div style={S.stat}>
                <div style={S.statLabel}>Money in</div>
                <div style={{...S.statAmt, color:"#4BB6A8"}}>{inr(income, true)}</div>
              </div>
              <div style={S.stat}>
                <div style={S.statLabel}>Money out</div>
                <div style={S.statAmt}>{inr(out, true)}</div>
              </div>
              <div style={S.stat}>
                <div style={S.statLabel}>{net < 0 ? "Overspent" : "Left over"}</div>
                <div style={{...S.statAmt, color: net < 0 ? "#EF6F63" : "#E8EDF5"}}>{inr(net, true)}</div>
              </div>
            </div>
            {moved > 0 && (
              <div style={S.movedNote}>
                {inr(moved, true)} moved between your own accounts, cards and investments — not counted as spending.
              </div>
            )}
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
              {monthTxns.slice(0,8).map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} kind={kindOf(t, catMap)} />)}
              {monthTxns.length === 0 && <div style={S.empty}>Nothing logged yet. Import bank messages to start.</div>}
            </div>
          </>
        )}

        {tab === "log" && (
          <div style={{padding:"12px 16px"}}>
            <div style={S.filterRow}>
              {[["all","All"],["expense","Spending"],["income","Income"],["transfer","Transfers"]].map(([id,label])=>(
                <button key={id} onClick={()=>setKindFilter(id)}
                  style={{...S.filterChip, ...(kindFilter===id ? S.filterChipOn : null)}}>{label}</button>
              ))}
            </div>
            {(() => {
              const shown = kindFilter === "all" ? txns : txns.filter(t => kindOf(t, catMap) === kindFilter);
              if (!shown.length) return <div style={S.empty}>Nothing here yet.</div>;
              return shown.map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} kind={kindOf(t, catMap)} />);
            })()}
          </div>
        )}

        {tab === "import" && !draft && (
          <div style={{padding:"16px"}}>
            <div style={S.cardHead}>Upload a statement</div>
            <p style={S.help}>CSV or Excel (.xlsx) exported from your bank. Columns are detected automatically.</p>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm,text/csv" style={{display:"none"}}
              onChange={e => uploadStatement(e.target.files?.[0])} />
            <button style={{...S.btnSecondary, marginTop:10}} disabled={busy} onClick={()=>fileRef.current?.click()}>
              {busy ? "Reading…" : "Choose file"}
            </button>

            <div style={{...S.cardHead, marginTop:28}}>Or paste bank SMS</div>
            <p style={S.help}>One message or many, separated by blank lines.</p>
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
            <div style={S.draftBar}>
              <span>{draft.filter(d=>d.keep).length} of {draft.length} selected</span>
              <span>
                <button style={S.linkBtn} onClick={()=>setDraft(draft.map(x=>({...x,keep:true})))}>All</button>
                <button style={S.linkBtn} onClick={()=>setDraft(draft.map(x=>({...x,keep:false})))}>None</button>
                <button style={S.linkBtn} onClick={()=>setDraft(draft.map(x=>({...x,keep:x.dup==="new"})))}>New only</button>
                <button style={S.linkBtn} onClick={()=>setDraft(null)}>Cancel</button>
              </span>
            </div>
            {draft.map((d,i) => (
              <div key={d.txn.id} style={{...S.slip, opacity: d.keep?1:0.5}}>
                <button style={S.check} onClick={()=>setDraft(draft.map((x,j)=>j===i?{...x,keep:!x.keep}:x))}>{d.keep?"✓":""}</button>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <b>{d.txn.merchant}</b><span>{inr(d.txn.amount)}</span>
                  </div>
                  <div style={S.small}>{d.txn.date} · {catMap[d.txn.category_id]?.name}
                    {kindOf(d.txn, catMap) === "transfer" && <span style={S.badgeMoved}> · not spending</span>}
                    {kindOf(d.txn, catMap) === "income" && <span style={S.badgeIn}> · money in</span>}
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

function Row({ t, cat, acc, kind }) {
  // Transfers are deliberately muted and unsigned - the money didn't leave.
  const tone = kind === "income" ? "#4BB6A8" : kind === "transfer" ? "#8494AC" : "#E8EDF5";
  const sign = kind === "income" ? "+" : kind === "transfer" ? "" : "−";
  return (
    <div style={S.row}>
      <span style={{...S.chip, background:(cat?.color||"#666")+"22", color:cat?.color||"#666"}}>{cat?.icon||"❔"}</span>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14}}>{t.merchant}</div>
        <div style={S.small}>{t.date} · {cat?.name} {acc ? `· ${acc.name}` : ""}</div>
      </div>
      <span style={{color: tone, whiteSpace:"nowrap"}}>{sign}{inr(t.amount).slice(1)}</span>
    </div>
  );
}

const S = {
  root: { position:"fixed", inset:0, background:"#0E1420", color:"#E8EDF5", fontFamily:"system-ui", display:"flex", flexDirection:"column" },
  // Keeps content clear of the notch and the home indicator once installed.
  main: { flex:1, overflowY:"auto", paddingTop:"env(safe-area-inset-top)", WebkitOverflowScrolling:"touch" },
  boot: { position:"fixed", inset:0, background:"#0E1420", color:"#F2C14E", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"system-ui" },
  bootMark: { fontSize:44 }, bootLabel: { color:"#8494AC", fontSize:13, marginTop:8 },
  slab: { padding:"20px 16px" }, slabLabel: { fontSize:11, color:"#8494AC", textTransform:"uppercase" },
  slabAmt: { fontSize:38, fontWeight:500, margin:"4px 0" }, slabMeta: { fontSize:12, color:"#8494AC" },
  statRow: { display:"flex", borderTop:"1px solid #2A3549", borderBottom:"1px solid #2A3549" },
  stat: { flex:1, padding:"12px 16px", borderRight:"1px solid #2A354980" },
  statLabel: { fontSize:10, color:"#8494AC", textTransform:"uppercase", letterSpacing:0.4 },
  statAmt: { fontSize:17, fontWeight:500, marginTop:3 },
  movedNote: { fontSize:11, color:"#8494AC", padding:"10px 16px", lineHeight:1.5 },
  card: { padding:"16px", borderTop:"1px solid #2A3549" }, cardHead: { fontSize:12, color:"#8494AC", textTransform:"uppercase", marginBottom:10 },
  row: { display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:"1px solid #2A354980" },
  chip: { width:32, height:32, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  small: { fontSize:11, color:"#8494AC" }, empty: { padding:"30px 0", textAlign:"center", color:"#8494AC", fontSize:13 },
  help: { fontSize:13, color:"#8494AC", lineHeight:1.6 },
  steps: { fontSize:13, color:"#8494AC", lineHeight:1.7, paddingLeft:18, margin:"0 0 12px" },
  textarea: { width:"100%", background:"#171F2E", border:"1px solid #2A3549", borderRadius:11, color:"#E8EDF5", padding:12, fontSize:12, margin:"10px 0", fontFamily:"monospace" },
  btnPrimary: { width:"100%", background:"#F2C14E", color:"#141A12", border:"none", borderRadius:12, padding:14, fontWeight:600, fontSize:15 },
  btnSecondary: { width:"100%", background:"#171F2E", color:"#E8EDF5", border:"1px solid #2A3549", borderRadius:12, padding:14, fontWeight:500, fontSize:15 },
  code: { background:"#171F2E", padding:"2px 6px", borderRadius:5, fontSize:11 },
  slip: { display:"flex", gap:10, background:"#171F2E", border:"1px solid #2A3549", borderRadius:12, padding:12, marginBottom:8 },
  check: { width:22, height:22, borderRadius:7, border:"1.5px solid #2A3549", background:"transparent", color:"#F2C14E", flexShrink:0 },
  badgeDup: { color:"#EF6F63" }, badgeMaybe: { color:"#F2C14E" },
  badgeMoved: { color:"#5A6B85" }, badgeIn: { color:"#4BB6A8" },
  draftBar: { display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:6, fontSize:12, color:"#8494AC", marginBottom:10 },
  linkBtn: { background:"none", border:"none", color:"#F2C14E", fontSize:12, padding:"4px 6px" },
  filterRow: { display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" },
  filterChip: { background:"#171F2E", border:"1px solid #2A3549", color:"#8494AC", borderRadius:999, padding:"6px 12px", fontSize:12 },
  filterChipOn: { background:"#F2C14E", borderColor:"#F2C14E", color:"#141A12", fontWeight:600 },
  tabs: { display:"flex", borderTop:"1px solid #2A3549", background:"#0E1420", paddingBottom:"env(safe-area-inset-bottom)" },
  tab: { flex:1, background:"none", border:"none", padding:"14px 4px", fontSize:13 },
  toast: { position:"fixed", left:"50%", transform:"translateX(-50%)", bottom:70, background:"#212B3D", border:"1px solid #2A3549", borderRadius:11, padding:"10px 16px", fontSize:13 },
};
