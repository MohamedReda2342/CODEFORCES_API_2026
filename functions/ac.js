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

const getAc = async (groupId, contestId, page, handles, asManager) => {
    try {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const params = {
            contestId,
            from: (pageNum - 1) * PAGE_SIZE + 1,
            count: PAGE_SIZE,
            showUnofficial: "true",
        };
        if (handles) params.handles = handles; // semicolon separated
        // managers of the group can read its contests with asManager=true
        // (env CF_AS_MANAGER=true for always, or ?asManager=true per request)
        if (asManager || process.env.CF_AS_MANAGER === "true") params.asManager = "true";

        const result = await cfApi("contest.standings", params);
        const link = `https://codeforces.com/group/${groupId}/contest/${contestId}`;

        const problems = result.problems.map((p) => ({
            name: `${p.index} - ${p.name}`,
            link: `${link}/problem/${p.index}`,
        }));

        const contestants = {};
        for (const row of result.rows) {
            // team rows have several members; everyone gets the same solves
            const solved = [];
            row.problemResults.forEach((pr, i) => {
                if (pr.points > 0) solved.push(result.problems[i].index);
            });
            for (const m of row.party.members) {
                contestants[m.handle] = { ac: solved.join("-") };
            }
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
    if (process.env.CF_DEBUG !== "true") {
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
