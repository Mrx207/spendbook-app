"use client";
import React, { useState, useEffect, useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { parseSMS, splitMessages, categorise, matchAccount, dupStatus, settle, kindOf } from "@/lib/parser";
import { summarise, compareMonths, findRecurring, backlog } from "@/lib/insights";

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
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [visible, setVisible] = useState(200);
  const [openPerson, setOpenPerson] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [showTidy, setShowTidy] = useState(false);
  const [bulk, setBulk] = useState(null);
  const [undo, setUndo] = useState(null);
  const [dupes, setDupes] = useState(null);
  const [showDupes, setShowDupes] = useState(false);
  const fileRef = React.useRef(null);

  const load = () => fetch("/api/transactions").then(r=>r.json()).then(setData);
  const checkDupes = () => fetch("/api/dedupe").then(r=>r.json()).then(setDupes).catch(()=>{});
  useEffect(() => { load(); checkDupes(); }, []);

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
             active, present, people, owedToYou, youOwe, debtTotal,
             compare: compareMonths(txns, catMap, active),
             recurring: findRecurring(txns, catMap),
             todo: backlog(txns) };
  }, [data, month]);

  if (!data) return <div style={S.boot}><div style={S.bootMark}>₹</div><div style={S.bootLabel}>Opening your passbook</div></div>;

  const { txns, categories, accounts, rules } = data;
  const { catMap, accMap, monthTxns, out, income, moved, net, byCat,
          active, present, people, owedToYou, youOwe, debtTotal,
          compare, recurring, todo } = view;

  const saveTxn = async (edited) => {
    setBusy(true);
    const r = await fetch("/api/transactions", {
      method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(edited),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return flash(body.error || "Could not save that change");
    setSel(null);
    flash(body.alsoFixed ? `Saved · ${body.alsoFixed} similar entries filed too` : "Saved");
    load();
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

  const fileMany = async ({ ids, category_id, remember, merchant, label }) => {
    setBusy(true);
    const r = await fetch("/api/bulk", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ ids, category_id, remember, merchant, label }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { flash(body.error || "Could not file those"); return false; }
    setUndo({ id: body.undoId, label: label || `Filed ${body.updated} entries` });
    await load();
    return true;
  };

  const removeDupes = async () => {
    setBusy(true);
    const r = await fetch("/api/dedupe", { method: "POST" });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return flash(body.error || "Could not clean those up");
    setShowDupes(false);
    setUndo({ id: body.undoId, label: `Removed ${body.removed} duplicates` });
    flash(`Removed ${body.removed}`);
    await load(); checkDupes();
  };

  const undoLast = async () => {
    const r = await fetch("/api/bulk", {
      method: "DELETE", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ undoId: undo?.id }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { flash(body.error || "Nothing to undo"); setUndo(null); return; }
    flash(`Put ${body.restored} back`); setUndo(null); load();
  };

  // Returns the created category so the caller can select it straight away.
  const createCategory = async (payload) => {
    const r = await fetch("/api/categories", {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { flash(body.error || "Could not create that"); return null; }
    flash(`“${body.name}” added`);
    await load();
    return body;
  };

  const editCategory = async (payload) => {
    const r = await fetch("/api/categories", {
      method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { flash(body.error || "Could not save that"); return false; }
    flash("Saved"); await load(); return true;
  };

  const deleteCategory = async (id) => {
    const r = await fetch("/api/categories", {
      method: "DELETE", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return flash(body.error || "Could not delete that");
    flash(body.moved ? `Deleted · ${body.moved} moved to Uncategorised` : "Deleted");
    load();
  };

  // Cash lending never reaches a bank feed, so it has to be recordable by hand.
  const addLending = async ({ person, amount, type, merchant, date }) => {
    const r = await fetch("/api/transactions", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        type, amount, date: date || dayOf(new Date().toISOString()),
        merchant: merchant || person, category_id: "people", person,
        source: "manual", raw: "",
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return flash(body.error || "Could not record that");
    flash("Recorded"); load();
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
    setDraft(null); setBlob("");
    flash(body.duplicates
      ? `${body.added} added · ${body.duplicates} skipped as duplicates`
      : `${body.added} entries added`);
    load(); checkDupes(); setTab("log");
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
                {compare.hasPrev && (
                  <> · <span style={{color: compare.delta > 0 ? "#EF6F63" : "#4BB6A8"}}>
                    {compare.delta > 0 ? "▲" : "▼"} {inr(Math.abs(compare.delta), true)}
                  </span> vs {fmtMonth(compare.prev)}</>
                )}
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

            {dupes?.extra > 0 && (
              <button style={S.nudge} onClick={()=>setShowDupes(true)}>
                <span style={{fontSize:20}}>⧉</span>
                <span style={{flex:1, textAlign:"left"}}>
                  <b>{dupes.extra} duplicate entries</b> worth {inr(dupes.value, true)}.
                  <br/><span style={S.small}>Same transaction imported more than once — your totals are overstated.</span>
                </span>
                <span style={{color:"#F2C14E"}}>›</span>
              </button>
            )}

            {todo.length > 0 && (
              <button style={S.nudge} onClick={()=>setShowTidy(true)}>
                <span style={{fontSize:20}}>🧹</span>
                <span style={{flex:1, textAlign:"left"}}>
                  <b>{todo.reduce((s,x)=>s+x.count,0)} entries</b> aren't sorted yet, worth {inr(todo.reduce((s,x)=>s+x.total,0), true)}.
                  <br/><span style={S.small}>Sort them by merchant — {todo.length} decisions clears the lot.</span>
                </span>
                <span style={{color:"#F2C14E"}}>›</span>
              </button>
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
                {byCat.map(c => {
                  const budget = Number(c.budget) || 0;
                  const pct = budget ? Math.min(100, (c.value / budget) * 100) : 0;
                  const over = budget && c.value > budget;
                  return (
                    <div key={c.id} style={{marginTop:10}}>
                      <div style={S.catLine}>
                        <span>{c.icon} {c.name}</span>
                        <span style={{color: over ? "#EF6F63" : "#E8EDF5"}}>
                          {inr(c.value, true)}{budget ? ` / ${inr(budget, true)}` : ""}
                        </span>
                      </div>
                      {budget > 0 && (
                        <div style={S.barTrack}>
                          <div style={{...S.barFill, width:`${pct}%`, background: over ? "#EF6F63" : c.color || "#4BB6A8"}} />
                        </div>
                      )}
                    </div>
                  );
                })}
                <button style={S.btnGhost} onClick={()=>setShowCats(true)}>Set budgets</button>
              </div>
            )}

            {recurring.length > 0 && (
              <div style={S.card}>
                <div style={S.cardHead}>Repeating charges</div>
                <p style={S.small}>
                  {inr(recurring.reduce((s,r)=>s+r.amount,0))} a month · {inr(recurring.reduce((s,r)=>s+r.yearly,0))} a year
                </p>
                {recurring.slice(0, 8).map(r => (
                  <button key={r.key} style={S.row} onClick={()=>{ setTab("log"); setSearch(r.merchant); }}>
                    <span style={{...S.chip, background:(catMap[r.category_id]?.color||"#666")+"22", color:catMap[r.category_id]?.color||"#666"}}>
                      {catMap[r.category_id]?.icon || "🔁"}
                    </span>
                    <div style={{flex:1, minWidth:0, textAlign:"left"}}>
                      <div style={{fontSize:14, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{r.merchant}</div>
                      <div style={S.small}>
                        {r.count}× · last {fmtDay(r.last)}
                        {r.dormant && <span style={{color:"#F2C14E"}}> · nothing for {r.sinceLast} days</span>}
                      </div>
                    </div>
                    <span style={{whiteSpace:"nowrap"}}>{inr(r.amount, true)}</span>
                  </button>
                ))}
                {recurring.some(r=>r.dormant) && (
                  <p style={{...S.small, marginTop:10}}>
                    Charges that have gone quiet are worth checking — either they stopped, or they are about to reappear.
                  </p>
                )}
              </div>
            )}
            <div style={S.card}>
              <div style={{...S.cardHead, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                <span>Latest</span>
                <button style={S.linkBtn} onClick={()=>setShowCats(true)}>Categories</button>
              </div>
              {monthTxns.slice(0,8).map(t => <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]} kind={kindOf(t, catMap)} onOpen={()=>setSel(t)} />)}
              {monthTxns.length === 0 && <div style={S.empty}>Nothing logged yet. Import bank messages to start.</div>}
            </div>
          </>
        )}

        {tab === "log" && (
          <div style={{padding:"12px 16px"}}>
            <div style={S.searchWrap}>
              <input style={S.input} value={search} onChange={e=>{setSearch(e.target.value); setVisible(200);}}
                placeholder="Search name, note, amount or bank text" />
              {search && <button style={S.clearBtn} onClick={()=>setSearch("")}>×</button>}
            </div>
            <div style={S.filterRow}>
              {[["all","All"],["expense","Spending"],["income","Income"],["transfer","Transfers"]].map(([id,label])=>(
                <button key={id} onClick={()=>{setKindFilter(id); setVisible(200);}}
                  style={{...S.filterChip, ...(kindFilter===id ? S.filterChipOn : null)}}>{label}</button>
              ))}
            </div>
            <select style={{...S.input, marginBottom:12}} value={catFilter}
              onChange={e=>{setCatFilter(e.target.value); setVisible(200);}}>
              <option value="all">Every category</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
            {(() => {
              const q = search.trim().toLowerCase();
              const shown = txns.filter(t => {
                if (kindFilter !== "all" && kindOf(t, catMap) !== kindFilter) return false;
                if (catFilter !== "all" && t.category_id !== catFilter) return false;
                if (!q) return true;
                // Searching the original bank text too, since the tidied-up
                // merchant name often drops the detail worth searching for.
                return [t.merchant, t.note, t.person, t.raw, catMap[t.category_id]?.name, String(t.amount)]
                  .some(v => (v || "").toLowerCase().includes(q));
              });
              const stat = summarise(shown);
              const filtered = q || kindFilter !== "all" || catFilter !== "all";
              return (
                <>
                  {stat && filtered && (
                    <div style={S.insight}>
                      <div style={S.insightTop}>
                        <div>
                          <div style={S.insightBig}>{inr(stat.total)}</div>
                          <div style={S.small}>
                            {stat.count} {stat.count === 1 ? "entry" : "entries"} · {inr(stat.average)} each
                          </div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={S.insightBig}>{inr(stat.perMonthAverage)}</div>
                          <div style={S.small}>a month</div>
                        </div>
                      </div>
                      <div style={S.small}>
                        {fmtDay(stat.first)} → {fmtDay(stat.last)} · biggest {inr(stat.biggest.amount)} on {fmtDay(stat.biggest.date)}
                      </div>
                      {stat.months.length > 1 && <MonthBars months={stat.months} />}
                      {q && shown.length > 1 && (
                        <button style={{...S.btnGhost, marginTop:10}} onClick={()=>setBulk(shown)}>
                          File all {shown.length} together
                        </button>
                      )}
                    </div>
                  )}
                  {!stat && (
                    <div style={S.resultBar}>
                      <span>{shown.length} entries</span><span>{inr(0)}</span>
                    </div>
                  )}
                  {!shown.length && <div style={S.empty}>Nothing matches that.</div>}
                  {shown.slice(0, visible).map(t => (
                    <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]}
                      kind={kindOf(t, catMap)} onOpen={()=>setSel(t)} />
                  ))}
                  {shown.length > visible && (
                    <button style={S.btnGhost} onClick={()=>setVisible(v=>v+200)}>
                      Show more ({shown.length - visible} left)
                    </button>
                  )}
                </>
              );
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
            <LendForm people={people} onAdd={addLending} />
            {people.length === 0 && (
              <p style={S.help}>
                Nothing tracked yet. Record a loan above, or open any transaction and set its
                category to <b>Lent / Borrowed</b> — balances build up from either.
              </p>
            )}
            {people.map(p => {
              const entries = txns.filter(t => (t.person||"").trim() === p.name);
              const open = openPerson === p.name;
              return (
                <div key={p.name}>
                  <button style={S.row} onClick={()=>setOpenPerson(open ? null : p.name)}>
                    <span style={{...S.chip, background:"#C98A5E22", color:"#C98A5E"}}>🤝</span>
                    <div style={{flex:1, minWidth:0, textAlign:"left"}}>
                      <div style={{fontSize:14}}>{p.name}</div>
                      <div style={S.small}>
                        {p.balance > 0 ? "owes you" : "you owe them"} · {entries.length} {entries.length===1?"entry":"entries"}
                      </div>
                    </div>
                    <span style={{color: p.balance > 0 ? "#4BB6A8" : "#EF6F63", whiteSpace:"nowrap"}}>
                      {inr(p.balance).slice(1)}
                    </span>
                  </button>
                  {open && (
                    <div style={S.personBody}>
                      {entries.map(t => (
                        <Row key={t.id} t={t} cat={catMap[t.category_id]} acc={accMap[t.account_id]}
                          kind={kindOf(t, catMap)} onOpen={()=>setSel(t)} />
                      ))}
                      <button style={S.btnGhost} onClick={()=>addLending({
                        person: p.name, amount: Math.abs(p.balance),
                        type: p.balance > 0 ? "credit" : "debit",
                        merchant: p.balance > 0 ? `Settled up with ${p.name}` : `Repaid ${p.name}`,
                      })}>
                        Settle up — record {inr(Math.abs(p.balance))} {p.balance > 0 ? "received" : "paid"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

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
            <p style={S.help}>
              Whatever your bank gives you — CSV, Excel, or the older .xls. Columns are detected
              automatically, and the file is read by its contents rather than its name.
            </p>
            <input ref={fileRef} type="file" style={{display:"none"}}
              accept=".csv,.xls,.xlsx,.xlsm,.txt,.tsv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

            <div style={{marginTop:28}}>
              <div style={S.cardHead}>Your data</div>
              <p style={S.help}>
                Download everything as a spreadsheet — every transaction with its category,
                person and the original bank text. Worth keeping a copy somewhere of your own.
              </p>
              <a href="/api/export" style={{...S.btnSecondary, display:"block", textAlign:"center", textDecoration:"none", marginTop:10}}>
                Export CSV
              </a>
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
        <DetailSheet txn={sel} categories={categories} accMap={accMap} txns={txns} busy={busy}
          onClose={()=>setSel(null)} onSave={saveTxn} onDelete={deleteTxn}
          onCreateCategory={createCategory} />
      )}
      {showCats && (
        <CategorySheet categories={categories} txns={txns} busy={busy}
          onClose={()=>setShowCats(false)} onCreate={createCategory}
          onEdit={editCategory} onDelete={deleteCategory} />
      )}
      {showTidy && (
        <TidySheet items={todo} categories={categories} busy={busy}
          onClose={()=>setShowTidy(false)} onSkip={()=>{}}
          onFile={(item, category_id, remember) => fileMany({
            ids: item.ids, category_id, remember, merchant: item.merchant,
            label: `Filed ${item.count} from ${item.merchant}`,
          })} />
      )}
      {bulk && (
        <BulkSheet rows={bulk} categories={categories} busy={busy}
          onClose={()=>setBulk(null)}
          onFile={async (category_id) => {
            const ok = await fileMany({
              ids: bulk.map(t=>t.id), category_id,
              label: `Filed ${bulk.length} entries`,
            });
            if (ok) setBulk(null);
          }} />
      )}
      {showDupes && dupes && (
        <Sheet title="Duplicate entries" onClose={()=>setShowDupes(false)}
          footer={
            <>
              <button style={S.btnPrimary} disabled={busy} onClick={removeDupes}>
                {busy ? "Cleaning…" : `Remove ${dupes.extra} duplicates`}
              </button>
              <p style={{...S.hint, textAlign:"center", marginTop:6}}>You can undo this straight after.</p>
            </>
          }>
          <p style={S.help}>
            {dupes.extra} entries appear more than once, worth {inr(dupes.value)} in total —
            almost always the same statement imported twice. The earliest copy of each is kept.
          </p>
          <div style={{...S.cardHead, marginTop:16}}>Largest</div>
          {dupes.sample.map((s,i) => (
            <div key={i} style={S.row}>
              <span style={{...S.chip, background:"#EF6F6322", color:"#EF6F63"}}>⧉</span>
              <div style={{flex:1, minWidth:0, textAlign:"left"}}>
                <div style={{fontSize:14, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{s.merchant}</div>
                <div style={S.small}>{fmtDay(s.date)} · {s.copies} copies</div>
              </div>
              <span style={{whiteSpace:"nowrap"}}>{inr(s.amount, true)}</span>
            </div>
          ))}
        </Sheet>
      )}
      {undo && (
        <div style={S.undoBar}>
          <span style={{flex:1}}>{undo.label}</span>
          <button style={S.linkBtn} onClick={undoLast}>Undo</button>
          <button style={{...S.linkBtn, color:"#8494AC"}} onClick={()=>setUndo(null)}>×</button>
        </div>
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
function DetailSheet({ txn, categories, accMap, txns, busy, onClose, onSave, onDelete, onCreateCategory }) {
  const [making, setMaking] = useState(false);
  const [form, setForm] = useState({
    id: txn.id, amount: String(txn.amount), type: txn.type,
    merchant: txn.merchant || "", note: txn.note || "",
    category_id: txn.category_id || "other", person: txn.person || "",
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [applyAll, setApplyAll] = useState(true);

  // How much backlog this one decision would clear.
  const similar = useMemo(() => {
    const name = (form.merchant || "").trim().toLowerCase();
    if (!name || name === "unknown") return 0;
    return txns.filter(x => x.id !== txn.id &&
      (x.merchant || "").toLowerCase() === name &&
      ["other","income"].includes(x.category_id)).length;
  }, [txns, form.merchant, txn.id]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const cat = categories.find(c => c.id === form.category_id);

  return (
    <Sheet
      title={`${fmtDay(txn.date)}${txn.time ? ` · ${txn.time}` : ""} · ${accMap[txn.account_id]?.name || txn.source || ""}`}
      onClose={onClose}
      footer={
        <>
          <button style={S.btnPrimary} disabled={busy}
            onClick={()=>onSave({ ...form, amount: Number(form.amount), applyToSimilar: applyAll })}>
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
        </>
      }>
      <div>
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
          <select style={S.input} value={form.category_id}
            onChange={e => e.target.value === "__new__" ? setMaking(true) : set("category_id", e.target.value)}>
            {["expense","income","transfer"].map(group => (
              <optgroup key={group} label={group === "expense" ? "Spending" : group === "income" ? "Money in" : "Not spending"}>
                {categories.filter(c=>c.kind===group).map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </optgroup>
            ))}
            <option value="__new__">+ New category…</option>
          </select>
          <span style={S.hint}>
            {cat?.kind === "transfer" && "Won't count as spending — money you still own."}
            {cat?.kind === "income" && "Counts as money in."}
            {cat?.kind === "expense" && "Counts as spending."}
          </span>
        </label>

        {making && (
          <NewCategory
            onCancel={()=>setMaking(false)}
            onCreate={async (payload) => {
              const created = await onCreateCategory(payload);
              if (created) { set("category_id", created.id); setMaking(false); }
            }}
          />
        )}

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

        {similar > 0 && (
          <label style={S.remember}>
            <input type="checkbox" checked={applyAll} onChange={e=>setApplyAll(e.target.checked)} />
            <span>Remember this — also file the {similar} other unsorted {similar === 1 ? "entry" : "entries"} from “{form.merchant}”</span>
          </label>
        )}

      </div>
    </Sheet>
  );
}

// One sheet shell for every panel. The header and the action stay put while
// only the middle scrolls - previously the whole sheet was one scrolling box,
// so a long list carried the close button off the top of the screen and the
// button at the bottom out of reach. Heights are measured against the overlay,
// which is pinned to the viewport, rather than in vh units that iOS reports
// larger than the area actually visible.
function Sheet({ title, onClose, closeLabel = "Close", footer, children }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.sheet} onClick={e => e.stopPropagation()}>
        <div style={S.sheetTop}>
          <div style={S.sheetGrab} />
          <div style={S.sheetHead}>
            <span>{title}</span>
            <button style={S.linkBtn} onClick={onClose}>{closeLabel}</button>
          </div>
        </div>
        <div style={S.sheetBody}>{children}</div>
        {footer && <div style={S.sheetFoot}>{footer}</div>}
      </div>
    </div>
  );
}

// A month-by-month shape for whatever is being looked at - a single total
// hides whether something is steady, rising, or a one-off.
function MonthBars({ months }) {
  const peak = Math.max(...months.map(m => m.total)) || 1;
  const show = months.slice(-12);
  return (
    <div style={S.bars}>
      {show.map(m => (
        <div key={m.month} style={S.barCol} title={`${m.month}: ${inr(m.total)}`}>
          <div style={S.barSlot}>
            <div style={{...S.bar, height:`${Math.max(3, (m.total / peak) * 100)}%`}} />
          </div>
          <span style={S.barLabel}>{MONTHS[+m.month.split("-")[1] - 1][0]}</span>
        </div>
      ))}
    </div>
  );
}

const ICONS = ["🏷️","🍜","🛒","🚗","🏠","💊","🎓","🐾","👶","💇","🎁","🔧","📱","✈️","🏋️","🙏","💼","🎨","☕","🍺"];
const COLORS = ["#EF6F63","#7FA05A","#5B9BD5","#F2C14E","#D9569E","#9B7FD4","#4BB6A8","#C98A5E"];

// Choosing the type is the only decision here that changes any number, so it
// is asked in terms of what happens to the money, not in accounting words.
function NewCategory({ onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏷️");
  const [color, setColor] = useState("#6B7A93");
  const [kind, setKind] = useState("expense");

  return (
    <div style={S.maker}>
      <span style={S.fieldLabel}>New category</span>
      <input style={{...S.input, marginBottom:8}} autoFocus placeholder="Name" value={name} onChange={e=>setName(e.target.value)} />

      <div style={S.pickRow}>
        {ICONS.map(i => (
          <button key={i} onClick={()=>setIcon(i)}
            style={{...S.pick, ...(icon===i ? S.pickOn : null)}}>{i}</button>
        ))}
      </div>
      <div style={S.pickRow}>
        {COLORS.map(c => (
          <button key={c} onClick={()=>setColor(c)} aria-label={c}
            style={{...S.swatch, background:c, outline: color===c ? "2px solid #E8EDF5" : "none"}} />
        ))}
      </div>

      <select style={{...S.input, marginBottom:6}} value={kind} onChange={e=>setKind(e.target.value)}>
        <option value="expense">Spending — money is gone</option>
        <option value="income">Money in — new money arrived</option>
        <option value="transfer">Not spending — money you still own</option>
      </select>
      <span style={S.hint}>
        {kind === "expense" && "Counts towards what you spent."}
        {kind === "income" && "Counts towards money in."}
        {kind === "transfer" && "Kept out of both totals — for moving money around, lending, or saving."}
      </span>

      <div style={{display:"flex", gap:8, marginTop:10}}>
        <button style={{...S.btnPrimary, flex:1}} disabled={!name.trim()}
          onClick={()=>onCreate({ name: name.trim(), icon, color, kind })}>Create</button>
        <button style={{...S.btnGhost, flex:1, marginTop:0}} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Works through the merchants clogging Uncategorised, worst first, filing a
// whole merchant in one decision instead of a row at a time.
function TidySheet({ items, categories, busy, onClose, onFile, onSkip }) {
  const [i, setI] = useState(0);
  const [cat, setCat] = useState("");
  const [remember, setRemember] = useState(true);
  const item = items[i];

  if (!item) {
    return (
      <Sheet title="All sorted" onClose={onClose} closeLabel="Done"
        footer={<button style={S.btnPrimary} onClick={onClose}>Done</button>}>
        <div style={{textAlign:"center", padding:"26px 0"}}>
          <div style={{fontSize:34}}>✓</div>
          <div style={{marginTop:10}}>Nothing left to sort.</div>
        </div>
      </Sheet>
    );
  }

  const remaining = items.length - i;
  return (
    <Sheet
      title={`${remaining} ${remaining === 1 ? "merchant" : "merchants"} left`}
      onClose={onClose}
      footer={
        <>
          <button style={S.btnPrimary} disabled={!cat || busy}
            onClick={async () => {
              const ok = await onFile(item, cat, remember);
              if (ok) { setCat(""); setI(n => n + 1); }
            }}>
            {busy ? "Filing…" : `File all ${item.count}`}
          </button>
          <button style={S.btnGhost} onClick={()=>{ setCat(""); onSkip(); setI(n=>n+1); }}>Skip for now</button>
        </>
      }>
      <div>
        <div style={S.tidyName}>{item.merchant}</div>
        <div style={S.small}>
          {item.count} {item.count === 1 ? "entry" : "entries"} · {inr(item.total)} total · last {fmtDay(item.lastDate)}
        </div>
        {item.sample && <div style={{...S.rawBox, marginTop:10}}>{item.sample}</div>}

        <select style={{...S.input, marginTop:14}} value={cat} onChange={e=>setCat(e.target.value)}>
          <option value="">Choose a category…</option>
          {["expense","income","transfer"].map(group => (
            <optgroup key={group} label={group === "expense" ? "Spending" : group === "income" ? "Money in" : "Not spending"}>
              {categories.filter(c=>c.kind===group).map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <label style={{...S.remember, marginTop:10}}>
          <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} />
          <span>Remember, so future entries from “{item.merchant}” file themselves</span>
        </label>
      </div>
    </Sheet>
  );
}

// Files everything currently matching a search in one go.
function BulkSheet({ rows, categories, busy, onClose, onFile }) {
  const [cat, setCat] = useState("");
  const total = rows.reduce((s,t)=>s+Number(t.amount),0);
  return (
    <Sheet title={`File ${rows.length} entries`} onClose={onClose} closeLabel="Cancel"
      footer={
        <button style={S.btnPrimary} disabled={!cat || busy} onClick={()=>onFile(cat)}>
          {busy ? "Filing…" : `File all ${rows.length}`}
        </button>
      }>
      <p style={S.small}>{inr(total)} in total, from {fmtDay(rows[rows.length-1].date)} to {fmtDay(rows[0].date)}.</p>
      <select style={{...S.input, marginTop:12}} value={cat} onChange={e=>setCat(e.target.value)}>
        <option value="">Choose a category…</option>
        {["expense","income","transfer"].map(group => (
          <optgroup key={group} label={group === "expense" ? "Spending" : group === "income" ? "Money in" : "Not spending"}>
            {categories.filter(c=>c.kind===group).map(c => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <p style={S.hint}>You can undo this straight after.</p>
    </Sheet>
  );
}

// Rename, recolour, or remove what already exists.
function CategorySheet({ categories, txns, busy, onClose, onCreate, onEdit, onDelete }) {
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const counts = useMemo(() => {
    const m = {};
    txns.forEach(t => { m[t.category_id] = (m[t.category_id] || 0) + 1; });
    return m;
  }, [txns]);

  return (
    <Sheet title="Categories" onClose={onClose} closeLabel="Done">
      <div>
        {making
          ? <NewCategory onCancel={()=>setMaking(false)} onCreate={async p => { if (await onCreate(p)) setMaking(false); }} />
          : <button style={{...S.btnGhost, marginTop:0, marginBottom:12}} onClick={()=>setMaking(true)}>+ New category</button>}

        {["expense","income","transfer"].map(group => (
          <div key={group}>
            <div style={{...S.cardHead, marginTop:14}}>
              {group === "expense" ? "Spending" : group === "income" ? "Money in" : "Not spending"}
            </div>
            {categories.filter(c=>c.kind===group).map(c => (
              <div key={c.id}>
                {editing === c.id ? (
                  <EditCategory cat={c} busy={busy} onCancel={()=>setEditing(null)}
                    onSave={async p => { if (await onEdit(p)) setEditing(null); }} />
                ) : (
                  <div style={S.row}>
                    <span style={{...S.chip, background:(c.color||"#666")+"22", color:c.color||"#666"}}>{c.icon}</span>
                    <div style={{flex:1, minWidth:0, textAlign:"left"}}>
                      <div style={{fontSize:14}}>{c.name}</div>
                      <div style={S.small}>
                        {counts[c.id] || 0} {counts[c.id] === 1 ? "entry" : "entries"}
                        {!c.custom && " · built in"}
                      </div>
                    </div>
                    <button style={S.linkBtn} onClick={()=>setEditing(c.id)}>Edit</button>
                    {c.custom && (confirm === c.id
                      ? <button style={{...S.linkBtn, color:"#EF6F63"}} onClick={()=>{ onDelete(c.id); setConfirm(null); }}>Sure?</button>
                      : <button style={{...S.linkBtn, color:"#8494AC"}} onClick={()=>setConfirm(c.id)}>Delete</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <p style={{...S.help, marginTop:16}}>
          Deleting a category moves its entries to Uncategorised — nothing is lost.
          Built-in categories can be renamed but keep their type, since the totals depend on it.
        </p>
      </div>
    </Sheet>
  );
}

function EditCategory({ cat, busy, onCancel, onSave }) {
  const [name, setName] = useState(cat.name);
  const [icon, setIcon] = useState(cat.icon || "🏷️");
  const [color, setColor] = useState(cat.color || "#6B7A93");
  const [kind, setKind] = useState(cat.kind);
  const [budget, setBudget] = useState(Number(cat.budget) ? String(Number(cat.budget)) : "");

  return (
    <div style={S.maker}>
      <input style={{...S.input, marginBottom:8}} value={name} onChange={e=>setName(e.target.value)} />
      <div style={S.pickRow}>
        {ICONS.map(i => <button key={i} onClick={()=>setIcon(i)} style={{...S.pick, ...(icon===i ? S.pickOn : null)}}>{i}</button>)}
      </div>
      <div style={S.pickRow}>
        {COLORS.map(c => <button key={c} onClick={()=>setColor(c)} aria-label={c}
          style={{...S.swatch, background:c, outline: color===c ? "2px solid #E8EDF5" : "none"}} />)}
      </div>
      {cat.custom && (
        <select style={{...S.input, marginBottom:6}} value={kind} onChange={e=>setKind(e.target.value)}>
          <option value="expense">Spending</option>
          <option value="income">Money in</option>
          <option value="transfer">Not spending</option>
        </select>
      )}
      {kind === "expense" && (
        <>
          <input style={S.input} inputMode="decimal" placeholder="Monthly budget (optional)"
            value={budget} onChange={e=>setBudget(e.target.value)} />
          <span style={S.hint}>Shows a bar on Summary and turns red when the month goes over.</span>
        </>
      )}
      <div style={{display:"flex", gap:8, marginTop:8}}>
        <button style={{...S.btnPrimary, flex:1}} disabled={busy || !name.trim()}
          onClick={()=>onSave({ id: cat.id, name: name.trim(), icon, color, kind, budget: Number(budget) || 0 })}>Save</button>
        <button style={{...S.btnGhost, flex:1, marginTop:0}} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function LendForm({ people, onAdd }) {
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [dir, setDir] = useState("debit");

  if (!open) return <button style={S.btnGhost} onClick={()=>setOpen(true)}>+ Record lending or borrowing</button>;
  const ready = person.trim() && Number(amount) > 0;
  return (
    <div style={{...S.slip, flexDirection:"column", gap:8}}>
      <input style={S.input} placeholder="Name" value={person} list="known-people"
        onChange={e=>setPerson(e.target.value)} />
      <datalist id="known-people">
        {people.map(p => <option key={p.name} value={p.name} />)}
      </datalist>
      <input style={S.input} inputMode="decimal" placeholder="Amount" value={amount} onChange={e=>setAmount(e.target.value)} />
      <select style={S.input} value={dir} onChange={e=>setDir(e.target.value)}>
        <option value="debit">I gave them money</option>
        <option value="credit">They gave me money</option>
      </select>
      <span style={S.hint}>
        {dir === "debit"
          ? "Adds to what they owe you, or reduces what you owe them."
          : "Adds to what you owe them, or reduces what they owe you."}
      </span>
      <div style={{display:"flex", gap:8, width:"100%"}}>
        <button style={{...S.btnPrimary, flex:1}} disabled={!ready}
          onClick={()=>{
            onAdd({ person: person.trim(), amount: Number(amount), type: dir,
                    merchant: dir === "debit" ? `Gave ${person.trim()}` : `Got from ${person.trim()}` });
            setPerson(""); setAmount(""); setOpen(false);
          }}>Record</button>
        <button style={{...S.btnGhost, flex:1, marginTop:0}} onClick={()=>setOpen(false)}>Cancel</button>
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
  // Pinned to the viewport and clipped, so the sheet inside can never grow
  // past what is actually on screen. Top inset keeps it clear of the notch.
  overlay: { position:"fixed", inset:0, background:"#00000088", display:"flex", alignItems:"flex-end",
             zIndex:20, overflow:"hidden", paddingTop:"calc(24px + env(safe-area-inset-top))" },
  sheet: { width:"100%", maxHeight:"100%", display:"flex", flexDirection:"column", minHeight:0,
           background:"#141B29", borderTopLeftRadius:18, borderTopRightRadius:18,
           border:"1px solid #2A3549", overflow:"hidden" },
  sheetTop: { flexShrink:0, padding:"8px 16px 0", borderBottom:"1px solid #2A3549" },
  sheetBody: { flex:1, minHeight:0, overflowY:"auto", WebkitOverflowScrolling:"touch", padding:"14px 16px" },
  sheetFoot: { flexShrink:0, padding:"10px 16px calc(12px + env(safe-area-inset-bottom))",
               borderTop:"1px solid #2A3549", background:"#141B29" },
  sheetGrab: { width:38, height:4, borderRadius:2, background:"#2A3549", margin:"2px auto 10px" },
  sheetHead: { display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12, color:"#8494AC", marginBottom:10 },
  field: { display:"block", marginBottom:12 },
  fieldLabel: { display:"block", fontSize:10, color:"#8494AC", textTransform:"uppercase", letterSpacing:0.4, marginBottom:5 },
  input: { width:"100%", background:"#171F2E", border:"1px solid #2A3549", borderRadius:10, color:"#E8EDF5", padding:11, fontSize:15, boxSizing:"border-box" },
  hint: { display:"block", fontSize:11, color:"#8494AC", marginTop:5, lineHeight:1.5 },
  rawBox: { background:"#0E1420", border:"1px solid #2A3549", borderRadius:10, padding:11, fontSize:11,
            color:"#8494AC", fontFamily:"monospace", lineHeight:1.6, wordBreak:"break-word" },
  btnGhost: { width:"100%", background:"none", border:"1px solid #2A3549", color:"#8494AC", borderRadius:12, padding:12, fontSize:14, marginTop:8 },
  confirmRow: { display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:10 },
  remember: { display:"flex", gap:9, alignItems:"flex-start", background:"#171F2E", border:"1px solid #2A3549",
              borderRadius:10, padding:11, fontSize:12, color:"#8494AC", lineHeight:1.5, marginBottom:4 },
  barTrack: { width:"100%", height:5, background:"#0E1420", borderRadius:3, overflow:"hidden" },
  searchWrap: { position:"relative", marginBottom:10 },
  clearBtn: { position:"absolute", right:6, top:"50%", transform:"translateY(-50%)", background:"none",
              border:"none", color:"#8494AC", fontSize:20, padding:"0 8px" },
  resultBar: { display:"flex", justifyContent:"space-between", fontSize:11, color:"#8494AC",
               padding:"0 0 8px", borderBottom:"1px solid #2A354980", marginBottom:4 },
  personBody: { paddingLeft:12, borderLeft:"2px solid #C98A5E44", marginLeft:14, marginBottom:10 },
  maker: { background:"#171F2E", border:"1px solid #2A3549", borderRadius:12, padding:12, marginBottom:12 },
  pickRow: { display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 },
  pick: { width:34, height:34, borderRadius:9, background:"#0E1420", border:"1px solid #2A3549", fontSize:16, padding:0 },
  pickOn: { borderColor:"#F2C14E", background:"#F2C14E22" },
  swatch: { width:26, height:26, borderRadius:"50%", border:"none", padding:0 },
  insight: { background:"#171F2E", border:"1px solid #2A3549", borderRadius:12, padding:12, marginBottom:12 },
  insightTop: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 },
  insightBig: { fontSize:20, fontWeight:500 },
  bars: { display:"flex", alignItems:"flex-end", gap:4, height:52, marginTop:12 },
  barCol: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 },
  barSlot: { width:"100%", height:38, display:"flex", alignItems:"flex-end" },
  bar: { width:"100%", background:"#F2C14E", borderRadius:2, minHeight:2 },
  barLabel: { fontSize:9, color:"#8494AC" },
  nudge: { display:"flex", alignItems:"center", gap:11, width:"100%", background:"#171F2E",
           border:"1px solid #2A3549", borderRadius:12, padding:13, margin:"14px 16px 0", width:"calc(100% - 32px)",
           color:"#E8EDF5", fontSize:13, lineHeight:1.5, textAlign:"left" },
  catLine: { display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:5 },
  tidyName: { fontSize:19, fontWeight:500, marginBottom:4, wordBreak:"break-word" },
  undoBar: { position:"fixed", left:12, right:12, bottom:"calc(64px + env(safe-area-inset-bottom))",
             background:"#212B3D", border:"1px solid #2A3549", borderRadius:11, padding:"10px 8px 10px 14px",
             display:"flex", alignItems:"center", gap:4, fontSize:12, zIndex:15 },
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
