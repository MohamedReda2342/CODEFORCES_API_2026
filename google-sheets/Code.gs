// Codeforces group leaderboard for Google Sheets.
// Reads the Netlify API in this repo (/ac/g/<group>/c/<contest>/p/<page>) and builds:
//   Leaderboard  - overall ranking across all contests, rank change since the last contest, trend
//   My Progress  - pick a handle, see solved / rank per contest + chart
//   C-<id>       - one tab per contest: who solved which problem
// Setup: Extensions -> Apps Script, paste this file, save, reload the sheet,
//        then menu "Codeforces" -> "Set up sheets". See google-sheets/README.md.

const API_BASE = "https://hti-codeforces-api.netlify.app"; // your Netlify site; change it here if the site ever moves
const SHEETS = {
    LEADERBOARD: "Leaderboard",
    PROGRESS: "My Progress",
    CONTESTS: "Contests",
    CONTESTANTS: "Contestants",
    SETTINGS: "Settings",
};
const TAB_PREFIX = "C-";           // per contest tab: C-<contestId>
const API_GAP_MS = 2100;           // Codeforces allows 1 call / 2s
const TIME_BUDGET_MS = 4.5 * 60e3; // Apps Script stops at 6 min

// Contests sheet columns (1-based)
const CC = { ID: 1, GROUP: 2, AUTO: 3, NAME: 4, PROBLEMS: 5, PARTICIPANTS: 6, TAB: 7, UPDATED: 8, STATUS: 9 };

const COLORS = { header: "#1f2937", headerText: "#ffffff", solved: "#b7e1cd", gold: "#fde68a", silver: "#e5e7eb", bronze: "#fcd5b4" };

// ---------- menu ----------

function onOpen() {
    SpreadsheetApp.getUi()
        .createMenu("Codeforces")
        .addItem("Set up sheets", "setup")
        .addSeparator()
        .addItem("Refresh all contests", "refreshAll")
        .addItem("Refresh selected contest (Contests tab)", "refreshSelected")
        .addItem("Rebuild leaderboard only", "buildLeaderboard")
        .addSeparator()
        .addItem("Turn on auto refresh (hourly)", "installTrigger")
        .addItem("Turn off auto refresh", "removeTriggers")
        .addToUi();
}

// ---------- setup ----------

function setup() {
    const ss = SpreadsheetApp.getActive();

    const settings = sheet_(SHEETS.SETTINGS);
    // older versions had an "API base URL" row; the address now lives in the code
    if (String(settings.getRange("A2").getValue()).trim() === "API base URL") settings.deleteRow(2);
    if (settings.getLastRow() < 2) {
        settings.getRange(1, 1, 5, 3).setValues([
            ["Setting", "Value", "Notes"],
            ["Group ID", "", "From https://codeforces.com/group/<GROUP_ID>/... (a full group link also works)"],
            ["As manager", false, "Tick if the API key account is a manager of the group"],
            ["Only listed contestants", true, "Tick: rank only handles in the Contestants tab. Untick: everyone in the standings"],
            ["Last refresh", "", "Filled automatically"],
        ]);
        settings.getRange("B3:B4").insertCheckboxes();
        styleHeader_(settings.getRange(1, 1, 1, 3));
        settings.setColumnWidths(1, 1, 180).setColumnWidths(2, 1, 320).setColumnWidths(3, 1, 520);
        settings.setFrozenRows(1);
    }

    const contestants = sheet_(SHEETS.CONTESTANTS);
    if (contestants.getLastRow() < 1) {
        contestants.getRange(1, 1, 1, 2).setValues([["Handle", "Name"]]);
        styleHeader_(contestants.getRange(1, 1, 1, 2));
        contestants.setColumnWidths(1, 2, 200).setFrozenRows(1);
    }

    const contests = sheet_(SHEETS.CONTESTS);
    if (contests.getLastRow() < 1) {
        contests.getRange(1, 1, 1, 9).setValues([[
            "Contest ID or link", "Group ID (optional)", "Auto refresh", "Name", "Problems",
            "Participants", "Tab", "Last updated", "Status",
        ]]);
        styleHeader_(contests.getRange(1, 1, 1, 9));
        contests.getRange(2, CC.AUTO, 200, 1).insertCheckboxes();
        contests.setColumnWidth(CC.ID, 260).setColumnWidth(CC.GROUP, 140).setColumnWidth(CC.NAME, 280).setColumnWidth(CC.STATUS, 360);
        contests.setFrozenRows(1);
        contests.getRange(1, CC.ID).setNote("Add contests in the order they happened. Untick 'Auto refresh' for finished contests to save time.");
    }

    sheet_(SHEETS.LEADERBOARD);
    sheet_(SHEETS.PROGRESS);

    // tab order: Leaderboard, My Progress, Contests, Contestants, Settings, then contest tabs
    [SHEETS.LEADERBOARD, SHEETS.PROGRESS, SHEETS.CONTESTS, SHEETS.CONTESTANTS, SHEETS.SETTINGS].forEach((name, i) => {
        ss.setActiveSheet(ss.getSheetByName(name));
        ss.moveActiveSheet(i + 1);
    });
    const blank = ss.getSheetByName("Sheet1");
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

    buildLeaderboard();
    [SHEETS.LEADERBOARD, SHEETS.PROGRESS, SHEETS.CONTESTS, SHEETS.CONTESTANTS, SHEETS.SETTINGS].forEach((name) => protect_(sheet_(name)));
    ss.setActiveSheet(settings);
    ss.toast("Fill Group ID in Settings, handles in Contestants, contest IDs in Contests, then Codeforces -> Refresh all contests.", "Setup done", 15);
}

// ---------- refresh ----------

function refreshAll() {
    withLock_(() => {
        const started = Date.now();
        const cfg = readSettings_();
        const roster = readRoster_();
        const contests = readContests_().filter((c) => c.auto || !c.tab);
        let calls = 0;
        for (const c of contests) {
            if (Date.now() - started > TIME_BUDGET_MS) {
                setStatus_(c.row, "Skipped: time limit reached, will refresh next run");
                continue;
            }
            if (calls++) Utilities.sleep(API_GAP_MS);
            refreshContest_(c, cfg, roster);
        }
        setSetting_("Last refresh", new Date());
        buildLeaderboard();
    });
}

function refreshSelected() {
    const sh = SpreadsheetApp.getActiveSheet();
    if (sh.getName() !== SHEETS.CONTESTS) {
        SpreadsheetApp.getUi().alert("Select a row in the Contests tab first.");
        return;
    }
    const row = sh.getActiveRange().getRow();
    const c = readContests_().find((x) => x.row === row);
    if (!c) {
        SpreadsheetApp.getUi().alert("That row has no contest ID.");
        return;
    }
    withLock_(() => {
        refreshContest_(c, readSettings_(), readRoster_());
        buildLeaderboard();
    });
}

function refreshContest_(c, cfg, roster) {
    const ss = SpreadsheetApp.getActive();
    const groupId = c.groupId || cfg.groupId;
    if (!groupId) {
        setStatus_(c.row, "Error: no Group ID (set it in Settings or in column B)");
        return;
    }
    try {
        const data = fetchContest_(cfg, groupId, c.contestId);
        const link = `https://codeforces.com/group/${groupId}/contest/${c.contestId}`;
        const written = writeContestTab_(ss, c.contestId, link, data, cfg, roster);
        const sh = sheet_(SHEETS.CONTESTS);
        sh.getRange(c.row, CC.NAME, 1, 6).setValues([[
            `=HYPERLINK("${link}","${q_(data.contest.name)}")`,
            written.problems,
            written.participants,
            written.tab,
            new Date(),
            data.source === "contest.status" ? "OK (from submissions; unsolved-by-all problems hidden)" : "OK",
        ]]);
    } catch (err) {
        setStatus_(c.row, "Error: " + err.message);
    }
}

function fetchContest_(cfg, groupId, contestId) {
    const contestants = {};
    let contest = null;
    let source = "contest.standings";
    for (let page = 1; page <= 50; page++) {
        if (page > 1) Utilities.sleep(API_GAP_MS);
        let url = `${cfg.apiBase}/ac/g/${encodeURIComponent(groupId)}/c/${encodeURIComponent(contestId)}/p/${page}`;
        if (cfg.asManager) url += "?asManager=true";
        const json = fetchJson_(url);
        if (json.status !== "OK") throw new Error(json.err || json.result || "API returned FAILED");
        contest = contest || json.result.contest;
        if (json.result.source) source = json.result.source;
        Object.assign(contestants, json.result.contestants);
        if (!json.result.hasMore) break;
    }
    return { contest, contestants, source };
}

function fetchJson_(url) {
    for (let attempt = 1; ; attempt++) {
        const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        let body = null;
        try { body = JSON.parse(res.getContentText()); } catch (_) { /* not JSON */ }
        const retryable = !body || res.getResponseCode() >= 500 || /limit exceeded/i.test((body && body.err) || "");
        if (!retryable || attempt >= 3) {
            if (!body) throw new Error(`HTTP ${res.getResponseCode()} from API`);
            return body;
        }
        Utilities.sleep(3000 * attempt);
    }
}

// ---------- contest tab ----------

function writeContestTab_(ss, contestId, link, data, cfg, roster) {
    const tab = TAB_PREFIX + contestId;
    const sh = ss.getSheetByName(tab) || ss.insertSheet(tab, ss.getSheets().length);
    sh.clear();
    sh.clearConditionalFormatRules();

    const problems = data.contest.problems.map((p) => ({ index: p.name.split(" - ")[0].trim(), title: p.name, link: p.link }));
    let rows = Object.keys(data.contestants).map((h) => {
        const key = h.toLowerCase();
        const known = roster.get(key);
        const solved = new Set(String(data.contestants[h].ac || "").split("-").filter(Boolean));
        const penalty = Number(data.contestants[h].penalty) || 0;
        const late = Number(data.contestants[h].late) || 0; // problems solved after the contest ended
        const tried = data.contestants[h].tried !== false; // older API versions don't send it
        return { key, handle: known ? known.handle : h, name: known ? known.name : "", solved, penalty, late, tried };
    });
    rows = rows.filter((r) => r.tried); // registered but never submitted = did not take part
    if (cfg.onlyListed && roster.size) rows = rows.filter((r) => roster.has(r.key));
    // most solved first, then fewer late solves (on-time beats after-the-end), then the lowest penalty
    rows.sort((a, b) => b.solved.size - a.solved.size || a.late - b.late || a.penalty - b.penalty || a.handle.localeCompare(b.handle));
    const ranks = competitionRanks_(rows.map((r) => `${r.solved.size}|${r.late}|${r.penalty}`));

    const width = 6 + problems.length;
    sh.getRange(1, 1).setValue(`=HYPERLINK("${link}/standings","${q_(data.contest.name)}")`).setFontSize(14).setFontWeight("bold");
    const header = ["Rank", "Handle", "Name", "Solved", "Penalty", "Late"].concat(problems.map((p) => `=HYPERLINK("${p.link}","${q_(p.index)}")`));
    styleHeader_(sh.getRange(2, 1, 1, width).setValues([header]));
    sh.getRange(2, 5).setNote("ICPC penalty in minutes (time of each accepted run + 20 per rejected run before it). Lower is better. Problems solved after the contest ended add 0.");
    sh.getRange(2, 6).setNote("How many of the solved problems were solved after the contest ended. With the same Solved, fewer late solves rank higher.");
    problems.forEach((p, i) => sh.getRange(2, 7 + i).setNote(p.title));

    if (rows.length) {
        const values = rows.map((r, i) => [ranks[i], profile_(r.handle), r.name, r.solved.size, r.penalty, r.late]
            .concat(problems.map((p) => (r.solved.has(p.index) ? "✔" : ""))));
        sh.getRange(3, 1, values.length, width).setValues(values);
        if (problems.length) {
            const grid = sh.getRange(3, 7, values.length, problems.length);
            grid.setHorizontalAlignment("center");
            sh.setConditionalFormatRules([
                SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("✔").setBackground(COLORS.solved).setRanges([grid]).build(),
            ].concat(medalRules_(sh, values.length, width)));
        }
        sh.getRange(3, 1, values.length, 1).setHorizontalAlignment("center");
        sh.getRange(3, 4, values.length, 1).setHorizontalAlignment("center").setFontWeight("bold");
        sh.getRange(3, 5, values.length, 2).setHorizontalAlignment("center");
    }
    protect_(sh);
    sh.setFrozenRows(2);
    sh.setFrozenColumns(2);
    sh.setColumnWidth(1, 50).setColumnWidth(2, 160).setColumnWidth(3, 180).setColumnWidth(4, 60).setColumnWidth(5, 70).setColumnWidth(6, 50);
    if (problems.length) sh.setColumnWidths(7, problems.length, 40);

    return { tab, problems: problems.length, participants: rows.length };
}

// Reads a contest tab back: Map(lowercase handle -> { handle, rank, solved, penalty, late })
function readContestTab_(sh) {
    const out = new Map();
    const n = sh.getLastRow() - 2;
    if (n < 1) return out;
    sh.getRange(3, 1, n, 6).getValues().forEach(([rank, handle, , solved, penalty, late]) => {
        if (handle) {
            out.set(String(handle).toLowerCase(), {
                handle: String(handle), rank, solved: Number(solved) || 0, penalty: Number(penalty) || 0, late: Number(late) || 0,
            });
        }
    });
    return out;
}

// ---------- leaderboard ----------

function buildLeaderboard() {
    const ss = SpreadsheetApp.getActive();
    const cfg = readSettings_();
    const roster = readRoster_();
    const contests = readContests_().filter((c) => c.tab && ss.getSheetByName(c.tab));
    const results = contests.map((c) => readContestTab_(ss.getSheetByName(c.tab)));

    const people = new Map(roster);
    if (!(cfg.onlyListed && roster.size)) {
        results.forEach((m) => m.forEach((v, k) => { if (!people.has(k)) people.set(k, { handle: v.handle, name: "" }); }));
    }

    const n = contests.length;
    let rows = [...people.entries()].map(([key, p]) => {
        const hits = results.map((m) => (m.has(key) ? m.get(key) : null)); // null = missed that contest
        const per = hits.map((h) => (h ? h.solved : ""));
        // stats over the first `count` contests (all of them, or all but the latest for the Δ column)
        const upTo = (count) => {
            const got = hits.slice(0, count).filter(Boolean);
            return {
                attended: got.length,
                total: got.reduce((s, h) => s + h.solved, 0),
                late: got.reduce((s, h) => s + h.late, 0),
                penalty: got.reduce((s, h) => s + h.penalty, 0),
            };
        };
        return { ...p, per, ...upTo(hits.length), prev: upTo(hits.length - 1) };
    });
    rows.sort(byStanding_);
    const ranks = competitionRanks_(rows.map((r) => standingKey_(r)));

    // rank before the latest contest -> movement arrows
    const prevOrder = rows.map((r, i) => i).sort((a, b) => byStanding_(prevRow_(rows[a]), prevRow_(rows[b])));
    const prevRanks = competitionRanks_(prevOrder.map((i) => standingKey_(prevRow_(rows[i]))));
    const prevRankOf = new Array(rows.length);
    prevOrder.forEach((rowIdx, j) => (prevRankOf[rowIdx] = prevRanks[j]));

    const sh = sheet_(SHEETS.LEADERBOARD);
    sh.clear();
    sh.clearConditionalFormatRules();
    sh.getCharts().forEach((c) => sh.removeChart(c));

    const FIXED = ["Rank", "Δ", "Handle", "Name", "Total solved", "Contests", "Late", "Penalty", "Trend"];
    const width = FIXED.length + n;
    const updated = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm");
    sh.getRange(1, 1).setValue(`🏆 Leaderboard  ·  ${n} contest${n === 1 ? "" : "s"}  ·  updated ${updated}`).setFontSize(14).setFontWeight("bold");

    const contestHeaders = contests.map((c) => `=HYPERLINK("#gid=${ss.getSheetByName(c.tab).getSheetId()}","${q_(c.name || c.contestId)}")`);
    const headerRange = sh.getRange(2, 1, 1, width).setValues([FIXED.concat(contestHeaders)]);
    styleHeader_(headerRange);
    headerRange.setWrap(true).setVerticalAlignment("middle");

    if (rows.length) {
        const firstC = FIXED.length + 1;
        const values = rows.map((r, i) => {
            let delta = "";
            if (n >= 2 && r.attended) {
                if (!r.prev.attended) delta = "NEW";
                else {
                    const d = prevRankOf[i] - ranks[i];
                    delta = d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "=";
                }
            }
            const row3 = i + 3;
            const trend = n
                ? `=SPARKLINE(${a1_(row3, firstC)}:${a1_(row3, firstC + n - 1)},{"charttype","column";"empty","zero";"color","#2563eb"})`
                : "";
            return [ranks[i], delta, profile_(r.handle), r.name, r.total, r.attended, r.late, r.penalty, trend].concat(r.per);
        });
        sh.getRange(3, 1, values.length, width).setValues(values);
        sh.getRange(2, 7).setNote("Problems solved after the contest ended (included in Total solved). With the same contests and solves, fewer late solves rank higher.");
        sh.getRange(2, 8).setNote("Total ICPC penalty in minutes over the contests played. Lower is better. Late solves add 0.");
        sh.getRange(3, 1, values.length, 2).setHorizontalAlignment("center");
        sh.getRange(3, 5, values.length, 4).setHorizontalAlignment("center");
        sh.getRange(3, 5, values.length, 1).setFontWeight("bold");

        const deltaRange = sh.getRange(3, 2, values.length, 1);
        const rules = medalRules_(sh, values.length, FIXED.length).concat([
            SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith("▲").setFontColor("#15803d").setRanges([deltaRange]).build(),
            SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith("▼").setFontColor("#b91c1c").setRanges([deltaRange]).build(),
            SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("NEW").setFontColor("#7c3aed").setRanges([deltaRange]).build(),
        ]);
        if (n) {
            const grid = sh.getRange(3, firstC, values.length, n).setHorizontalAlignment("center");
            rules.push(SpreadsheetApp.newConditionalFormatRule()
                .setGradientMinpoint("#ffffff").setGradientMaxpoint("#57bb8a").setRanges([grid]).build());
        }
        sh.setConditionalFormatRules(rules);
    } else {
        sh.getRange(3, 1).setValue("No data yet: add contests in the Contests tab, then Codeforces -> Refresh all contests.");
    }

    sh.setFrozenRows(2);
    sh.setFrozenColumns(3);
    sh.setRowHeight(2, 48);
    sh.setColumnWidth(1, 50).setColumnWidth(2, 50).setColumnWidth(3, 160).setColumnWidth(4, 180)
        .setColumnWidth(5, 90).setColumnWidth(6, 75).setColumnWidth(7, 55).setColumnWidth(8, 80).setColumnWidth(9, 140);
    if (n) sh.setColumnWidths(FIXED.length + 1, n, 110);

    buildProgress_(contests, rows.length);
}

// ---------- my progress ----------

function buildProgress_(contests, playerCount) {
    const sh = sheet_(SHEETS.PROGRESS);
    const lb = SHEETS.LEADERBOARD;
    const selected = sh.getRange("B1").getValue();
    sh.clear();
    sh.getCharts().forEach((c) => sh.removeChart(c));
    sh.getRange("B1").clearDataValidations();

    sh.getRange("A1").setValue("Handle ▸").setFontWeight("bold").setFontSize(12);
    const pick = sh.getRange("B1").setFontSize(12).setFontWeight("bold").setBackground("#fef9c3");
    if (playerCount) {
        const handles = SpreadsheetApp.getActive().getSheetByName(lb).getRange(`C3:C${playerCount + 2}`);
        pick.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(handles, true).build());
        pick.setValue(selected || handles.getDisplayValues()[0][0]); // keep the viewer's pick, default to #1
    }
    const m = `MATCH($B$1,${lb}!C:C,0)`;
    sh.getRange("A2:F2").setValues([[
        "Overall rank", `=IFERROR(INDEX(${lb}!A:A,${m}),"–")`,
        "Total solved", `=IFERROR(INDEX(${lb}!E:E,${m}),0)`,
        "Contests", `=IFERROR(INDEX(${lb}!F:F,${m}),0)`,
    ]]);
    sh.getRange("A2:F2").setFontWeight("bold");
    sh.getRange("B2:F2").setHorizontalAlignment("left");

    const header = ["Contest", "Solved", "Problems", "% solved", "Rank in contest", "Participants", "Tab"];
    styleHeader_(sh.getRange(4, 1, 1, header.length).setValues([header]));
    if (contests.length) {
        const values = contests.map((c, i) => {
            const r = i + 5;
            const t = `INDIRECT("'"&$G${r}&"'!`;
            const at = `MATCH($B$1,${t}B:B"),0)`;
            return [
                c.name || c.contestId,
                `=IFERROR(INDEX(${t}D:D"),${at}),"")`,
                c.problems,
                `=IF(B${r}="","",B${r}/C${r})`,
                `=IFERROR(INDEX(${t}A:A"),${at})&" / "&F${r},"absent")`,
                c.participants,
                c.tab,
            ];
        });
        sh.getRange(5, 1, values.length, header.length).setValues(values);
        sh.getRange(5, 4, values.length, 1).setNumberFormat("0%");
        sh.getRange(5, 2, values.length, 5).setHorizontalAlignment("center");

        const chart = sh.newChart()
            .setChartType(Charts.ChartType.COLUMN)
            .addRange(sh.getRange(4, 1, values.length + 1, 2))
            .setNumHeaders(1)
            .setPosition(4, 9, 0, 0)
            .setOption("title", "Problems solved per contest")
            .setOption("legend", { position: "none" })
            .setOption("colors", ["#2563eb"])
            .setOption("width", 640)
            .setOption("height", 340)
            .build();
        sh.insertChart(chart);
    }
    sh.hideColumns(7);
    sh.setFrozenRows(4);
    sh.setColumnWidth(1, 260).setColumnWidths(2, 5, 110);
}

// ---------- triggers ----------

function installTrigger() {
    removeTriggers();
    ScriptApp.newTrigger("refreshAll").timeBased().everyHours(1).create();
    SpreadsheetApp.getActive().toast("Contests with 'Auto refresh' ticked will refresh every hour.", "Auto refresh on", 8);
}

function removeTriggers() {
    ScriptApp.getProjectTriggers()
        .filter((t) => t.getHandlerFunction() === "refreshAll")
        .forEach((t) => ScriptApp.deleteTrigger(t));
}

// ---------- readers ----------

// Settings are found by the label in column A, so reordering or deleting rows can't break them.
function readSettings_() {
    const sh = sheet_(SHEETS.SETTINGS);
    const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
    const get = (label) => {
        const row = rows.find((r) => String(r[0]).trim() === label);
        return row ? row[1] : "";
    };
    return {
        apiBase: API_BASE.replace(/\/+$/, ""),
        groupId: groupFrom_(get("Group ID")),
        asManager: get("As manager") === true,
        onlyListed: get("Only listed contestants") === true,
    };
}

function setSetting_(label, value) {
    const sh = sheet_(SHEETS.SETTINGS);
    if (sh.getLastRow() < 2) return;
    const labels = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    const i = labels.findIndex((r) => String(r[0]).trim() === label);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(value);
}

// Map(lowercase handle -> { handle, name })
function readRoster_() {
    const sh = sheet_(SHEETS.CONTESTANTS);
    const out = new Map();
    if (sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(([h, name]) => {
        const handle = String(h).trim().replace(/^.*\/profile\//, "");
        if (handle) out.set(handle.toLowerCase(), { handle, name: String(name).trim() });
    });
    return out;
}

function readContests_() {
    const sh = sheet_(SHEETS.CONTESTS);
    if (sh.getLastRow() < 2) return [];
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, CC.STATUS).getValues();
    const names = sh.getRange(2, CC.NAME, rows.length, 1).getDisplayValues();
    const out = [];
    rows.forEach((r, i) => {
        const raw = String(r[CC.ID - 1]).trim();
        const id = (raw.match(/contest\/(\d+)/) || raw.match(/^(\d+)$/) || [])[1];
        if (!id) return;
        out.push({
            row: i + 2,
            contestId: id,
            groupId: groupFrom_(r[CC.GROUP - 1]) || (raw.match(/group\/([^/?#]+)/) || [])[1] || "",
            auto: r[CC.AUTO - 1] === true,
            name: names[i][0],
            problems: r[CC.PROBLEMS - 1],
            participants: r[CC.PARTICIPANTS - 1],
            tab: String(r[CC.TAB - 1] || ""),
        });
    });
    return out;
}

// ---------- helpers ----------

function sheet_(name) {
    const ss = SpreadsheetApp.getActive();
    return ss.getSheetByName(name) || ss.insertSheet(name);
}

function setStatus_(row, text) {
    sheet_(SHEETS.CONTESTS).getRange(row, CC.STATUS).setValue(text);
}

function groupFrom_(v) {
    const s = String(v || "").trim();
    const m = s.match(/group\/([^/?#]+)/);
    return m ? m[1] : /^[\w-]+$/.test(s) ? s : "";
}

// Overall order: 1) took part in more contests, 2) more problems solved, 3) fewer problems solved
// after the contest ended, 4) lower total ICPC penalty.
// Taking part comes first so that someone who played every contest always beats someone who skipped one.
// Late solves count as solved with 0 penalty, so they are compared before penalty: otherwise a late
// solver's 0 would beat an on-time solver's real penalty.
function byStanding_(a, b) {
    return b.attended - a.attended || b.total - a.total || a.late - b.late || a.penalty - b.penalty || a.handle.localeCompare(b.handle);
}

function standingKey_(r) {
    return `${r.attended}|${r.total}|${r.late}|${r.penalty}`;
}

// the same person as they stood before the latest contest
function prevRow_(r) {
    return { handle: r.handle, ...r.prev };
}

// values sorted descending -> ranks with ties sharing a rank (1,2,2,4)
function competitionRanks_(sortedDesc) {
    return sortedDesc.map((v, i, a) => (i > 0 && v === a[i - 1] ? null : i + 1))
        .reduce((acc, r) => (acc.push(r === null ? acc[acc.length - 1] : r), acc), []);
}

function medalRules_(sh, rowCount, width) {
    const range = sh.getRange(3, 1, rowCount, width);
    return [[1, COLORS.gold], [2, COLORS.silver], [3, COLORS.bronze]].map(([rank, color]) =>
        SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=$A3=${rank}`).setBackground(color).setRanges([range]).build());
}

// Only the owner can edit; on "My Progress" the B1 dropdown stays open to everyone with edit access.
// Lets you share the file as Editor so contestants can pick their handle without touching data.
function protect_(sh) {
    if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
    const p = sh.protect().setDescription("Managed by the Codeforces script");
    if (sh.getName() === SHEETS.PROGRESS) p.setUnprotectedRanges([sh.getRange("B1")]);
    p.removeEditors(p.getEditors());
    p.addEditor(Session.getEffectiveUser());
    if (p.canDomainEdit()) p.setDomainEdit(false);
}

function styleHeader_(range) {
    range.setBackground(COLORS.header).setFontColor(COLORS.headerText).setFontWeight("bold").setHorizontalAlignment("center");
}

function profile_(handle) {
    return `=HYPERLINK("https://codeforces.com/profile/${handle}","${q_(handle)}")`;
}

function a1_(row, col) {
    let s = "";
    for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    return s + row;
}

function q_(s) {
    return String(s).replace(/"/g, '""');
}

function withLock_(fn) {
    const lock = LockService.getDocumentLock();
    if (!lock.tryLock(10000)) {
        SpreadsheetApp.getActive().toast("Another refresh is already running.", "Busy", 5);
        return;
    }
    try { fn(); } finally { lock.releaseLock(); }
}
