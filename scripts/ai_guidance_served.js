'use strict';
/**
 * ai_guidance_served.js - is each block's AI guidance what SysConfig 1.28's MCP serves?
 *
 * SysConfig 1.28's getModuleDescription returns the module's longDescription and never calls
 * getAIContext. A module that defines getAIContext therefore only reaches an AI assistant if the text
 * it returns is contained in its longDescription. Each module is LOADED (not regexed); the
 * values are the ones the real module exports.
 *
 * CLI: node scripts/ai_guidance_served.js [blocksRoot]
 *   prints JSON { modules: [{ rel, aiContextLength, served }], errors: [...] }; served is true
 *   when the getAIContext() text is contained in longDescription. Exit 1 on a load error.
 */
const fs = require('fs');
const path = require('path');
const { loadModule, DEFAULT_ROOT } = require('./pin_usage_blocks');

function report(blocksRoot = DEFAULT_ROOT) {
    const modules = [], errors = [];
    const walk = (d) => {
        for (const f of fs.readdirSync(d).sort()) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (!f.endsWith('.syscfg.js') || !fs.readFileSync(p, 'utf8').includes('getAIContext')) continue;
            const rel = path.relative(blocksRoot, p).split(path.sep).join('/');
            try {
                const exp = loadModule(p);
                if (typeof exp.getAIContext !== 'function') {
                    if (/function\s+getAIContext\b/.test(fs.readFileSync(p, 'utf8')))
                        errors.push({ rel, error: 'defines getAIContext but does not export it' });
                    continue;
                }
                const ai = String(exp.getAIContext());
                const served = typeof exp.longDescription === 'string' && exp.longDescription.includes(ai);
                modules.push({ rel, aiContextLength: ai.length, served });
            } catch (e) { errors.push({ rel, error: String(e && e.message) }); }
        }
    };
    walk(blocksRoot);
    return { modules, errors };
}

module.exports = { report };

if (require.main === module) {
    const r = report(process.argv[2] || DEFAULT_ROOT);
    console.log(JSON.stringify(r));
    process.exit(r.errors.length ? 1 : 0);
}
