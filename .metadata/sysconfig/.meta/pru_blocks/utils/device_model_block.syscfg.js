/**
 * Device Model block (part A).
 *
 * Makes the device the design is simulated against a visible thing in the
 * design instead of a row of fields inside Simulation Settings. One instance is
 * one attached device: its kind, the pins it drives and listens on, and its
 * parameters as typed fields.
 *
 * It generates NO firmware (declaration only, like Memory Variable). Its one
 * output is a binding in pru_device_bindings.json, in the same shape the GPI
 * device fields in Simulation Settings produce, so TI pru-simulator attaches it
 * through the same code path and the same safety checks.
 *
 * The GPI device fields keep working: this is an ADDITIONAL source (decision on
 *). A pin claimed by both sources is an error that names both.
 */
const table = system.getScript("/pru_blocks/common/device_model_table.js");

const STATIC_MODULE = "/pru_blocks/common/pru_blocks_static_module";
const SELF_MODULE = "/pru_blocks/utils/device_model_block";
const DEFAULT_KIND = "ssi";

// Slot -> default pin, so a fresh instance of any kind starts on distinct pins (table.defaultPin, shared with the command-line pin check).
const defaultPin = table.defaultPin;

function kindOptions() {
    return Object.keys(table.KINDS).map(function (k) {
        return { name: k, displayName: table.KINDS[k].displayName };
    });
}

// The typed fields. Only the selected kind's fields are shown (onChange below);
// all of them exist in the schema so SysConfig can always load a saved design.
function kindConfigs() {
    const configs = [];
    for (const kind of Object.keys(table.KINDS)) {
        const spec = table.KINDS[kind];
        const hidden = kind !== DEFAULT_KIND;
        for (const pf of table.pinFields(kind)) {
            configs.push({
                name: pf.field,
                displayName: table.displayTitle(pf.spec),
                description: (pf.spec.drives
                    ? "Pin the DEVICE drives (the PRU reads it)." + (pf.spec.optional ? " -1 if unused." : "")
                    : "Pin the PRU drives (the device only listens)." + (pf.spec.optional ? " -1 if unused." : ""))
                    + (pf.spec.hint ? " " + pf.spec.hint : ""),
                default: defaultPin(pf.spec),
                hidden: hidden
            });
        }
        for (const pf of table.paramFields(kind)) {
            const p = pf.spec;
            const cfg = {
                name: pf.field,
                displayName: table.displayTitle(p),
                default: p.def,
                hidden: hidden
            };
            if (p.type === "int" || p.type === "float") {
                const lo = p.min !== undefined ? p.min : "-inf";
                const hi = p.max !== undefined ? p.max : "inf";
                cfg.description = "Range " + lo + " .. " + hi + ".";
            }
            if (p.hint) {
                cfg.description = p.hint;
            }
            configs.push(cfg);
        }
    }
    return configs;
}

function currentInstances() {
    const mod = (typeof system !== "undefined" && system.modules) ? system.modules[SELF_MODULE] : null;
    return (mod && mod.$instances) || [];
}

function gpiClaims() {
    if (typeof system === "undefined" || !system.modules) return [];
    const sm = system.modules[STATIC_MODULE];
    if (!sm || !sm.$static || typeof sm.collectGpiDeviceClaims !== "function") return [];
    return sm.collectGpiDeviceClaims(sm.$static);
}

// Read-only text for the GUI: who drives what, and which block reads it.
function pinSummary(inst) {
    const spec = table.KINDS[inst.deviceKind];
    if (!spec) return "";
    const drives = [], listens = [];
    for (const pf of table.pinFields(inst.deviceKind)) {
        const v = inst[pf.field];
        if (v === -1 && pf.spec.optional) continue;
        (pf.spec.drives ? drives : listens).push(pf.spec.label + " = pin " + v);
    }
    return "drives: " + (drives.length ? drives.join(", ") : "nothing (every pin is a PRU output)") +
           " | listens on: " + (listens.length ? listens.join(", ") : "nothing");
}

function readBySummary(inst) {
    if (!table.READER_BLOCKS[inst.deviceKind]) {
        return "no block in this tool decodes a '" + inst.deviceKind + "' device (run reports NOT CHECKED)";
    }
    const primary = table.toBinding(inst).primaryPin;
    const readers = table.findReaderInstances(inst.deviceKind, primary,
        (typeof system !== "undefined" && system.modules) ? system.modules : null);
    return readers.length
        ? readers.map(function (r) { return r.inst.$name; }).join(", ")
        : "no block reads pin " + primary + " yet";
}

// This block has no Run button of its own (one launcher, one verdict path: the button lives in
// Simulation Settings). Say where it is instead of leaving the user to hunt for it. One text, true whether or not
// the design added the module itself: this block pulls the static module in (moduleStatic.modules below), so
// system.modules always lists it and cannot tell a design that shows the pane from one that does not.
function runHint(inst) {
    return "Run lives in Simulation Settings (SIMULATION SETTINGS in the module list; add it from there if you do "
        + "not see it) > Real Simulation > Run on TI pru-simulator (save the design first).";
}

function validate(inst, report) {
    for (const e of table.checkInstance(inst)) {
        report.logError(e.message, inst, e.field);
    }
    if (!table.KINDS[inst.deviceKind]) return;

    const mine = table.claimedPins(inst);
    const myClock = table.clockPin(inst);

    // Another Device Model instance on one of my pins.
    for (const other of currentInstances()) {
        if (other === inst || !table.KINDS[other.deviceKind]) continue;
        const otherClock = table.clockPin(other);
        for (const a of mine) {
            for (const b of table.claimedPins(other)) {
                if (a.pin === b.pin) {
                    // Two PRU-driven clocks on one pin can be legal wiring (one CLK fanned out to two
                    // encoders), but pru_device_bindings.json attaches one model per pin: refuse, say why.
                    const sharedClock = a.pin === myClock && b.pin === otherClock;
                    report.logError(
                        "Pin " + a.pin + " is claimed by Device Model '" + inst.$name + "' (" + inst.deviceKind + ", " + a.label +
                        ") and by Device Model '" + other.$name + "' (" + other.deviceKind + ", " + b.label +
                        "). Two models on one net is a short, not a configuration" +
                        (sharedClock ? "; shared clock between device models is not supported by the simulator yet." : "."),
                        inst, "deviceKind");
                }
            }
        }
    }

    // The GPI device fields in Simulation Settings: the other source.
    for (const claim of gpiClaims()) {
        for (const a of mine) {
            for (const b of claim.pins) {
                if (a.pin === b.pin) {
                    report.logError(
                        "Pin " + a.pin + " is claimed by Device Model '" + inst.$name + "' (" + inst.deviceKind + ", " + a.label +
                        ") and by the Simulation Settings GPI" + claim.pinNum + " device (" + claim.kind + ", " + b.label +
                        "). A pin cannot have two device sources: remove one of them.",
                        inst, "deviceKind");
                }
            }
        }
    }
}

function getLongDescription() {
    return `
### Device Model

Attaches a simulated device to the design - an SSI or BiSS-C encoder, a quadrature encoder, a UART transmitter, a SPI ADC and so on - as a block you can see, name and configure with typed fields. TI pru-simulator runs the real firmware against it (\`gmake sim\`, or **Run on TI pru-simulator** in the GUI).

**It generates no firmware.** It only adds one binding to \`pru_device_bindings.json\`.

**Two sources, one manifest.** Simulation Settings also attaches devices through its per-pin *GPIn Input Mode = Device* fields. Both work; neither is migrated. A pin claimed by both is an ERROR that names both.

**Pins.** Each pin says who drives it: *device drives* pins are read by the PRU; *PRU drives* pins are only listened to by the device. The Pins summary and the Read by field are computed for you.

**One driver per PRU-driven pin.** A GPO that a *PRU drives* pin listens on may be driven only by the blocks that talk to that device; any other block on that GPO, such as a SPI write sharing the clock, is an ERROR because the device counts its output as extra edges. Which blocks, per kind: the SSI, BiSS-C, EnDat and sigma-delta clocks accept only the reader block whose data pin is the device's data pin (SSI, BiSS-C or EnDat initiator, PDM microphone), shown in *Read by*; MDIO's MDC accepts an MDIO master whose MDIO pin is the device's; a SPI ADC's SCLK and MOSI are shared between chips so any SPI block may drive them, but its CS accepts only a SPI block whose CS pin is the device's; STEP/DIR and WS2812 accept the stepper, multi-axis or WS2812 block on that pad. A second block of the reader's own module pointing at a different data pin is foreign. With no matching block in the design a foreign block is a warning instead (it may be a hand-built generator). BiSS Line has no block in this tool, so it only warns when two or more blocks drive its MASTER pad. Two blocks reading one SSI, BiSS-C or EnDat encoder is also a warning: the second frame can start inside the encoder's monoflop time and is read as extra clocks.

**Parameters.** Every model parameter is a typed field and is range-checked here, not discovered at run time. Parameters this block does not expose keep the model's own default (BiSS-C encoder keywords, SSI/EnDat initial clock level, MDIO register map, BiSS Line sensor data).

**Simulation scope.** The in-tool JavaScript waveform preview does not attach Device Model blocks; TI pru-simulator does.
`;
}

function getAIContext() {
    return getLongDescription() + `
## How to Configure (For AI/Scripting)

\`\`\`javascript
const deviceModel = scripting.addModule("/pru_blocks/utils/device_model_block", {}, false);
const enc = deviceModel.addInstance();
enc.$name = "Encoder_Model";
enc.deviceKind = "ssi";
enc.ssi_dataPin = 1;     // device drives, the PRU reads
enc.ssi_clkPin = 0;      // PRU drives
enc.ssi_bits = 25;
enc.ssi_position = 4321;
\`\`\`

Field names are \`<kind>_<pin or parameter>\`; only the selected kind's fields apply. There is no connection to make: the block has no ports.
`;
}

exports = {
    displayName: "Device Model",
    defaultInstanceName: "Device_Model_",
    description: "A simulated device attached to the design (encoder, UART, SPI ADC, ...).",
    longDescription: getAIContext(),
    getAIContext: getAIContext,
    uiView: "graph",
    config: [
        { name: "$shape", hidden: true, default: "square" },
        { name: "$topLabel", hidden: true, default: "" },
        { name: "numOfInputPorts", default: 0, hidden: true },
        { name: "numOfOutputPorts", default: 0, hidden: true },
        { name: "numOfConstants", default: 0, hidden: true },
        { name: "opCode", default: "", hidden: true },
        { name: "output1Size", default: "0", hidden: true, getValue: function (inst) { return "0"; } },
        { name: "noOfCycles", displayName: "Number Of Cycles", default: 0, getValue: function (inst) { return 0; } },
        {
            name: "deviceKind",
            displayName: "Device Kind",
            description: "Which device model TI pru-simulator attaches.",
            default: DEFAULT_KIND,
            options: kindOptions(),
            onChange: function (inst, ui) {
                for (const kind of Object.keys(table.KINDS)) {
                    const shown = kind === inst.deviceKind;
                    for (const pf of table.pinFields(kind).concat(table.paramFields(kind))) {
                        if (ui[pf.field]) ui[pf.field].hidden = !shown;
                    }
                }
            }
        },
        {
            name: "pinSummary",
            displayName: "Pins",
            description: "Which pins the device drives and which it listens on.",
            default: "",
            getValue: pinSummary
        },
        {
            name: "runHint",
            displayName: "Where to Run",
            description: "Where the Run on TI pru-simulator button for this design is.",
            default: "",
            getValue: runHint
        },
        {
            name: "readBy",
            displayName: "Read by",
            description: "The block that decodes this device (what resolveDeviceReaders records in the manifest).",
            default: "",
            getValue: readBySummary
        }
    ].concat(kindConfigs()),
    ports: function (inst) {
        return [];
    },
    moduleStatic: {
        modules: function (inst) {
            return [{
                name: "pru_register_allocator_validator",
                moduleName: STATIC_MODULE
            }];
        }
    },
    validate
};
