# Daily, read-only scheduling

Only the **`scan`** command belongs in unattended automation. Do **not** automate `review`, `approve`, or `retry`. All approvals are made by a human using the local app.

## macOS/Linux crontab example

Install Node.js 22.16+, Git and npm for the scheduled user's account. Put the credential in a private `/home/you/.config/bellhaven/credentials.env`, and create a persistent state directory `/home/you/.local/share/bellhaven-review` (replace `you` with your OS username). Open `crontab -e` and add:

```cron
# On systems supporting CRON_TZ (for example, cronie): 08:30 America/Edmonton each day.
CRON_TZ=America/Edmonton
30 8 * * * /usr/bin/env npx --yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan --env-file /home/you/.config/bellhaven/credentials.env --data-dir /home/you/.local/share/bellhaven-review >>/home/you/.local/share/bellhaven-review/daily.log 2>&1
```

Make sure `npx` is on the **cron PATH** (or substitute the absolute binary path from `command -v npx`). `CRON_TZ` support varies; if absent, configure the computer/cron daemon timezone, or use a scheduler with an explicit timezone. For a stable reproducible deployment, pin `github:...#<reviewed-commit-sha>` and update manually after review. Log files may contain facility names; restrict their permissions. The **same** `--data-dir` must be used for every scheduled scan and interactive review. Take encrypted state backups.

## Windows Task Scheduler

Create a basic task triggering daily at **08:30 local time** (on a machine using America/Edmonton) with **Program/script:** the path from `where npx.cmd`, **Arguments:**

```text
--yes github:TerenceHK24/Clipboard-Health_Sales-Operations-Analyst scan --env-file C:\Private\Bellhaven\credentials.env --data-dir C:\Private\Bellhaven\state
```

Set **Start in** to a writable directory and **If the task is already running: Do not start a new instance**. For schedule reliability, run on a stable computer that is powered on and connected. Some Windows versions require `cmd.exe /c` in front of the `npx.cmd` command.

## Why not a normal ephemeral GitHub Actions cron job?

GitHub-hosted runners lose their local SQLite database after the workflow ends. Without a secure persistent journal, a second run may propose previously rejected decisions, violating the requirement. The cron/Task Scheduler example above preserves the journal between runs. GitHub Actions can be used only with a secured persistent store and appropriate secret-management design, which this repository intentionally does not enable.
