const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const router = express.Router();

const { getDataPath } = require("../lib/dataPath");

async function readPolicies() {
  const p = getDataPath("mock", "insurance_policies.json");
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

router.get("/:insurerId", async (req, res) => {
  try {
    const policies = await readPolicies();
    let insurer = policies?.[req.params.insurerId];
    if (!insurer && req.params.insurerId) {
      const q = req.params.insurerId.toLowerCase().trim();
      insurer = Object.values(policies || {}).find(p =>
        (p.name && (p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()))) ||
        (p.insurer_id && p.insurer_id.toLowerCase() === q)
      );
    }
    if (!insurer) return res.status(404).json({ error: "insurer not found" });
    return res.json({ insurer_id: req.params.insurerId, ...insurer });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

module.exports = router;

