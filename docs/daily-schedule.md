# Daily operation without a saved token

## Full pipeline in an open review session

```sh
npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst review --daily --data-dir ./bellhaven-state
```

Enter the hidden token on launch. Run the initial scan in the dashboard. The process repeats the read-only website + CRM comparison every 24 hours while open. It never approves, resumes or changes CRM data. Closing or restarting requires entering the token again. This is an elapsed 24-hour interval, not a precise local-clock/DST schedule; it does not run while the computer is asleep or off. Concurrent local operations are guarded by the journal lock.

## Cron example (public website only; not installed automatically)

```cron
CRON_TZ=America/Edmonton
30 8 * * * /usr/bin/env npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output /home/you/bellhaven/latest.csv --snapshot /home/you/bellhaven/latest.json >>/home/you/bellhaven/scrape.log 2>&1
```

Replace paths, create the destination directory, and use the installed npx path. CRON_TZ support depends on the cron implementation; otherwise set the system timezone. This job needs no token and contacts only the public website. A cron-launched CRM process intentionally refuses to run without an interactive terminal.

## Windows Task Scheduler (public website only)

Program: `npx.cmd` (locate using `where npx.cmd`). Daily arguments:

```text
--yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scrape --output C:\Bellhaven\latest.csv --snapshot C:\Bellhaven\latest.json
```

Use a writable working directory and disallow overlapping instances. Launch `review --daily` interactively for full CRM comparisons. Never schedule automatic approval. Keep the same private state directory for each sandbox so previous decisions persist.
