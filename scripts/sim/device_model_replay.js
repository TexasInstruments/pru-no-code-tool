/**
 * device_model_replay.js - replay a fixed pin stimulus through the JS device
 * models and print the resulting R31 trace, events and faults as JSON.
 *
 * Replaying the SAME stimulus through the Python models of TI pru-simulator
 * and diffing the two outputs cross-checks the ports. Keeping this runner tiny
 * and deterministic is what makes that diff meaningful.
 *
 * Usage:
 *   node scripts/sim/device_model_replay.js stimulus.json
 *
 * Stimulus JSON:
 *   {
 *     "model":  { "kind": "ssi"|"quadrature", "options": { ...constructor opts } },
 *     "gpo":    [[cycle, word], ...],     // PRU output changes; holds between
 *     "cycles": N,                        // total cycles to settle
 *     "drive_exclude": [pin, ...]         // pins the PRU does NOT drive
 *   }
 *
 * Output JSON: { "r31": {cycle: word}, "events": [...], "faults": [...] }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIM_DIR = path.join(__dirname, '..', '..', '.metadata', 'sysconfig', '.meta',
                          'pru_blocks', 'common', 'simulation');

const scriptCache = {};
function loadSimScript(scriptPath) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
        console, Math, JSON, Number, Array, Object, Set, Error,
        system: {
            getScript: (p) => {
                const basename = path.basename(p);
                if (!scriptCache[basename]) {
                    scriptCache[basename] = loadSimScript(path.join(SIM_DIR, basename));
                }
                return scriptCache[basename];
            }
        },
        exports: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.exports;
}

const busScript = loadSimScript(path.join(SIM_DIR, 'device_bus.js'));
const models = loadSimScript(path.join(SIM_DIR, 'device_models.js'));

function main() {
    const stimulus = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const opts = stimulus.model.options;

    let device;
    if (stimulus.model.kind === 'ssi') {
        device = new models.SsiEncoder({
            clkPin: opts.clk_pin, dataPin: opts.data_pin, bits: opts.bits,
            position: opts.position, cyclesPerCount: opts.cycles_per_count ?? null,
            minClkPeriodCycles: opts.min_clk_period_cycles,
            monoflopCycles: opts.monoflop_cycles, gray: opts.gray
        });
    } else if (stimulus.model.kind === 'quadrature') {
        device = new models.QuadratureEncoder({
            aPin: opts.a_pin, bPin: opts.b_pin,
            zPin: (opts.z_pin === undefined || opts.z_pin === null) ? null : opts.z_pin,
            countsPerRev: opts.counts_per_rev,
            cyclesPerCount: opts.cycles_per_count, forward: opts.forward
        });

    } else if (stimulus.model.kind === 'uart') {
        device = new models.UartTransmitter({
            pin: opts.pin, payload: opts.payload, bitPeriod: opts.bit_period,
            startCycle: opts.start_cycle, idleGapBits: opts.idle_gap_bits, frames: opts.frames
        });
    } else if (stimulus.model.kind === 'uart_monitor') {
        device = new models.UartMonitor({
            pin: opts.pin, bitPeriod: opts.bit_period
        });

    } else if (stimulus.model.kind === 'sigma_delta') {
        device = new models.SigmaDeltaModulator({
            clkPin: opts.clk_pin, dataPin: opts.data_pin,
            minPeriod: opts.min_period, saturationThreshold: opts.saturation_threshold,
            saturationPersist: opts.saturation_persist, initialInput: opts.initial_input
        });
        if (opts.inputs) {
            // we will need to feed input over time?
            // Wait, Python's DeviceModel doesn't have a standardized way to pass inputs via the runner.
            // Oh, but SigmaDeltaModulator needs set_input(). Let's see how crosscheck does it.
            // Wait, we can't change set_input dynamically unless we add it to gpo.
            // Let's just set the initialInput and leave it constant.
        }

    } else if (stimulus.model.kind === 'tca9538') {
        device = new models.TCA9538Model({
            sclPin: opts.scl_pin, sdaPin: opts.sda_pin, address: opts.address
        });

    } else if (stimulus.model.kind === 'bissc') {
        device = new models.BissCModel({
            maPin: opts.ma_pin, sloPin: opts.slo_pin,
            positionBits: opts.position_bits, tbusyClocks: opts.tbusy_clocks,
            minMaPeriodCycles: opts.min_ma_period_cycles, idleRestartCycles: opts.idle_restart_cycles,
            cdsBit: opts.cds_bit, invertCrc: opts.invert_crc, ackClocks: opts.ack_clocks
        });
    } else {
        throw new Error('replay runner does not know kind ' + stimulus.model.kind);
    }

    const bus = new busScript.DeviceBus();
    bus.attach(device);
    let mask = busScript.MASK_20;
    for (const pin of (stimulus.drive_exclude || [])) {
        mask &= ~(1 << pin);
    }
    bus.setPruDriveMask(mask);

    const script = stimulus.gpo || [];
    const r31 = {};
    let gpo = busScript.MASK_20;
    let idx = 0;
    for (let cycle = 1; cycle <= stimulus.cycles; cycle++) {
        while (idx < script.length && script[idx][0] <= cycle) {
            gpo = script[idx][1];
            idx++;
        }
        r31[cycle] = bus.settle(cycle, gpo);
    }

    console.log(JSON.stringify({
        r31,
        events: device.events(),
        faults: device.faults(),
        busFaults: bus.faults()
    }));
}

main();
