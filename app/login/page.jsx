"use client";
import React, { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (r.ok) { window.location.href = "/"; return; }
    const body = await r.json().catch(() => ({}));
    setError(body.error || "Could not sign in");
    setPassword("");
  };

  return (
    <div style={S.wrap}>
      <form style={S.form} onSubmit={submit}>
        <div style={S.mark}>₹</div>
        <div style={S.title}>Spendbook</div>
        <input
          style={S.input} type="password" value={password} autoFocus
          onChange={e => setPassword(e.target.value)} placeholder="Password"
        />
        <button style={S.btn} disabled={busy || !password}>{busy ? "Checking…" : "Open passbook"}</button>
        {error && <div style={S.error}>{error}</div>}
      </form>
    </div>
  );
}

const S = {
  wrap: { position:"fixed", inset:0, background:"#0E1420", color:"#E8EDF5", fontFamily:"system-ui", display:"flex", alignItems:"center", justifyContent:"center", padding:20 },
  form: { width:"100%", maxWidth:300, display:"flex", flexDirection:"column", alignItems:"center" },
  mark: { fontSize:44, color:"#F2C14E" },
  title: { fontSize:13, color:"#8494AC", marginTop:4, marginBottom:22, textTransform:"uppercase", letterSpacing:1 },
  input: { width:"100%", background:"#171F2E", border:"1px solid #2A3549", borderRadius:11, color:"#E8EDF5", padding:13, fontSize:15, marginBottom:10 },
  btn: { width:"100%", background:"#F2C14E", color:"#141A12", border:"none", borderRadius:12, padding:14, fontWeight:600, fontSize:15 },
  error: { color:"#EF6F63", fontSize:13, marginTop:12 },
};
