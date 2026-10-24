// Print the SysConfig palette module list of a SoC file as JSON, by
// EVALUATING it the way SysConfig does (comments and dead code do not count).
// usage: node scripts/dump_soc_palette.js <pru_blocks_<soc>.syscfg.js> [coreName]
// coreName defaults to icss_g0_pru0 (the PRU list); pass icss_g0_rtu_pru0 for the RTU/TX list.
const fs = require("fs");
const file = process.argv[2];
const core = process.argv[3] || "icss_g0_pru0";
const system = { getScript: () => ({ getSelfSysCfgCoreName: () => core }) };
const ex = new Function("system", "var exports;\n" + fs.readFileSync(file, "utf8") + "\n;return exports;")(system);
const out = [];
(function walk(o, cat) {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, cat)); return; }
    if (!o || typeof o !== "object") return;
    const here = o.displayName ? cat.concat(o.displayName) : cat;
    (o.modules || []).forEach((m) => out.push({ module: m, category: here.join(" > ") }));
    walk(o.categories || [], here);
})(ex.getTopModules(), []);
process.stdout.write(JSON.stringify(out));
