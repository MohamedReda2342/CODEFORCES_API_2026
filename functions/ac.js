// Codeforces group standings -> { contestants: { handle: { ac: "A-B-D" } } }
// Uses the OFFICIAL Codeforces API (contest.standings), signed with an API key.
// Required env vars (Netlify -> Site configuration -> Environment variables):
//   CF_KEY, CF_SECRET   (from https://codeforces.com/settings/api, account must be in the group)
// Optional: PAGE_SIZE (default 200) - rows per "page", keeps the old /p/:page URLs working.

const crypto = require("crypto");
const express = require("express");
const serverless = require("serverless-http");
const axios = require("axios");

const app = express();
const router = express.Router();

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE, 10) || 200;

// env flag helper: tolerates quotes/spaces/case, e.g. "true", ' True '
const envOn = (name) => String(process.env[name] || "").replace(/["'\s]/g, "").toLowerCase() === "true";

// Signed request to the official API
async function cfApi(method, params) {
    const key = process.env.CF_KEY;
    const secret = process.env.CF_SECRET;
    if (!key || !secret) {
        throw new Error("CF_KEY / CF_SECRET environment variables are not set");
    }

    const all = { ...params, apiKey: key, time: Math.floor(Date.now() / 1000) };
    const query = Object.entries(all)
        .sort(([ak, av], [bk, bv]) => (ak === bk ? String(av).localeCompare(String(bv)) : ak.localeCompare(bk)))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");

    const rand = crypto.randomBytes(3).toString("hex"); // 6 chars
    const hash = crypto
        .createHash("sha512")
        .update(`${rand}/${method}?${query}#${secret}`)
        .digest("hex");

    const res = await axios.get(
        `https://codeforces.com/api/${method}?${query}&apiSig=${rand}${hash}`,
        { timeout: 15000, validateStatus: () => true }
    );
    if (res.data && res.data.status === "OK") return res.data.result;
    const comment = res.data && res.data.comment ? res.data.comment : `HTTP ${res.status}`;
    throw new Error(comment);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallback used when contest.standings can't see a group contest.
// Returns the same shape as getAc; all contestants come back on page 1.
async function getAcFromStatus(groupId, contestId, pageNum, handles, asManager, link, standingsErr) {
    const statusParams = { contestId, groupCode: groupId };
    if (asManager) statusParams.asManager = "true";
    let subs;
    try {
        subs = await cfApi("contest.status", statusParams);
    } catch (statusErr) {
        throw new Error(`standings: ${standingsErr.message} | status: ${statusErr.message}`);
    }

    const wanted = handles ? new Set(handles.split(";").map((h) => h.trim().toLowerCase())) : null;
    const problemsByIndex = {};
    const solvedBy = {};
    for (const s of subs) {
        problemsByIndex[s.problem.index] = s.problem.name;
        for (const m of s.author.members) {
            if (wanted && !wanted.has(m.handle.toLowerCase())) continue;
            if (!solvedBy[m.handle]) solvedBy[m.handle] = new Set();
            if (s.verdict === "OK") solvedBy[m.handle].add(s.problem.index);
        }
    }

    // ICPC penalty rebuilt from submissions: per solved problem, the minute of the first
    // accepted run + 20 for every earlier rejected run (compilation errors are free).
    const tries = {}; // handle -> problem index -> { rejected, solvedAt }
    const chronological = [...subs].sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds);
    for (const s of chronological) {
        if (s.author.participantType === "PRACTICE" || s.author.participantType === "VIRTUAL") continue; // after the contest: counts as solved, 0 penalty
        for (const m of s.author.members) {
            if (wanted && !wanted.has(m.handle.toLowerCase())) continue;
            const t = ((tries[m.handle] = tries[m.handle] || {})[s.problem.index] =
                tries[m.handle][s.problem.index] || { rejected: 0, solvedAt: null });
            if (t.solvedAt !== null) continue;
            if (s.verdict === "OK") t.solvedAt = Math.floor(s.relativeTimeSeconds / 60);
            else if (s.verdict !== "COMPILATION_ERROR") t.rejected++;
        }
    }
    const penaltyOf = (handle) =>
        Object.values(tries[handle] || {}).reduce((sum, t) => sum + (t.solvedAt === null ? 0 : t.solvedAt + 20 * t.rejected), 0);

    const indexes = Object.keys(problemsByIndex).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const contestants = {};
    if (pageNum === 1) {
        for (const [handle, set] of Object.entries(solvedBy)) {
            contestants[handle] = { ac: indexes.filter((i) => set.has(i)).join("-"), penalty: penaltyOf(handle), tried: true };
        }
    }

    // contest name (best effort; wait to respect the API's 1 call / 2s limit)
    let name = `Contest ${contestId}`;
    try {
        await sleep(2100);
        const list = await cfApi("contest.list", { groupCode: groupId });
        const c = list.find((x) => String(x.id) === String(contestId));
        if (c) name = c.name;
    } catch (_) { /* keep default name */ }

    return {
        status: "OK",
        result: {
            contest: {
                name,
                link,
                problems: indexes.map((i) => ({ name: `${i} - ${problemsByIndex[i]}`, link: `${link}/problem/${i}` })),
            },
            contestants,
            page: pageNum,
            hasMore: false,
            source: "contest.status", // problems nobody submitted are not listed
        },
    };
}

const getAc = async (groupId, contestId, page, handles, asManager) => {
    try {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const params = {
            contestId,
            groupCode: groupId, // group contests are only found when the group is given
            from: (pageNum - 1) * PAGE_SIZE + 1,
            count: PAGE_SIZE,
            showUnofficial: "true",
        };
        if (handles) params.handles = handles; // semicolon separated
        // managers of the group can read its contests with asManager=true
        // (env CF_AS_MANAGER=true for always, or ?asManager=true per request)
        if (asManager || envOn("CF_AS_MANAGER")) params.asManager = "true";

        const link = `https://codeforces.com/group/${groupId}/contest/${contestId}`;
        let result;
        try {
            result = await cfApi("contest.standings", params);
        } catch (standingsErr) {
            if (!/not found/i.test(standingsErr.message)) throw standingsErr;
            // Fallback: build "who solved what" from the contest's submissions
            return await getAcFromStatus(groupId, contestId, pageNum, handles, params.asManager, link, standingsErr);
        }

        const problems = result.problems.map((p) => ({
            name: `${p.index} - ${p.name}`,
            link: `${link}/problem/${p.index}`,
        }));

        // Penalty is rebuilt per problem instead of using row.penalty: for problems solved after the
        // contest ended Codeforces reports a huge placeholder time (about 35 million minutes each).
        // Those problems still count as solved, with 0 penalty.
        const limit = Number.isFinite(result.contest.durationSeconds) ? result.contest.durationSeconds : Infinity;
        const byHandle = {}; // handle -> { problems: { index -> penalty in minutes }, tried }
        for (const row of result.rows) {
            // practice and virtual runs happen after the contest, so they never carry a penalty
            const late = row.party.participantType === "PRACTICE" || row.party.participantType === "VIRTUAL";
            const mine = {};
            let tried = false; // false for registered people who never submitted
            row.problemResults.forEach((pr, i) => {
                if (pr.points > 0) {
                    const t = pr.bestSubmissionTimeSeconds;
                    const onTime = !late && Number.isFinite(t) && t <= limit;
                    mine[result.problems[i].index] = onTime ? Math.floor(t / 60) + 20 * (pr.rejectedAttemptCount || 0) : 0;
                }
                if (pr.points > 0 || pr.rejectedAttemptCount > 0) tried = true;
            });
            // team rows have several members; everyone gets the same solves
            for (const m of row.party.members) {
                const h = (byHandle[m.handle] = byHandle[m.handle] || { problems: {}, tried: false });
                h.tried = h.tried || tried;
                for (const [index, penalty] of Object.entries(mine)) {
                    // one handle can have an in-contest row and a later practice row: keep the in-contest penalty
                    if (!(index in h.problems) || (h.problems[index] === 0 && penalty > 0)) h.problems[index] = penalty;
                }
            }
        }

        const contestants = {};
        for (const [handle, h] of Object.entries(byHandle)) {
            const solvedIndexes = result.problems.map((p) => p.index).filter((i) => i in h.problems);
            const penalty = solvedIndexes.reduce((sum, i) => sum + h.problems[i], 0);
            contestants[handle] = { ac: solvedIndexes.join("-"), penalty, tried: h.tried };
        }

        return {
            status: "OK",
            result: {
                contest: { name: result.contest.name, link, problems },
                contestants,
                page: pageNum,
                hasMore: result.rows.length === PAGE_SIZE,
            },
        };
    } catch (err) {
        return {
            status: "FAILED",
            result: "There is something wrong :(",
            err: err.message,
        };
    }
};

// /g/:groupId/c/:contestId/p/:page            (optional ?handles=a;b;c)
// /g/:groupId/c/:contestId/p/:page/l/:listId  (listId is accepted for old URLs but ignored:
//                                              the official API has no list filter, use ?handles=)
router.get("/g/:groupId/c/:contestId/p/:page", async (req, res) => {
    const { groupId, contestId, page } = req.params;
    res.status(200).send(await getAc(groupId, contestId, page, req.query.handles, req.query.asManager === "true"));
});

router.get("/g/:groupId/c/:contestId/p/:page/l/:listId", async (req, res) => {
    const { groupId, contestId, page } = req.params;
    res.status(200).send(await getAc(groupId, contestId, page, req.query.handles, req.query.asManager === "true"));
});

// Diagnostic: which contests of a group can the API key's account see?
// Disabled unless the env var CF_DEBUG=true (it would expose group contest names publicly).
router.get("/debug/:groupId", async (req, res) => {
    if (!envOn("CF_DEBUG")) {
        return res.status(404).send({ status: "FAILED", err: "debug disabled (set CF_DEBUG=true)" });
    }
    try {
        const list = await cfApi("contest.list", { groupCode: req.params.groupId });
        res.status(200).send({
            status: "OK",
            count: list.length,
            contests: list.map((c) => ({ id: c.id, name: c.name, phase: c.phase, type: c.type })),
        });
    } catch (err) {
        res.status(200).send({ status: "FAILED", err: err.message });
    }
});

// Netlify may pass either the rewritten or the original path
app.use("/.netlify/functions/ac", router);
app.use("/ac", router);

module.exports.handler = serverless(app);
