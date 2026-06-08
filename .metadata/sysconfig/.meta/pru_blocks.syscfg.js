let common = system.getScript("/common");
let soc = system.getScript(`soc/pru_blocks_${common.getSocName()}`);

function getTemplates()
{
    let templates = [];
    if(common.getSelfSysCfgCoreName().includes('pru'))
    {
        templates.push(
            {
                name: "pru_blocks/common/pru_syscfg.asm.xdt",
                outputPath: "pru_syscfg.asm",
                alwaysRun: true,
            },
            {
                name: "pru_blocks/common/pru_syscfg.inc.xdt",
                outputPath: "pru_syscfg.inc",
                alwaysRun: true,
            },
        )
    }
    return templates;
}

exports = {
    displayName: "PRU-BLOCKS",
    templates: getTemplates(),
    topModules: soc.getTopModules(),
    views: soc.getViews(),
    graphable: {
        portTypes: [
            {
                type: "input",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "output",
                side: "right",
                multipleConnections: true,
            },
            // Typed data ports — width-enforced connections
            {
                type: "input32",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "output32",
                side: "right",
                multipleConnections: true,
            },
            {
                type: "input64",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "output64",
                side: "right",
                multipleConnections: true,
            },
            {
                type: "CONDITIONAL_NEXT",
                side: "right",
                multipleConnections: false,
            },
            {
                type: "CONDITIONAL_PREV",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "NEXT",
                side: "right",
                multipleConnections: false,
            },
            {
                type: "PREV",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "IO_PREV",
                side: "left",
                multipleConnections: false,
            },
            {
                type: "IO_NEXT",
                side: "right",
                multipleConnections: false,
            }
        ],
        connectionTypes: [
            {
                start: "output",
                end: "input",
                type: "data",
                displayName: "dataflow",
            },
            // Typed width-enforced data connections
            {
                start: "output32",
                end: "input32",
                type: "data",
                displayName: "dataflow32",
            },
            {
                start: "output64",
                end: "input64",
                type: "data",
                displayName: "dataflow64",
            },
            {
                start: "CONDITIONAL_NEXT",
                end: "PREV",
                type: "defaultArrow",
                displayName: "conditinalBlockToGenericBlockFlow",
            },
            {
                start: "CONDITIONAL_NEXT",
                end: "IO_PREV",
                type: "defaultArrow",
                displayName: "conditinalBlockToIoBlockFlow",
            },
            {
                start: "CONDITIONAL_NEXT",
                end: "CONDITIONAL_PREV",
                type: "defaultArrow",
                displayName: "conditinalBlockToConditionalBlockFlow",
            },
            {
                
                start: "NEXT",
                end: "IO_PREV",
                type: "defaultArrow",
                displayName: "genericBlockToIoBlockFlow",
            },
            {
                
                start: "NEXT",
                end:   "PREV",
                type: "defaultArrow",
                displayName: "genericBlockTogenricBlockFlow",
            },
            {
                
                start: "NEXT",
                end:   "CONDITIONAL_PREV",
                type: "defaultArrow",
                displayName: "genericBlockToConditionalBlockFlow",
            },
            {
                
                start: "IO_NEXT",
                end: "PREV",
                type: "defaultArrow",
                displayName: "ioBlockToGenericBlockFlow",
            },
            {
                
                start: "IO_NEXT",
                end: "CONDITIONAL_PREV",
                type: "defaultArrow",
                displayName: "ioBlockToConditinalBlockFlow",
            },
            {
                
                start: "IO_NEXT",
                end: "IO_PREV",
                type: "defaultArrow",
                displayName: "ioBlockIoBlockFlow",
            },

            //<X_PREV> ports have same name(prev) used while creating block
            //<X_NEXT> ports have same name(next) used while creating block

            //<X>_NEXT to input is not allowed
            //output to <X>_PREV is not allowed

            //For each block
            //first prev ports get processed
            //second input ports get processed
            //while processing prev and input ports all the nodes are pushed into set to compute peak cycle path
            //<opcode> <output port value> <input port values> <constant values>

            //graph processing : bottom up approach start from program end block
        ]
    },
    simulations: [
		require("pru_blocks/common/simulation/r30_simulation"),
	]
};
