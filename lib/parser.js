// Core parsing logic. Same engine as the Spendbook artifact, ported for server use.

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const MON_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
const fullYear = (y) => (y < 100 ? (y > 70 ? 1900 + y : 2000 + y) : y);
const safeISO = (y, mo, d) => (!y || !mo || !d || mo > 12 || d > 31 ? null : `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
export const todayISO = () => isoOf(new Date());

export function parseAnyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m;
  m = s.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/); if (m) return safeISO(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[-\s/]?([A-Za-z]{3,4})[-\s/,]?\s?(\d{2,4})\b/);
  if (m && MON_MAP[m[2].toLowerCase()] !== undefined) return safeISO(fullYear(+m[3]), MON_MAP[m[2].toLowerCase()]+1, +m[1]);
  m = s.match(/\b([A-Za-z]{3,4})\s+(\d{1,2}),?\s+(\d{2,4})\b/);
  if (m && MON_MAP[m[1].toLowerCase()] !== undefined) return safeISO(fullYear(+m[3]), MON_MAP[m[1].toLowerCase()]+1, +m[2]);
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/); if (m) return safeISO(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/\b(\d{2})(\d{2})(\d{2})\b/); if (m && +m[1] <= 31 && +m[2] <= 12) return safeISO(fullYear(+m[3]), +m[2], +m[1]);
  const d = new Date(s); return isNaN(d) ? null : isoOf(d);
}

export function parseTime(s) {
  const m = String(s).match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[1]; const ap = (m[3]||"").toLowerCase();
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${m[2]}`;
}

const CUR_ALIAS = { "₹":"INR","rs":"INR","rs.":"INR","inr":"INR","$":"USD","us$":"USD","usd":"USD","€":"EUR","eur":"EUR","£":"GBP","gbp":"GBP","aed":"AED","sgd":"SGD","aud":"AUD","cad":"CAD","¥":"JPY","jpy":"JPY" };
const CUR_RE = /(₹|rs\.?|inr|us\$|usd|\$|eur|€|gbp|£|aed|sgd|aud|cad|jpy|¥)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(inr|usd|eur|gbp|aed|sgd|aud|cad|jpy)\b/gi;

export function extractMoney(t) {
  const out = []; let m; CUR_RE.lastIndex = 0;
  while ((m = CUR_RE.exec(t))) {
    const sym = (m[1]||m[4]||"").toLowerCase();
    const num = parseFloat((m[2]||m[3]||"").replace(/,/g,""));
    const cur = CUR_ALIAS[sym] || CUR_ALIAS[sym.replace(/\.$/,"")];
    if (cur && num > 0) out.push({ cur, val: num });
  }
  return out;
}

// INR figure from bank is truth. Foreign-only gets converted + card markup, flagged estimated.
export function settle(money, rates, markupPct) {
  const inrHit = money.find(x => x.cur === "INR");
  const fxHit = money.find(x => x.cur !== "INR");
  if (inrHit) return { amount: inrHit.val, fxAmount: fxHit?.val ?? null, fxCurrency: fxHit?.cur ?? null, estimated: false };
  if (fxHit) {
    const rate = rates[fxHit.cur] || 1;
    const gross = fxHit.val * rate * (1 + (markupPct||0)/100);
    return { amount: Math.round(gross*100)/100, fxAmount: fxHit.val, fxCurrency: fxHit.cur, estimated: true };
  }
  return null;
}

const DEBIT_WORDS = /\b(debited|debit|spent|withdrawn|withdrawal|paid|sent|deducted|purchase|charged|transferred to|trf to|used for)\b/i;
const CREDIT_WORDS = /\b(credited|credit(?!\s*card)|received|refund|deposited|reversal|cashback|salary)\b/i;
const NOISE = /\b(otp|one time password|will be|failed|declined|do not share|min due|reminder|offer|congratulations|eligible|pre-?approved)\b/i;

const extractAccountNo = (t) => { const m = t.match(/(?:a\/c|ac|acct|account|card)\s*(?:no\.?)?\s*(?:x+|\*+|ending(?:\s*in)?|-)?\s*(\d{3,6})\b/i); return m ? m[1].slice(-4) : null; };
export const extractRef = (t) => { const m = t.match(/(?:upi\s*)?(?:ref(?:erence)?(?:\s*no\.?)?|utr|txn\s*id|transaction\s*id|rrn)\s*[:#\-]?\s*([A-Za-z0-9]{6,25})/i); return m ? m[1].toUpperCase() : null; };

function instrumentHint(t) {
  if (/credit\s*card/i.test(t)) return "credit";
  if (/debit\s*card/i.test(t)) return "savings";
  if (/\b(wallet|paytm balance|amazon pay balance)\b/i.test(t)) return "wallet";
  if (/\b(a\/c|account|savings|salary account)\b/i.test(t)) return "savings";
  return null;
}

function extractMerchant(t) {
  const pats = [
    /\bto\s+vpa\s+([A-Za-z0-9@._\-]{3,40})/i, /\bvpa\s+([A-Za-z0-9@._\-]{3,40})/i,
    /\binfo[:\- ]+([A-Za-z0-9&'.,\-/ ]{3,40})/i, /\btowards\s+([A-Za-z0-9&'.,\- ]{3,40})/i,
    /\btrf\s+to\s+([A-Za-z0-9&'.,\- ]{3,40})/i, /\bat\s+([A-Za-z0-9&'.,\- ]{3,40}?)\s+(?:on|dated|for|\.|,|$)/i,
    /\bto\s+([A-Za-z0-9&'.,\- ]{3,40}?)\s+(?:on|dated|ref|upi|\.|,|$)/i,
    /\bfrom\s+([A-Za-z0-9&'.,\- ]{3,40}?)\s+(?:on|dated|ref|upi|\.|,|$)/i,
  ];
  for (const p of pats) { const m = t.match(p); if (m) {
    const v = m[1].trim().replace(/\b(a\/c|account|bank|ltd|limited|pvt|private|upi|ref|no)\b\.?/gi," ").replace(/[.\-_]+$/,"").replace(/\s{2,}/g," ").trim();
    if (v.length >= 3 && !/^\d+$/.test(v)) return v;
  }}
  const bank = t.match(/-\s*([A-Za-z ]{3,25}\s*bank)\s*$/i);
  return bank ? bank[1].trim() : null;
}

export function parseSMS(raw) {
  const t = String(raw).replace(/\s+/g," ").trim();
  if (t.length < 15) return null;
  if (/\b(otp|one time password)\b/i.test(t)) return null;
  const money = extractMoney(t); if (!money.length) return null;
  const isCredit = CREDIT_WORDS.test(t) && !DEBIT_WORDS.test(t);
  const isDebit = DEBIT_WORDS.test(t);
  if (!isCredit && !isDebit) return null;
  if (NOISE.test(t) && !/\b(debited|credited|spent|sent|paid|withdrawn|used for)\b/i.test(t)) return null;
  return {
    id: uid(), type: isCredit ? "credit" : "debit", money,
    date: parseAnyDate(t) || todayISO(), time: parseTime(t) || "",
    merchant: extractMerchant(t) || "Unknown", note: "",
    last4: extractAccountNo(t), hint: instrumentHint(t), ref: extractRef(t),
    source: "sms", raw: t.slice(0, 300),
  };
}

export const splitMessages = (blob) => {
  const byBlank = blob.split(/\n\s*\n+/).map(s=>s.trim()).filter(Boolean);
  return byBlank.length > 1 ? byBlank : blob.split(/\n/).map(s=>s.trim()).filter(s=>s.length>15);
};

// Money arriving is not automatically income - most of it is your own money
// coming back (own-account transfers, card bill reversals, refunds).
const SELF_MOVE = /\b(self|own\s*(a\/c|account)|to\s+your\s+own|own\s+transfer|sweep|auto\s*sweep|fd\s*(closure|maturity)|rd\s*maturity)\b/i;
const GIVE_BACK = /\b(refund|reversal|reversed|cashback|chargeback|failed|returned)\b/i;

export function categorise(txn, rules, categories) {
  const has = (id) => categories.some(c => c.id === id);
  const hay = `${txn.merchant||""} ${txn.note||""} ${txn.raw||""}`.toLowerCase();

  for (const r of rules) {
    try { if (new RegExp(r.pattern,"i").test(hay) && has(r.categoryId)) return r.categoryId; } catch {}
  }

  if (SELF_MOVE.test(hay) && has("transfer")) return "transfer";

  if (txn.type === "credit") {
    if (GIVE_BACK.test(hay) && has("refund")) return "refund";
    return has("income") ? "income" : "other";
  }
  return "other";
}

export function matchAccount(last4, hint, accounts) {
  if (!last4) return null;
  const hits = accounts.filter(a => a.last4?.includes(last4));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0].id;
  return (hits.find(a => a.type === hint) || hits[0]).id;
}

const normMerchant = (s) => String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,18);
const dayDiff = (a,b) => Math.abs((new Date(a)-new Date(b))/86400000);

export function dupStatus(c, existing) {
  for (const e of existing) if (c.ref && e.ref && c.ref === e.ref) return "exact";
  for (const e of existing) {
    if (Math.abs(e.amount - c.amount) > 0.01 || e.type !== c.type) continue;
    if (c.account_id && e.account_id && c.account_id !== e.account_id) continue;
    const dd = dayDiff(e.date, c.date);
    if (dd === 0 && normMerchant(e.merchant) === normMerchant(c.merchant)) return "exact";
    if (dd <= 1) {
      const a = normMerchant(e.merchant), b = normMerchant(c.merchant);
      if (a && b && (a.includes(b.slice(0,6)) || b.includes(a.slice(0,6)))) return "likely";
      if (dd === 0) return "likely";
    }
  }
  return "new";
}

export const DEFAULT_RATES = { USD: 88, EUR: 96, GBP: 112, AED: 24, SGD: 66, AUD: 59, CAD: 65, JPY: 0.6 };

export const DEFAULT_RULES = [
  // Order matters: these decide whether money actually left you, so they must
  // beat merchant rules. "Refund from AMAZON" is a refund, not shopping.
  ["credit card (bill|payment)|card ?payment|cred |autopay.*card|billdesk.*card|own account|self transfer|to your own|neft.*self|imps.*self","transfer"],
  ["refund|reversal|reversed|cashback|chargeback","refund"],

  ["swiggy|zomato|eatsure|dominos|domino|kfc|mcdonald|burgerking|faasos|behrouz|ovenstory|starbucks|chaayos|cafe|restaurant|dhaba|biryani|pizza|barbeque|haldiram|bakery","food"],
  ["blinkit|zepto|instamart|bigbasket|bbdaily|dmart|d-mart|jiomart|grofers|reliancefresh|reliance smart|licious|country delight|milkbasket|supermarket|kirana|provision","groceries"],
  ["uber|olacabs|ola money|rapido|namma yatri|redbus|irctc|metro|bmtc|best undertaking|msrtc|railway|blusmart|quick ride","transport"],
  ["indianoil|indian oil|iocl|bharat petroleum|bpcl|hindustan petroleum|hpcl|hp petrol|shell|nayara|petrol|fuel|petro","fuel"],
  ["amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq|snapdeal|decathlon|croma|reliance digital|vijay sales|lenskart|firstcry|pepperfry|urbanladder|ikea|shoppers stop|westside|zudio|max fashion|lifestyle","shopping"],
  ["anthropic|claude\\.?ai|openai|chatgpt|cursor|github|vercel|netlify|figma|notion|adobe|jetbrains|google one|icloud|dropbox|canva|midjourney|perplexity|linkedin premium","subs"],
  ["netflix|spotify|primevideo|prime video|hotstar|jiocinema|jiohotstar|sonyliv|zee5|youtube premium|apple\\.com/bill|itunes|google play","subs"],
  ["bookmyshow|pvr|inox|cinepolis|steam|playstation|xbox|gaming","fun"],
  ["airtel|jio|vodafone|vi recharge|bsnl|act fibernet|hathway|excitel|electricity|bses|torrent power|adani|mahavitaran|msedcl|mseb|tata power|gas limited|mahanagar gas|indane|hp gas|bharatgas|water bill|municipal|broadband|dth|tata play|dish tv","bills"],
  ["rent|landlord|nobroker|housing society|maintenance charge|society charges","rent"],
  ["emi|loan|bajaj fin|hdb financial|tata capital|fullerton|indiabulls|muthoot|manappuram|repayment|instal?ment","emi"],
  ["pharmeasy|apollo|1mg|tata 1mg|netmeds|medplus|wellness forever|hospital|clinic|diagnostic|pathology|practo|medical|chemist|dental|optical","health"],
  ["zerodha|groww|upstox|angel one|kite |icici direct|hdfc sec|mutual fund|mf purchase|sip |nps |ppf|elss|smallcase|indmoney|kuvera|gold bond|sgb","invest"],
  ["makemytrip|goibibo|yatra|cleartrip|easemytrip|ixigo|oyo|airbnb|indigo|vistara|air india|akasa|spicejet|booking\\.com|agoda|resort|travels","travel"],
  ["atm|cash wdl|cash withdrawal|nwd |cwd ","cashwd"],
  ["salary|sal cr|reimbursement|interest credit|dividend","income"],
];

// `kind` is what the money did to your net worth, and it drives every total:
//   expense  - net worth went down (you consumed something)
//   income   - net worth went up (new money arrived)
//   transfer - net worth unchanged (money moved between things you own)
// `id` is only what you bought. Keeping the two separate is what stops a credit
// card bill from being counted as a second expense on top of the purchases.
export const DEFAULT_CATEGORIES = [
  { id:"food",name:"Food & Dining",icon:"🍜",color:"#EF6F63",budget:0,kind:"expense" },
  { id:"groceries",name:"Groceries",icon:"🧺",color:"#7FA05A",budget:0,kind:"expense" },
  { id:"transport",name:"Transport",icon:"🛺",color:"#5B9BD5",budget:0,kind:"expense" },
  { id:"fuel",name:"Fuel",icon:"⛽",color:"#8C6239",budget:0,kind:"expense" },
  { id:"shopping",name:"Shopping",icon:"🛍️",color:"#D9569E",budget:0,kind:"expense" },
  { id:"bills",name:"Bills & Recharge",icon:"💡",color:"#F2C14E",budget:0,kind:"expense" },
  { id:"subs",name:"Subscriptions",icon:"🔁",color:"#63B7DE",budget:0,kind:"expense" },
  { id:"rent",name:"Rent",icon:"🏠",color:"#A0A6B0",budget:0,kind:"expense" },
  { id:"emi",name:"EMI & Loans",icon:"🏦",color:"#B05C8E",budget:0,kind:"expense" },
  { id:"health",name:"Health",icon:"💊",color:"#4BB6A8",budget:0,kind:"expense" },
  { id:"fun",name:"Entertainment",icon:"🎬",color:"#9B7FD4",budget:0,kind:"expense" },
  { id:"travel",name:"Travel",icon:"✈️",color:"#63B7DE",budget:0,kind:"expense" },
  { id:"family",name:"Family & Gifts",icon:"🎁",color:"#D9569E",budget:0,kind:"expense" },
  // Cash leaving the ATM is really a transfer to your wallet, but the spending
  // that follows never reaches a bank feed - so counting the withdrawal is the
  // only way cash spending shows up at all.
  { id:"cashwd",name:"Cash & ATM",icon:"🏧",color:"#A0A6B0",budget:0,kind:"expense" },
  { id:"other",name:"Uncategorised",icon:"❔",color:"#6B7A93",budget:0,kind:"expense" },

  { id:"income",name:"Income",icon:"💰",color:"#4BB6A8",budget:0,kind:"income" },
  { id:"refund",name:"Refunds & Cashback",icon:"↩️",color:"#7FA05A",budget:0,kind:"income" },

  // Buying an asset is not consumption - the money is still yours.
  { id:"invest",name:"Investments",icon:"📈",color:"#B8C34A",budget:0,kind:"transfer" },
  // Lending and borrowing move money without changing what you are worth:
  // cash goes down, someone's debt to you goes up by the same amount.
  { id:"people",name:"Lent / Borrowed",icon:"🤝",color:"#C98A5E",budget:0,kind:"transfer" },
  { id:"debt",name:"Loan / Debt payment",icon:"📕",color:"#B05C8E",budget:0,kind:"transfer" },
  { id:"transfer",name:"Transfer / Card bill",icon:"↔️",color:"#5A6B85",budget:0,kind:"transfer",excluded:true },
];

// Money's effect on net worth, resolved from the category it landed in.
export function kindOf(txn, catMap) {
  const kind = catMap?.[txn.category_id]?.kind;
  if (kind) return kind;
  return txn.type === "credit" ? "income" : "expense";
}
