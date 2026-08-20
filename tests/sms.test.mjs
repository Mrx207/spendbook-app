import { parseSMS, splitMessages, settle, parseAnyDate } from "../lib/parser.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

const read = (blob) => splitMessages(blob).map(parseSMS).filter(Boolean).map(p => {
  const s = settle(p.money, {}, 0) || {};
  return { type: p.type, amount: s.amount, merchant: p.merchant };
});

// A multi-line card alert is one transaction, not seven fragments. The amount
// sits alone on a short first line, which line-splitting used to discard.
const hdfcCard = `Txn Rs.30.00
On HDFC Bank Card 2537
At gpay-12204210544@okbizaxi
by UPI 659862478825
On 20-08
Not You?
Call 18002586161/SMS BLOCK CC 2537 to 7308080808`;
check("card alert stays one message", splitMessages(hdfcCard).length, 1);
check("card alert parses", read(hdfcCard), [{ type:"debit", amount:30, merchant:"gpay-12204210544@okbizaxi" }]);

// "Txn" must not outrank an explicit credit.
check("txn plus credited is a credit",
  read("Txn of Rs.2000 credited to your a/c XX9999 on 18-08").map(x=>x.type), ["credit"]);
check("plain credit unchanged",
  read("Your a/c XX1234 is credited with Rs.5000 on 19-08-26 by NEFT").map(x=>x.type), ["credit"]);
check("plain debit unchanged",
  read("Rs.450.00 debited from a/c XX1234 to VPA swiggy@ybl on 20-08-26"),
  [{ type:"debit", amount:450, merchant:"swiggy@ybl" }]);

// Weak signal alone, with no card or account context, is not a transaction.
check("bare txn word ignored", read("Txn reference 99881122 for your query"), []);
check("otp ignored", read("Txn OTP is 456123 for your card 2537. Do not share."), []);

// Several one-line messages pasted together still split apart.
const many = `Rs.100 debited from a/c XX1111 to VPA a@ybl on 01-08-26
Rs.200 debited from a/c XX1111 to VPA b@ybl on 02-08-26`;
check("two one-liners split", read(many).length, 2);

// Blank-line separated messages keep working.
const blankSep = `Rs.100 debited from a/c XX1111 to VPA a@ybl on 01-08-26

Txn Rs.30.00
On HDFC Bank Card 2537
At gpay-1220@okbizaxi
On 20-08`;
check("blank-separated mixed forms", read(blankSep).length, 2);

// Year-less dates resolve to the current year, never the future.
const now = new Date();
const yr = now.getFullYear();
const jan = parseAnyDate("On 05-01");
check("dayless year assumed", jan?.slice(0,4), String(jan > `${yr}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}` ? yr - 1 : yr));
check("full date still wins", parseAnyDate("on 20-08-26 ref 123"), "2026-08-20");
check("long digits are not dates", parseAnyDate("Call 18002586161 for help"), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
