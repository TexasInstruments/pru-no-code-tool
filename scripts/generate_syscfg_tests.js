const fs = require('fs');
const path = require('path');

const syscfgDir = path.join(__dirname, '../.metadata/sysconfig/.meta/pru_blocks');
const outDir = path.join(__dirname, '../.tmp-test-gen');

function findSyscfgFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(findSyscfgFiles(file));
        } else if (file.endsWith('.syscfg.js')) {
            results.push(file);
        }
    });
    return results;
}

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const blocks = findSyscfgFiles(syscfgDir);
let generatedFiles = [];

blocks.forEach(blockPath => {
    // Exclude common utils or static modules that are not instantiable independently
    if (blockPath.includes('common') || blockPath.includes('utils')) return;

    // Relative path for sysconfig module
    let modulePath = blockPath.split('.meta')[1].replace(/\\/g, '/').replace('.syscfg.js', '');
    const blockName = path.basename(blockPath, '.syscfg.js');

    // Some blocks like uart_rx/tx require specific context, but standard pru0 is fine for basic generation
    const syscfgContent = `/**
 * @cliArgs --device "AM243x_ALV_beta" --package "ALV" --part "ALV" --context "icss_g0_pru0" --product "PRU_NO_CODE_TOOL@01.00.01"
 */
const scripting = system.getScriptingAPI("1.27.0");

const mod = scripting.addModule("${modulePath}", {}, false);
const inst = mod.addInstance();
inst.$name = "${blockName}_instance";

// Ensure a HALT instruction is added so generation completes
const flow_control_block  = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
const flow_control_block1 = flow_control_block.addInstance();
flow_control_block1.$name  = "Flow_Control_0";
flow_control_block1.opCode = "HALT";
`;

    const outPath = path.join(outDir, `test_${blockName}.syscfg`);
    fs.writeFileSync(outPath, syscfgContent);
    generatedFiles.push(outPath);
});

console.log(`Successfully generated ${generatedFiles.length} independent syscfg test configurations in .tmp-test-gen`);
