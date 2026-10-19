const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// 1. Import ONLY the routes that actually exist in your folder
const agentRoutes     = require("./routes/agent.routes");
const analyzeRoutes   = require("./routes/analyze.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const appealsRoutes   = require("./routes/appeals.routes");
const alertsRoutes    = require("./routes/alerts.routes");
const documentsRoutes = require("./routes/documents.routes");
const ehrRoutes       = require("./routes/ehr.routes");
const insuranceRoutes = require("./routes/insurance.routes");
const insurerRoutes   = require("./routes/insurer.routes");

const path = require("path");
const InsuranceLogicManager = require("./logic");

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const { getDataPath } = require("./lib/dataPath");

const logicManager = new InsuranceLogicManager({
  gapCsv: getDataPath("processed", "gap_analysis_data.csv"),
  riskCsv: getDataPath("processed", "risk_training_data.csv"),
  icdCsv: getDataPath("processed", "icd10_lookup_clean.csv"),
});

const initPromise = logicManager.init().then(() => {
  app.use((req, res, next) => {
    req.logicManager = logicManager;
    next();
  });

  // 2. Mount the routes
  app.use("/api/agent",      agentRoutes);
  app.use("/api/analyze",    analyzeRoutes);
  app.use("/api/analytics",  analyticsRoutes);
  app.use("/api/appeals",    appealsRoutes);
  app.use("/api/alerts",     alertsRoutes);
  app.use("/api/documents",  documentsRoutes);
  app.use("/api/ehr",        ehrRoutes);
  app.use("/api/insurance",  insuranceRoutes);
  app.use("/api/insurer",    insurerRoutes);

  return app;
});

// Start local server if run directly (e.g. `node server.js`)
if (require.main === module) {
  initPromise.then(() => {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`🚀 Express API running on port ${PORT}`);
      startAiEngine();
    });
  }).catch(err => {
    console.error("Failed to initialize LogicManager:", err);
    process.exit(1);
  });
}

module.exports = { app, initPromise };

function startAiEngine() {
  const fs = require("fs");
  const http = require("http");
  const { spawn, execSync } = require("child_process");

  const aiEngineDir = path.join(__dirname, "..", "ai-engine");
  const mainPy = path.join(aiEngineDir, "main.py");
  if (!fs.existsSync(mainPy)) {
    return;
  }

  // Check if FastAPI is already running
  const req = http.get("http://127.0.0.1:8001/health", (res) => {
    if (res.statusCode === 200) {
      console.log("✅ AI Engine (FastAPI) is active on http://localhost:8001");
    }
  });

  req.on("error", () => {
    let pythonCmd = "python";
    let args = ["main.py"];

    const localAppData = process.env.LOCALAPPDATA;
    const python314 = localAppData ? path.join(localAppData, "Python", "pythoncore-3.14-64", "python.exe") : null;
    const pythonBin = localAppData ? path.join(localAppData, "Python", "bin", "python.exe") : null;

    if (python314 && fs.existsSync(python314)) {
      pythonCmd = python314;
    } else if (pythonBin && fs.existsSync(pythonBin)) {
      pythonCmd = pythonBin;
    } else {
      try {
        execSync("py --version", { stdio: "ignore" });
        pythonCmd = "py";
        args = ["-3", "main.py"];
      } catch (_) {}
    }

    try {
      const pythonProcess = spawn(pythonCmd, args, { cwd: aiEngineDir });
      pythonProcess.stdout.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[AI Engine] ${msg}`);
      });
      pythonProcess.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("InconsistentVersionWarning")) {
          console.error(`[AI Engine] ${msg}`);
        }
      });
      pythonProcess.on("error", (err) => {
        console.warn(`⚠️ Could not auto-start AI Engine (${err.message}). Run manually: cd ai-engine && py main.py`);
      });
      process.on("exit", () => {
        try { pythonProcess.kill(); } catch (_) {}
      });
    } catch (e) {
      console.warn("⚠️ Could not auto-start AI Engine. Run manually: cd ai-engine && py main.py");
    }
  });
}
