# Rewards Prize Draw

React UI that reads `ll-entries.csv` / `ll-prize.csv`, runs the draw through the
randomdraws.com API and animates the result on a prize wheel.

## Run

    npm install
    npm run dev        # UI on http://localhost:5173, API on :5174

`npm start` builds the UI and serves everything from http://localhost:5174.

Credentials live in `server/.env` (see `server/.env.example`). They are only used
by the local Node server and never sent to the browser.

## How a draw works

1. The server uploads the entries CSV to `POST /upload`.
2. Creates the draw (`POST /draws`) using the prizes in `ll-prize.csv`.
3. Confirms it (`POST /draws/{id}`), which draws immediately.
4. The winner's row is mapped back to OID / Reward_Card_ID and returned to the UI,
   which lands the wheel on that card. The draw certificate link is shown in the results.

The wheel is only a visual. The winner is always the one randomdraws.com returns.

## Test vs live

- **Test**: free, but the API limits test draws to 20 entries, so the server uploads a
  random 20-row sample of the file. Not an official result.
- **Live**: uploads the full file and uses 1 draw credit. The account currently has 0 credits.

API notes: `POST /tokens` expects `email` (not `username` as the docs say) and
`testMode: true` for test tokens. Tokens last 20 minutes and are cached by the server.

## Uploading a new entries file

Under Entries, click **Upload new entries file**, choose a CSV and enter the passcode
(`UPLOAD_PASSCODE` in `server/.env`). The file needs a header row with a `Reward_Card_ID`
column, at least 2 entries and at most 100 MB. It's checked before it's used; a bad file is
rejected and the current one stays active.

Uploaded files are saved in `uploads/` and stay active after a restart. **Switch back to
ll-entries.csv** returns to the file set by `ENTRIES_FILE`. After 5 wrong passcodes, uploads
are locked for 10 minutes.

## Scheduling a draw

Under Draw, choose **Schedule**, pick a date and time (at least 1 minute ahead, in this PC's
time) and press **Schedule draw**. The draw is created and confirmed on randomdraws.com, and
they run it at that time. It happens whether or not this app is open.

Live scheduled draws use 1 credit when scheduled. **Cancel** under Scheduled draws cancels
it and refunds the credit.

While the page is open it polls RandomDraws. When a scheduled draw completes, the wheel spins
onto the winner automatically (untick the option to do it manually). Any completed draw can
be shown again with **Reveal** under Recent draws.

The file each draw was made from is recorded in `data/draws.json`, so winners map back to
the right entry row after a restart or a new upload.

## Two-step draws: create, then draw or schedule

1. **Create draw** uploads the current entries file to randomdraws.com as a draft. No credit
   is used. The draft card shows how many entries RandomDraws counted and flags anything to
   check: a count that doesn't match the file, exactly 1,048,575 entries (Excel's row
   limit, so the file may be cut off), empty rows, RandomDraws warnings, or a draft made
   from a different file than the one loaded now.
2. **Spin & draw** confirms it now, or **Schedule draw** confirms it for a set time. For a
   live draw, this is when the credit is used.

**Back (keep draft)** leaves it for later. Saved drafts are listed under **Drafts** on the
right, where they can be selected or deleted. Deleting a draft costs nothing.
