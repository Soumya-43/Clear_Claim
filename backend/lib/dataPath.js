const path = require("path");
const fs = require("fs");

function getDataPath(...subpaths) {
  const candidates = [
    path.join(__dirname, "..", "..", "data", ...subpaths),
    path.join(__dirname, "..", "data", ...subpaths),
    path.join(__dirname, "data", ...subpaths),
    path.join(process.cwd(), "data", ...subpaths),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

module.exports = { getDataPath };
