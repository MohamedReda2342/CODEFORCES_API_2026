# Codeforces Leaderboard Sheet: Simple Guide

## What is it?

A Google Sheet that shows how your contestants did in Codeforces contests.
It shows who is first, second and third, and how each person did in every contest.

You do not type any results. The sheet gets them by itself.

## How does it get the results?

```
Codeforces  ->  Your API (Netlify)  ->  The sheet  ->  You read the tabs
```

1. Codeforces has the real results.
2. Your API reads them from Codeforces.
3. A small script inside the sheet asks your API for each contest and fills the tabs.
4. You press **Codeforces → Refresh all contests** to update.

## The 6 kinds of tabs

### A. You fill in these 3 tabs

| Tab | What you write | Example |
|---|---|---|
| **Settings** | The group ID (or paste the group link). | `S44jalqm24` |
| **Contests** | One contest ID per row, oldest first. | `516648` |
| **Contestants** | Each person's Codeforces handle and name. | `Yuki_JH_`, `Johnny Hany` |

Two options in **Settings**:
- **Only listed contestants**: ticked means only the people in the Contestants tab are ranked. Unticked means everyone in the contest is ranked, and the Contestants tab can stay empty.
- **As manager**: tick it only if the API account is a manager of the group.

### B. The sheet fills in these 3 tabs (you just read them)

| Tab | What it shows |
|---|---|
| **Leaderboard** | The main page. Rank, total problems solved, contests taken, and one column per contest. Top 3 are gold, silver and bronze. The Δ column shows who moved up (▲), down (▼) or is new (NEW) since the last contest. |
| **My Progress** | Pick a handle in the yellow cell B1. You see that person's rank, total, and a result for every contest, with a chart. |
| **C-contest number** (for example `C-516648`) | One tab for each contest. Each row is a person and each column is a problem. A ✔ means solved. |

## How is the rank decided?

**Overall (Leaderboard)**, in this order:
1. **Contests played.** More is better. Someone who played every contest is always above someone who skipped one.
2. **Problems solved.** More is better.
3. **Late solves.** Fewer is better. A late solve is a problem solved after the contest ended.
4. **Penalty.** Lower is better. This is the Codeforces ICPC penalty in minutes, added up over the contests played.
5. If all four are equal, they share the same rank.

**Inside one contest (C-... tabs)**: most problems first, then fewer late solves, then the lowest penalty.

**What is penalty?** For each solved problem: the minute of the accepted run, plus 20 minutes for every wrong run before it. Compilation errors do not count. Solving faster with fewer mistakes gives a smaller penalty.

**Example:** Sara played 2 contests and solved 2 problems in total. Omar played 1 contest and solved 3, with a tiny penalty. Sara is ranked higher, because she played more contests.

Someone who registered but never submitted anything did not play that contest.

**Problems solved after the contest ended** count as solved, with 0 penalty, and are shown in the **Late** column. Late solves are compared before penalty, so someone who solved everything late never ranks above someone who solved the same number on time.

## How to use it

**Once, at the start**
1. In the sheet: **Extensions → Apps Script**. Paste the code from `Code.gs`. Save.
2. Reload the sheet. Click **Codeforces → Set up sheets**. Allow the permissions.
3. Fill in the **Settings**, **Contests** and **Contestants** tabs.

**After every contest**
1. Add the contest ID as a new row in **Contests**.
2. Click **Codeforces → Refresh all contests**.
3. Open **Leaderboard** and share it.

**Optional**: **Codeforces → Turn on auto refresh (hourly)** updates the sheet by itself.

## Sharing

- **Viewer**: people can read everything but cannot change it.
- **Editor**: people can also use the handle picker on **My Progress**. Everything else stays locked. They all share the same picker, so they see each other's choice.

## Problems and fixes

| You see | What it means | What to do |
|---|---|---|
| "Contest ... not found" | The API account is not in that group. | Add the account to the group, or use a key from an account that is in it. |
| "Only contest managers can use asManager" | **As manager** is ticked but the account is not a manager. | Untick **As manager**. |
| Leaderboard is empty | Nothing has been refreshed yet. | Fill the 3 tabs, then click **Refresh all contests**. |
| A person is missing | **Only listed contestants** is ticked and their handle is not listed. | Add the handle to **Contestants**, or untick the option. |
| "Skipped: time limit" | Google stops scripts after about 6 minutes. | Click **Refresh all contests** again. |

## Not included yet (the old Excel file had them)

- A group letter (A to D) for each student
- A Tasks list with deadlines
- Weekly progress by date
- Telegram and WhatsApp links
