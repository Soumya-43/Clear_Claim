const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const router = express.Router();

const { getDataPath } = require("../lib/dataPath");

async function readMockEhr() {
  const p = getDataPath("mock", "patient_ehr.json");
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

router.get("/:patientId", async (req, res) => {
  try {
    const ehr = await readMockEhr();
    if (ehr?.patient_id && ehr.patient_id !== req.params.patientId) {
      return res.status(404).json({ error: "patient not found" });
    }
    return res.json(ehr);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

module.exports = router;

