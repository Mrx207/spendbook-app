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
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Postgres hands dates back as "2026-07-31T00:00:00.000Z". Slicing the date off
// the front keeps the day the bank recorded - building a Date and reading local
// fields would shift it across the timezone boundary.
const dayOf = (d) => String(d).slice(0,10);
const monthOf = (d) => String(d).slice(0,7);
const fmtDay = (d) => { const [, m, day] = dayOf(d).split("-"); return `${+day} ${MONTHS[+m-1] || ""}`; };
const fmtMonth = (ym) => { const [y, m] = ym.split("-"); return `${MONTHS[+m-1]} ${y}`; };
const shiftMonth = (ym, by) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
};
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
};

export default function Page() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("home");
  const [blob, setBlob] = useState("");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [month, setMonth] = useState(null);
  const [sel, setSel] = useState(null);
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

    // Landing on an empty month because the last import was August and it is
    // now September is a dead end, so default to the newest month with data.
    const present = [...new Set(txns.map(t => monthOf(t.date)))].sort();
    const active = month || present[present.length-1] || thisMonth();
    const monthTxns = txns.filter(t => monthOf(t.date) === active);

    const sum = (list) => list.reduce((s,t)=>s+Number(t.amount),0);
    const of = (kind) => monthTxns.filter(t => kindOf(t, catMap) === kind);

    const spends = of("expense");
    const out = sum(spends);
    const income = sum(of("income"));
    const moved = sum(of("transfer"));

    // Net position per person: money you sent them counts up, money they sent
    // back counts down. One rule covers lending, borrowing and repayment - a
    // positive balance means they owe you, negative means you owe them.
    const ledger = {};
    txns.filter(t => t.person).forEach(t => {
      const name = t.person.trim();
      ledger[name] = (ledger[name] || 0) + (t.type === "debit" ? 1 : -1) * Number(t.amount);
    });
    const people = Object.entries(ledger)
      .map(([name, balance]) => ({ name, balance }))
      .filter(p => Math.abs(p.balance) > 0.01)
      .sort((a,b) => Math.abs(b.balance) - Math.abs(a.balance));

    const owedToYou = people.filter(p => p.balance > 0).reduce((s,p)=>s+p.balance, 0);
    const youOwe = people.filter(p => p.balance < 0).reduce((s,p)=>s-p.balance, 0);
    const debtTotal = (data.debts||[]).reduce((s,d)=>s+Number(d.outstanding), 0);

    // Only expenses belong in the breakdown - transfers would double-count
    // money you still own, and income isn't spending at all.
    const m = {}; spends.forEach(t => { m[t.category_id] = (m[t.category_id]||0) + Number(t.amount); });
    const byCat = Object.entries(m).map(([id,value]) => ({ id, value, ...catMap[id] })).sort((a,b)=>b.value-a.value);

    return { catMap, accMap, monthTxns, out, income, moved, net: income - out, byCat,
             active, present, people, owedToYou, youOwe, debtTotal };
  }, [data, month]);

  if (!data) return <div style={S.boot}><div style={S.bootMark}>₹</div><div style={S.bootLabel}>Opening your passbook</div></div>;

  const { txns, categories, accounts, rules } = data;
  const { catMap, accMap, monthTxns, out, income, moved, net, byCat,
          active, present, people, owedToYou, youOwe, debtTotal } = view;

  const saveTxn = async (edited) => {
    setBusy(true);
    const r = await fetch("/api/transactions", {
      method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(edited),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return flash(body.error || "Could not save that change");
    setSel(null); flash("Saved"); load();
  };

  const deleteTxn = async (id) => {
    setBusy(true);
    const r = await fetch("/api/transactions", {
      method: "DELETE", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }),
    });
    setBusy(false);
    if (!r.ok) return flash("Could not delete that entry");
    setSel(null); flash("Deleted"); load();
  };

  const addDebt = async (payload) => {
    const r = await fetch("/api/debts", {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return flash(body.error || "Could not add that");
    flash("Added"); load();
  };

  const payDebt = async (id, paid) => {
    const r = await fetch("/api/debts", {
      method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id, paid }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return flash(body.error || "Could not record that payment");
    flash(body.outstanding > 0 ? `${inr(body.outstanding)} left` : "Cleared"); load();
  };

  const removeDebt = async (id) => {
    await fetch("/api/debts", {
      method: "DELETE", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }),
    });
    flash("Removed"); load();
  };

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
            <div style={S.monthBar}>
              <button style={S.monthNav} onClick={()=>setMonth(shiftMonth(active,-1))}>‹</button>
              <span style={S.monthName}>{fmtMonth(active)}</span>
              <button style={{...S.monthNav, opacity: active >= thisMonth() ? 0.3 : 1}}
                disabled={active >= thisMonth()} onClick={()=>setMonth(shiftMonth(active,1))}>›</button>
            </div>
            <div style={S.slab}>
              <div style={S.slabLabel}>Spent</div>
              <div style={S.slabAmt}>{inr(out)}</div>
              <div style={S.slabMeta}>
                {monthTxns.length} entries
                {monthTxns.length === 0 && present.length > 0 &&
                  <> · <button style={S.linkBtn} onClick={()=>setMonth(present[present.length-1])}>
                    jump to {fmtMonth(present[present.length-1])}</button></>}
              </div>
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
              {monthTxns.slice(0,8).map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} kind={kindOf(t, catMap)} onOpen={()=>setSel(t)} />)}
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
              return shown.map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} kind={kindOf(t, catMap)} onOpen={()=>setSel(t)} />);
            })()}
          </div>
        )}

        {tab === "owed" && (
          <div style={{padding:"16px"}}>
            <div style={S.statRow}>
              <div style={S.stat}>
                <div style={S.statLabel}>Owed to you</div>
                <div style={{...S.statAmt, color:"#4BB6A8"}}>{inr(owedToYou, true)}</div>
              </div>
              <div style={S.stat}>
                <div style={S.statLabel}>You owe</div>
                <div style={{...S.statAmt, color: (youOwe+debtTotal) > 0 ? "#EF6F63" : "#E8EDF5"}}>
                  {inr(youOwe + debtTotal, true)}
                </div>
              </div>
            </div>

            <div style={{...S.cardHead, marginTop:22}}>People</div>
            {people.length === 0 && (
              <p style={S.help}>
                Nothing tracked yet. Open any transaction and set its category to
                <b> Lent / Borrowed</b>, then name the person — balances build up from there.
              </p>
            )}
            {people.map(p => (
              <div key={p.name} style={S.row}>
                <span style={{...S.chip, background:"#C98A5E22", color:"#C98A5E"}}>🤝</span>
                <div style={{flex:1, minWidth:0, textAlign:"left"}}>
                  <div style={{fontSize:14}}>{p.name}</div>
                  <div style={S.small}>{p.balance > 0 ? "owes you" : "you owe them"}</div>
                </div>
                <span style={{color: p.balance > 0 ? "#4BB6A8" : "#EF6F63", whiteSpace:"nowrap"}}>
                  {inr(p.balance).slice(1)}
                </span>
              </div>
            ))}

            <div style={{...S.cardHead, marginTop:26}}>Loans & debts</div>
            <DebtForm onAdd={addDebt} />
            {(data.debts||[]).map(d => (
              <DebtRow key={d.id} debt={d} onPay={payDebt} onRemove={removeDebt} />
            ))}
            {(data.debts||[]).length === 0 && (
              <p style={S.help}>Add a loan or card balance to track what's left to pay.</p>
            )}
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
        {[["home","Summary"],["log","Ledger"],["owed","Owed"],["import","Import"]].map(([id,label])=>(
          <button key={id} style={{...S.tab, color: tab===id?"#E8EDF5":"#8494AC"}} onClick={()=>setTab(id)}>{label}</button>
        ))}
      </nav>
      {sel && (
        <DetailSheet txn={sel} categories={categories} accMap={accMap} busy={busy}
          onClose={()=>setSel(null)} onSave={saveTxn} onDelete={deleteTxn} />
      )}
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

function Row({ t, cat, acc, kind, onOpen }) {
  // Transfers are deliberately muted and unsigned - the money didn't leave.
  const tone = kind === "income" ? "#4BB6A8" : kind === "transfer" ? "#8494AC" : "#E8EDF5";
  const sign = kind === "income" ? "+" : kind === "transfer" ? "" : "−";
  return (
    <button style={S.row} onClick={onOpen}>
      <span style={{...S.chip, background:(cat?.color||"#666")+"22", color:cat?.color||"#666"}}>{cat?.icon||"❔"}</span>
      <div style={{flex:1, minWidth:0, textAlign:"left"}}>
        <div style={{fontSize:14, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.merchant}</div>
        <div style={S.small}>{fmtDay(t.date)} · {cat?.name}{t.person ? ` · ${t.person}` : ""} {acc ? `· ${acc.name}` : ""}</div>
      </div>
      <span style={{color: tone, whiteSpace:"nowrap"}}>{sign}{inr(t.amount).slice(1)}</span>
    </button>
  );
}

// Tap a row to see what the bank actually said and correct how it was filed.
function DetailSheet({ txn, categories, accMap, busy, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    id: txn.id, amount: String(txn.amount), type: txn.type,
    merchant: txn.merchant || "", note: txn.note || "",
    category_id: txn.category_id || "other", person: txn.person || "",
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const cat = categories.find(c => c.id === form.category_id);

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.sheet} onClick={e=>e.stopPropagation()}>
        <div style={S.sheetGrab} />
        <div style={S.sheetHead}>
          <span>{fmtDay(txn.date)}{txn.time ? ` · ${txn.time}` : ""}</span>
          <span style={S.small}>{accMap[txn.account_id]?.name || txn.source || ""}</span>
        </div>

        <label style={S.field}>
          <span style={S.fieldLabel}>Who / what</span>
          <input style={S.input} value={form.merchant} onChange={e=>set("merchant", e.target.value)} />
        </label>

        <div style={{display:"flex", gap:10}}>
          <label style={{...S.field, flex:1}}>
            <span style={S.fieldLabel}>Amount</span>
            <input style={S.input} inputMode="decimal" value={form.amount} onChange={e=>set("amount", e.target.value)} />
          </label>
          <label style={{...S.field, flex:1}}>
            <span style={S.fieldLabel}>Direction</span>
            <select style={S.input} value={form.type} onChange={e=>set("type", e.target.value)}>
              <option value="debit">Money out</option>
              <option value="credit">Money in</option>
            </select>
          </label>
        </div>

        <label style={S.field}>
          <span style={S.fieldLabel}>Category</span>
          <select style={S.input} value={form.category_id} onChange={e=>set("category_id", e.target.value)}>
            {["expense","income","transfer"].map(group => (
              <optgroup key={group} label={group === "expense" ? "Spending" : group === "income" ? "Money in" : "Not spending"}>
                {categories.filter(c=>c.kind===group).map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <span style={S.hint}>
            {cat?.kind === "transfer" && "Won't count as spending — money you still own."}
            {cat?.kind === "income" && "Counts as money in."}
            {cat?.kind === "expense" && "Counts as spending."}
          </span>
        </label>

        {form.category_id === "people" && (
          <label style={S.field}>
            <span style={S.fieldLabel}>Person</span>
            <input style={S.input} placeholder="Name" value={form.person} onChange={e=>set("person", e.target.value)} />
            <span style={S.hint}>
              {form.type === "debit"
                ? "Money you gave them — they owe you, or it repays what you owed."
                : "Money they gave you — you owe them, or it settles what they owed."}
            </span>
          </label>
        )}

        <label style={S.field}>
          <span style={S.fieldLabel}>Note</span>
          <input style={S.input} placeholder="Optional" value={form.note} onChange={e=>set("note", e.target.value)} />
        </label>

        {txn.raw && (
          <div style={S.field}>
            <span style={S.fieldLabel}>What the bank sent</span>
            <div style={S.rawBox}>{txn.raw}</div>
          </div>
        )}

        <button style={{...S.btnPrimary, marginTop:6}} disabled={busy}
          onClick={()=>onSave({ ...form, amount: Number(form.amount) })}>
          {busy ? "Saving…" : "Save"}
        </button>
        {confirmDelete ? (
          <div style={S.confirmRow}>
            <span style={S.small}>Delete this entry?</span>
            <span>
              <button style={S.linkBtn} onClick={()=>setConfirmDelete(false)}>Keep</button>
              <button style={{...S.linkBtn, color:"#EF6F63"}} onClick={()=>onDelete(txn.id)}>Delete</button>
            </span>
          </div>
        ) : (
          <button style={S.btnGhost} onClick={()=>setConfirmDelete(true)}>Delete</button>
        )}
      </div>
    </div>
  );
}

function DebtForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState("");

  if (!open) return <button style={S.btnGhost} onClick={()=>setOpen(true)}>+ Add a loan or debt</button>;
  return (
    <div style={S.slip}>
      <div style={{flex:1}}>
        <input style={{...S.input, marginBottom:8}} placeholder="Car loan, HDFC card…" value={name} onChange={e=>setName(e.target.value)} />
        <input style={{...S.input, marginBottom:8}} inputMode="decimal" placeholder="Amount owed" value={principal} onChange={e=>setPrincipal(e.target.value)} />
        <div style={{display:"flex", gap:8}}>
          <button style={{...S.btnPrimary, flex:1}} disabled={!name.trim() || !(Number(principal)>0)}
            onClick={()=>{ onAdd({ name, principal: Number(principal) }); setName(""); setPrincipal(""); setOpen(false); }}>
            Add
          </button>
          <button style={{...S.btnGhost, flex:1, marginTop:0}} onClick={()=>setOpen(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function DebtRow({ debt, onPay, onRemove }) {
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState("");
  const outstanding = Number(debt.outstanding);
  const principal = Number(debt.principal) || 1;
  const cleared = Math.min(100, Math.max(0, (1 - outstanding / principal) * 100));

  return (
    <div style={{...S.slip, flexDirection:"column", gap:8}}>
      <div style={{display:"flex", justifyContent:"space-between", width:"100%"}}>
        <b style={{fontSize:14}}>{debt.name}</b>
        <span style={{color: outstanding > 0 ? "#EF6F63" : "#4BB6A8"}}>
          {outstanding > 0 ? inr(outstanding) : "Cleared"}
        </span>
      </div>
      <div style={S.barTrack}><div style={{...S.barFill, width:`${cleared}%`}} /></div>
      <div style={{display:"flex", justifyContent:"space-between", width:"100%", alignItems:"center"}}>
        <span style={S.small}>{inr(principal - outstanding)} of {inr(principal)} paid</span>
        {paying ? (
          <span style={{display:"flex", gap:6}}>
            <input style={{...S.input, width:100, padding:8}} inputMode="decimal" autoFocus
              placeholder="Amount" value={amount} onChange={e=>setAmount(e.target.value)} />
            <button style={S.linkBtn} disabled={!(Number(amount)>0)}
              onClick={()=>{ onPay(debt.id, Number(amount)); setAmount(""); setPaying(false); }}>Save</button>
            <button style={S.linkBtn} onClick={()=>setPaying(false)}>×</button>
          </span>
        ) : (
          <span>
            {outstanding > 0 && <button style={S.linkBtn} onClick={()=>setPaying(true)}>Record payment</button>}
            <button style={{...S.linkBtn, color:"#8494AC"}} onClick={()=>onRemove(debt.id)}>Remove</button>
          </span>
        )}
      </div>
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
  row: { display:"flex", alignItems:"center", gap:10, padding:"10px 0", borderBottom:"1px solid #2A354980",
         width:"100%", background:"none", border:"none", borderBottomStyle:"solid", color:"#E8EDF5", fontSize:14, textAlign:"left" },
  monthBar: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 16px 0" },
  monthNav: { background:"none", border:"none", color:"#F2C14E", fontSize:26, lineHeight:1, padding:"0 12px" },
  monthName: { fontSize:13, color:"#8494AC", textTransform:"uppercase", letterSpacing:1 },
  overlay: { position:"fixed", inset:0, background:"#00000088", display:"flex", alignItems:"flex-end", zIndex:20 },
  sheet: { width:"100%", maxHeight:"88vh", overflowY:"auto", background:"#141B29", borderTopLeftRadius:18, borderTopRightRadius:18,
           padding:"10px 16px calc(20px + env(safe-area-inset-bottom))", border:"1px solid #2A3549" },
  sheetGrab: { width:38, height:4, borderRadius:2, background:"#2A3549", margin:"2px auto 14px" },
  sheetHead: { display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12, color:"#8494AC", marginBottom:14 },
  field: { display:"block", marginBottom:12 },
  fieldLabel: { display:"block", fontSize:10, color:"#8494AC", textTransform:"uppercase", letterSpacing:0.4, marginBottom:5 },
  input: { width:"100%", background:"#171F2E", border:"1px solid #2A3549", borderRadius:10, color:"#E8EDF5", padding:11, fontSize:15, boxSizing:"border-box" },
  hint: { display:"block", fontSize:11, color:"#8494AC", marginTop:5, lineHeight:1.5 },
  rawBox: { background:"#0E1420", border:"1px solid #2A3549", borderRadius:10, padding:11, fontSize:11,
            color:"#8494AC", fontFamily:"monospace", lineHeight:1.6, wordBreak:"break-word" },
  btnGhost: { width:"100%", background:"none", border:"1px solid #2A3549", color:"#8494AC", borderRadius:12, padding:12, fontSize:14, marginTop:8 },
  confirmRow: { display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10 },
  barTrack: { width:"100%", height:5, background:"#0E1420", borderRadius:3, overflow:"hidden" },
  barFill: { height:"100%", background:"#4BB6A8" },
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
