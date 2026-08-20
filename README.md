# Spendbook — deploy to Vercel

## 1. Push to GitHub
Unzip this, then in the folder:
```
git init
git add .
git commit -m "spendbook"
```
Create empty repo on github.com, then:
```
git remote add origin https://github.com/YOUR_USERNAME/spendbook.git
git push -u origin main
```

## 2. Deploy on Vercel
- vercel.com → New Project → import the GitHub repo → Deploy (defaults are fine, it's Next.js).

## 3. Add Postgres
- In the Vercel project → Storage tab → Create Database → Postgres → connect to this project.
  This auto-injects `POSTGRES_URL` etc as env vars. No manual SQL needed — the app creates its own
  tables on first request.

## 4. Set your webhook secret
- Project → Settings → Environment Variables → add `INGEST_SECRET` = any long random string
  (e.g. generate one at `openssl rand -hex 20` or just mash your keyboard, 30+ chars).
- Redeploy (Settings → Deployments → ⋯ → Redeploy) so the var takes effect.

## 5. Open the app
Your dashboard is at `https://your-project.vercel.app`. Add to iPhone home screen via
Safari share sheet → Add to Home Screen.

## 6. Set up the iOS Shortcut (this is the automation)
Shortcuts app → Automation tab → + → Create Personal Automation → Message →
"When I receive a message" → filter by sender (your bank's SMS ID) → Next → Add Action:

1. **Get Contents of URL**
   - URL: `https://your-project.vercel.app/api/ingest`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Request Body → JSON:
     - `secret` : your INGEST_SECRET value
     - `text` : (use the Shortcut variable for the incoming Message Content)
2. Turn OFF "Ask Before Running" so it fires silently.
3. Repeat the automation once per bank sender ID you want tracked (HDFC, ICICI, etc — each
   as its own automation, all pointing at the same URL).

Once saved: every bank SMS now silently POSTs to your app, gets parsed, deduped, categorised,
and shows up in the dashboard — zero taps. First time a new card's last-4 shows up, open the
app and link it to an account (Setup tab, once code below adds that; MVP dashboard here 
covers add/import/ledger — I can extend it with the full accounts/filters/budgets UI from the
artifact on request).

## What's included vs the artifact
This ships the ingest pipeline (the actual automation you asked for) plus a working minimal
dashboard: summary, category pie, ledger, manual add, paste-import with dedup review.
The richer artifact UI (accounts strip, budgets, filters sheet, FX settings page, rules editor)
isn't ported yet — say the word and I'll bring the full UI over to this codebase next.
