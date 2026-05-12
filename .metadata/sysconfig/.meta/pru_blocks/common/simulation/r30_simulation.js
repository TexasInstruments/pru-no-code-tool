/**
 * Helper function to extract PRU number from system context
 * @returns {number} PRU number (0 or 1), defaults to 0 if cannot determine
 */
function getPruNumberFromContext() {
    const common = system.getScript("/common");
    const coreName = common.getSelfSysCfgCoreName();

    // coreName format: "icss_g0_pru0" or "icss_g0_pru1"
	let result = 0;
    if (coreName && coreName.includes("pru")) {
        const match = coreName.match(/pru(\d+)$/);
        if (match && match[1]) {
            result=parseInt(match[1]);
        }
    }
	if(result==0)return "PRU0";
    return "PRU1";
}
// Dummy on launch that runs something.  This just enables onComplete to be called
function onLaunch() {
	return {
		command: system.getNodePath(),
		args: ["--version"],
		initialData: "initial data",
		inSystemPath: true,
	};
}

function onComplete(result) {
	if (result.data !== "initial data") {
		throw new Error("invalid data returned");
	}

    let simulationData = system.modules["/pru_blocks/common/pru_blocks_static_module"]?.simulationData;
    let signalsToDisplay = system.modules["/pru_blocks/common/pru_blocks_static_module"]?.$static?.signalsToDisplay;
    let signalsToDisplayR31 = system.modules["/pru_blocks/common/pru_blocks_static_module"]?.$static?.signalsToDisplayR31;

    let signals = [];
    
    if(!simulationData || !simulationData.cycleCount || simulationData.cycleCount.length === 0){
        return  [{
            x : [1,2,3],
            y : [0,0,0],
            xAxisName : "Pru_clk_cycle",
            yAxisName : "Value",
            compress : true 
        }];
    }
    // Add R30 (output) signals
	if (simulationData && signalsToDisplay && Array.isArray(signalsToDisplay) && signalsToDisplay.length > 0) {
        // Create signal objects for R30 based on the signalsToDisplay configuration
        const r30Signals = signalsToDisplay.map(signalIndex => {
            const index = parseInt(signalIndex, 10);
            return {
                x: simulationData.cycleCount,
                y: simulationData.r30Bits[index],
                xAxisName: "PRU_CLK_CYCLE",
                yAxisName: `${getPruNumberFromContext()}_GPO_${index}`,
                compress: true
            };
        });
        signals.push(...r30Signals);
    } else if (simulationData) {
        // Default: show PRU_GPO_0 when signalsToDisplay is undefined
        signals.push({
            x: simulationData.cycleCount,
            y: simulationData.r30Bits[0],
            xAxisName: "PRU_CLK_CYCLE",
            yAxisName: `${getPruNumberFromContext()}_GPO_0`,
            compress: true
        });
    }

    // Add R31 (input) signals
    if (simulationData && signalsToDisplayR31 && Array.isArray(signalsToDisplayR31) && signalsToDisplayR31.length > 0) {
        // Create signal objects for R31 based on the signalsToDisplayR31 configuration
        const r31Signals = signalsToDisplayR31.map(signalIndex => {
            const index = parseInt(signalIndex, 10);
            return {
                x: simulationData.cycleCount,
                y: simulationData.r31Bits[index],
                xAxisName: "PRU_CLK_CYCLE",
                yAxisName: `${getPruNumberFromContext()}_GPI_${index}`,
                compress: true
            };
        });
        signals.push(...r31Signals);
    }

    return signals;
}

exports = {
	name: "r30_simulation",
	displayName: "r30_simulation",
	onLaunch,
	onComplete,
};
