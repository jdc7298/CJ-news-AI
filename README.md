# Midterm Desk

A free, auto-updating election tracker: official North Dakota results, side-by-side headlines from many outlets, and a source-health panel. It runs on GitHub (no server, no cost). A scheduled job fetches data into `/data`, and the static page in `index.html` reads it and re-checks every 60 seconds.

## Honest status

- Tested here with sample feeds and a sample results CSV: parsing, filtering, layout (desktop and phone), and "unchanged run writes nothing" all work.
- **Not yet tested against the live feeds.** My workspace could not reach North Dakota's results site or the news sites. Every feed that fails shows red on the **Sources & method** tab with the error, so problems are visible, not silent.
- The ND results link must be pasted in by you (step 5). The national House/Senate totals need a licensed feed (step 6); until then the page says so rather than guessing.
- GitHub's 5-minute schedule is best-effort and often runs late. For election night use the 1-minute loop (step 4).

## Setup (about 15 minutes)

1. **Make a repository.** On github.com: New repository, name it `midterm-desk`, set it to **Public**, leave "Add a README" unchecked.
2. **Upload these files.** Easiest is the terminal on your Mac, from inside this unzipped folder:
   ```
   git init && git add . && git commit -m "first version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/midterm-desk.git
   git push -u origin main
   ```
   (Web upload also works, but the hidden `.github` folder is easy to miss. If you use the web, create `.github/workflows/update.yml` with Add file → Create new file and paste the contents.)
3. **Turn on the website.** Repo → Settings → Pages → Build and deployment → "Deploy from a branch" → branch `main`, folder `/ (root)` → Save. Your site will be at `https://YOUR-USERNAME.github.io/midterm-desk/`.
   Also check Settings → Actions → General → Workflow permissions is "Read and write".
4. **Run the updater.** Repo → Actions → "Update data" → Run workflow.
   - Test run: leave `loop_minutes` at `0`.
   - **Election night:** set `loop_minutes` to `300` and `interval_seconds` to `60`. It refreshes every minute for 5 hours, committing only when something changed. Start it before polls close; start another when it ends.
5. **Connect ND official results.** Open https://resultsnd.sos.nd.gov/ → **Exports** → right-click the CSV (or JSON) link → Copy Link Address → paste into `config/results.json` (`url`). Edit the file right on GitHub. If the Sources tab shows a column error, send me that message and the first few rows of the file and I will tune the reader.
6. **National totals (optional, paid).** AP and Decision Desk HQ sell the feeds. Once you have one, write `data/national.json` in this shape and the National tab lights up:
   ```json
   { "generatedAt": "2026-11-03T23:00:00Z", "source": "Decision Desk HQ",
     "house":  { "a": {"label":"Democrats","seats":0}, "b": {"label":"Republicans","seats":0}, "other":0, "needed":218, "undecided":435 },
     "senate": { "a": {"label":"Democrats","seats":0}, "b": {"label":"Republicans","seats":0}, "other":0, "needed":51,  "undecided":35 } }
   ```
   I can write the fetcher for either vendor once you have credentials and their docs.

## Customizing

- **Name, tagline, corrections email, official links:** `config/site.json`
- **News sources and their column:** `config/sources.json` (add any RSS/Atom feed)
- **ND ballot facts (each with a source link):** `config/races.json`
- **Topic keyword rules:** top of `scripts/update.mjs`

## Before you charge for anything

- Check each outlet's terms for reuse of its RSS feed commercially. This tool shows headlines and links only, which is the safe pattern; keep it that way.
- Keep the "unofficial until certified" notice and the leading-vs-called wording. They are what makes this trustworthy.
