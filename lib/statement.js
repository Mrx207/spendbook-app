// Bank statement parsing: turns a sheet of rows into transaction drafts.
// Banks all ship different column names and layouts, so headers are matched by
// pattern rather than position, and the header row itself is located by
// scanning - most exports carry several junk rows (account holder, address,
// period) before the real table starts.

import { uid, parseAnyDate } from "./parser.js";

const HEAD = {
  date: /\b(txn|transaction|value|posting|post|book|entry)?\s*date\b/i,
  desc: /narration|description|particular|remark|details|payee|transaction\s*info/i,
  debit: /\b(debit|withdrawal|withdrawl|withdraw|paid\s*out|money\s*out|dr)\b/i,
  credit: /\b(credit|deposit|paid\s*in|money\s*in|cr)\b/i,
  amount: /^\s*(amount|amt|transaction\s*amount)\s*$/i,
  balance: /balance/i,
  ref: /\b(ref(erence)?(\s*no)?|cheque|chq|utr|txn\s*id|transaction\s*id)\b/i,
  drcr: /^\s*(dr\s*\/?\s*cr|cr\s*\/?\s*dr|type|indicator)\s*$/i,
};

const cell = (v) => (v === null || v === undefined ? "" : String(v).trim());

// "1,234.56", "1234.56 Dr", "(1,234.56)" -> 1234.56. Returns null when the cell
// holds no usable figure, which is how empty debit/credit columns read.
export function parseNumber(raw) {
  let s = cell(raw);
  if (!s) return null;
  const negated = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/\b(dr|cr)\b/gi, "").replace(/[₹$€£]/g, "");
  s = s.replace(/,/g, "").trim();
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return negated ? -Math.abs(n) : n;
}

// Scores a row on how much it looks like a header rather than data.
function headerScore(row) {
  const joined = row.map(cell).join(" ");
  if (!joined.trim()) return 0;
  let score = 0;
  if (HEAD.date.test(joined)) score++;
  if (HEAD.desc.test(joined)) score++;
  if (HEAD.debit.test(joined) || HEAD.credit.test(joined) || HEAD.amount.test(joined)) score++;
  // Data rows carry numbers; header rows generally do not.
  const numeric = row.filter(c => parseNumber(c) !== null).length;
  if (numeric > 1) score -= 2;
  return score;
}

export function findHeader(rows) {
  let best = { index: -1, score: 0 };
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const score = headerScore(rows[i]);
    if (score > best.score) best = { index: i, score };
  }
  return best.score >= 2 ? best.index : -1;
}

export function mapColumns(header) {
  const cols = {};
  header.forEach((raw, i) => {
    const h = cell(raw);
    if (!h) return;
    // Most specific first: "closing balance" must not land in `credit` via /cr/.
    if (cols.balance === undefined && HEAD.balance.test(h)) { cols.balance = i; return; }
    if (cols.date === undefined && HEAD.date.test(h)) { cols.date = i; return; }
    if (cols.desc === undefined && HEAD.desc.test(h)) { cols.desc = i; return; }
    if (cols.drcr === undefined && HEAD.drcr.test(h)) { cols.drcr = i; return; }
    if (cols.debit === undefined && HEAD.debit.test(h)) { cols.debit = i; return; }
    if (cols.credit === undefined && HEAD.credit.test(h)) { cols.credit = i; return; }
    if (cols.amount === undefined && HEAD.amount.test(h)) { cols.amount = i; return; }
    if (cols.ref === undefined && HEAD.ref.test(h)) { cols.ref = i; return; }
  });
  return cols;
}

const NOISE_SEG = /^(upi|neft|imps|rtgs|ach|nach|pos|atm|ecs|chq|cheque|dr|cr|by|to|from|ref|txn|tpt|mmt|inb|onl|bil|billpay|payment|paytm|collect|p2a|p2m|na|null)$/i;

// Statement narrations are slash-delimited machine strings like
// "UPI/DR/451234567890/SWIGGY/YESB/swiggy@ybl/Payment". Pick the segment most
// likely to be a human-readable counterparty name.
export function merchantFromNarration(text) {
  const s = cell(text);
  if (!s) return "Unknown";
  const segs = s.split(/[\/|]+/).map(x => x.trim()).filter(Boolean);
  const candidates = segs.filter(x =>
    !NOISE_SEG.test(x) &&
    !/^\d+$/.test(x) &&
    /[A-Za-z]{3,}/.test(x)
  );
  if (!candidates.length) {
    const fallback = s.replace(/\s{2,}/g, " ").trim();
    return fallback.slice(0, 60) || "Unknown";
  }
  // A VPA (name@bank) names the payee more reliably than a bank code does.
  const vpa = candidates.find(x => /@/.test(x));
  const pick = vpa ? vpa.split("@")[0] : candidates.sort((a, b) => b.length - a.length)[0];
  return pick.replace(/[_.\-]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 60) || "Unknown";
}

/**
 * Convert raw sheet rows into transaction drafts.
 * Returns { txns, skipped, columns } - callers still categorise and dedupe.
 */
export function parseStatementRows(rows) {
  const headerIndex = findHeader(rows);
  if (headerIndex === -1) {
    return { txns: [], skipped: 0, columns: null, error: "Could not find a transaction table in that file" };
  }
  const columns = mapColumns(rows[headerIndex]);
  if (columns.date === undefined) {
    return { txns: [], skipped: 0, columns, error: "No date column found in that file" };
  }
  const hasAmountSource =
    columns.debit !== undefined || columns.credit !== undefined || columns.amount !== undefined;
  if (!hasAmountSource) {
    return { txns: [], skipped: 0, columns, error: "No amount column found in that file" };
  }

  const txns = [];
  let skipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.some(c => cell(c))) continue;

    const date = parseAnyDate(cell(row[columns.date]));
    if (!date) { skipped++; continue; }

    const debit = columns.debit !== undefined ? parseNumber(row[columns.debit]) : null;
    const credit = columns.credit !== undefined ? parseNumber(row[columns.credit]) : null;

    let type = null;
    let amount = null;

    if (debit && Math.abs(debit) > 0) { type = "debit"; amount = Math.abs(debit); }
    else if (credit && Math.abs(credit) > 0) { type = "credit"; amount = Math.abs(credit); }
    else if (columns.amount !== undefined) {
      const value = parseNumber(row[columns.amount]);
      if (value === null || value === 0) { skipped++; continue; }
      // Single-amount layouts carry direction in a Dr/Cr column, or in the sign.
      const flag = columns.drcr !== undefined ? cell(row[columns.drcr]) : "";
      if (/^c/i.test(flag)) type = "credit";
      else if (/^d/i.test(flag)) type = "debit";
      else type = value < 0 ? "debit" : "credit";
      amount = Math.abs(value);
    }

    if (!type || !amount) { skipped++; continue; }

    const narration = columns.desc !== undefined ? cell(row[columns.desc]) : "";
    const ref = columns.ref !== undefined ? cell(row[columns.ref]) : "";

    txns.push({
      id: uid(),
      type,
      amount,
      date,
      time: "",
      merchant: merchantFromNarration(narration),
      note: "",
      ref: ref && !/^0+$/.test(ref) ? ref.toUpperCase().slice(0, 25) : null,
      source: "statement",
      // Statements carry a running balance, which is what makes it possible to
      // tell later whether anything went missing between two rows.
      balance: columns.balance !== undefined ? parseNumber(row[columns.balance]) : null,
      raw: narration.slice(0, 300),
      fxAmount: null,
      fxCurrency: null,
      estimated: false,
    });
  }

  return { txns, skipped, columns };
}

// Minimal RFC4180-style CSV reader - handles quoted fields, escaped quotes,
// embedded newlines, and both CRLF and LF.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
