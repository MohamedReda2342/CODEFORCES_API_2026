# Google Sheets leaderboard

A Google Sheet that pulls every contest from the API in this repo and shows contestants
their progress and how they rank against each other.

| Tab | What it shows |
|---|---|
| **Leaderboard** | Overall rank, movement since the last contest (▲ ▼ = NEW), total solved, contests attended, a trend sparkline, and solved count per contest. Top 3 highlighted. |
| **My Progress** | Pick a handle in **B1** → overall rank, total, and per contest: solved, % solved, rank in that contest, plus a chart. |
| **C-&lt;contestId&gt;** | One tab per contest: who solved which problem (✔), rank inside the contest. Problem headers link to Codeforces. |
| **Contests** | The contests to track (you fill this). |
| **Contestants** | Handles + display names (you fill this). |
| **Settings** | Group ID and options. |

## Setup (once, ~5 minutes)

1. Create a blank Google Sheet.
2. **Extensions → Apps Script**, delete the sample code, paste [`Code.gs`](Code.gs), click **Save**.
3. Reload the sheet. A **Codeforces** menu appears → **Set up sheets**.
   Google asks for permission the first time (the script needs to edit the sheet and call the API).
4. **Settings**: put the **Group ID** (`https://codeforces.com/group/<GROUP_ID>/...`; pasting the whole link works).
   The API address (`https://hti-codeforces-api.netlify.app`) is the `API_BASE` line at the top of `Code.gs`; change it there if your site ever moves.
5. **Contestants**: one handle per row (profile links work too) and an optional display name.
6. **Contests**: one contest ID (or full contest link) per row, **in the order they were held**, and tick **Auto refresh**.
7. **Codeforces → Refresh all contests**.
8. Optional: **Codeforces → Turn on auto refresh (hourly)**.

## Sharing with contestants

The script protects every tab so only you (the owner) can edit. The one exception is **My Progress!B1**,
the handle picker. Pick how to share:

- **Viewer**: contestants see the Leaderboard and contest tabs, but can't use the My Progress picker.
- **Editor**: they can also use the picker. Everything else stays locked.
  The picker is shared, so if two people change it at the same moment they'll see each other's pick.

## Options

- **Only listed contestants** (Settings, ticked by default): rank only the handles in *Contestants*.
  Untick it to include everyone who appears in the group standings.
- **As manager**: tick it if the API key account manages the group and contests are hidden from normal members.
- **Group ID (optional)** column in *Contests*: use it when one contest belongs to a different group.
- When a contest is over, untick its **Auto refresh**. Its tab keeps the data and refreshes run faster.

## Notes

- **Overall ranking:** 1) contests played (more is better), 2) problems solved (more is better), 3) late solves (fewer is better), 4) total ICPC penalty (lower is better).
  Contests played comes first so that someone who played every contest always ranks above someone who skipped one, even if the skipper has a smaller penalty or more solves.
  Only people with the same three numbers share a rank.
- **Inside one contest:** most problems solved first, then the lowest penalty.
- A person who registered but never submitted anything does not count as having played.
- Problems solved **after the contest ended** (practice or virtual runs, or accepted after the end time) count as solved with **0 penalty**.
  They are counted in the **Late** column. With the same number of solves, fewer late solves rank higher, and penalty is only compared after that,
  so a late solver's 0 never beats an on-time solver's real penalty.
- Penalty is in minutes: the time of each accepted run plus 20 for every rejected run before it (compilation errors are free).
  It is Codeforces' own value for ICPC-style contests. For other contest types Codeforces reports 0, so ties stay ties.
  This needs the updated API (`functions/ac.js`) deployed on Netlify.
- The **Δ** column compares the current rank with the rank before the latest contest (last row in *Contests*).
- Codeforces allows 1 API call per 2 seconds, so each contest takes ~2s. A refresh stops after ~4.5 min
  (the Apps Script limit is 6) and marks the contests it skipped. The next run picks them up.
- If the Status says *"OK (from submissions…)"*, the API used its `contest.status` fallback.
  Problems that nobody submitted won't have a column.
