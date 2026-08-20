import { categorise, kindOf, DEFAULT_CATEGORIES, DEFAULT_RULES } from "../lib/parser.js";

const cats = DEFAULT_CATEGORIES;
const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
const rules = DEFAULT_RULES.map(([pattern, categoryId]) => ({ pattern, categoryId }));

let pass = 0, fail = 0;
const t = (label, txn, wantCat, wantKind) => {
  const cat = categorise(txn, rules, cats);
  const kind = kindOf({ ...txn, category_id: cat }, catMap);
  const ok = cat === wantCat && kind === wantKind;
  if (ok) pass++; else { fail++; console.log(`FAIL ${label}\n  got  ${cat}/${kind}\n  want ${wantCat}/${wantKind}`); }
};

const debit = (raw) => ({ type: "debit", merchant: "", raw });
const credit = (raw) => ({ type: "credit", merchant: "", raw });

// The bugs this change exists to fix
t("credit card bill", debit("Payment towards HDFC Credit Card bill"), "transfer", "transfer");
t("cred app", debit("UPI/DR/123/CRED /Payment"), "transfer", "transfer");
t("self transfer", debit("IMPS transfer to your own account"), "transfer", "transfer");
t("mutual fund", debit("UPI/DR/999/ZERODHA COIN/SIP"), "invest", "transfer");
t("amazon refund", credit("Refund from AMAZON for order"), "refund", "income");
t("cashback", credit("Cashback credited to your account"), "refund", "income");
t("failed txn reversal", credit("Reversal of failed transaction"), "refund", "income");
t("salary", credit("SALARY CREDIT from ACME"), "income", "income");

// Ordinary spending must stay expense
t("swiggy", debit("UPI/DR/1/SWIGGY/Payment"), "food", "expense");
t("rent", debit("NEFT to landlord rent august"), "rent", "expense");
t("atm", debit("ATM CASH WDL MUMBAI"), "cashwd", "expense");
t("unknown debit", debit("SOME RANDOM MERCHANT XYZ"), "other", "expense");
t("emi stays expense", debit("EMI debited Bajaj Finance"), "emi", "expense");

// A month where transfers would otherwise wreck the totals
const month = [
  { type:"debit", amount:450, raw:"UPI/DR/1/SWIGGY/Payment" },
  { type:"debit", amount:20000, raw:"Payment towards HDFC Credit Card bill" },
  { type:"debit", amount:15000, raw:"UPI/DR/2/ZERODHA COIN/SIP" },
  { type:"credit", amount:85000, raw:"SALARY CREDIT from ACME" },
  { type:"credit", amount:300, raw:"Refund from AMAZON" },
].map(x => { const c = categorise(x, rules, cats); return { ...x, category_id: c }; });

const sum = (k) => month.filter(x => kindOf(x, catMap) === k).reduce((s, x) => s + x.amount, 0);
const spent = sum("expense"), income = sum("income"), moved = sum("transfer");

console.log(`\nspent ${spent}  income ${income}  moved ${moved}  left ${income - spent}`);
const totalsOk = spent === 450 && income === 85300 && moved === 35000;
if (totalsOk) pass++; else { fail++; console.log("FAIL month totals"); }

// What the old logic would have reported, for comparison
const oldSpent = month.filter(x => x.type === "debit" && !catMap[x.category_id]?.excluded).reduce((s,x)=>s+x.amount,0);
const oldIncome = month.filter(x => x.type === "credit").reduce((s,x)=>s+x.amount,0);
console.log(`old logic would say: spent ${oldSpent}, income ${oldIncome}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
