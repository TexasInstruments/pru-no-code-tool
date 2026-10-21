"use strict";
/*
 * pru_device_caps.js — single-source device capability table for.
 *
 * TRM evidence (authoritative, do not re-derive):
 *   - AM64x/AM243x carry PRU_ICSSG  (SPRUIM2J §6.4.1.1)
 *   - AM261x carries PRU_ICSSM       (SPRUJB6 §7.3.1.1)
 *
 * Widget listing derived from the table in the task:
 *   widget                  ICSSG (AM64x/AM243x)    ICSSM (AM261x/AM263Px)
 *   MAC (multiply/acc)      yes                     yes
 *   CRC16/32                yes                     yes
 *   SPAD banks              8                       3   (widget present on both, bank count differs)
 *   BSWAP (byte swap)       yes                     NO
 *   SUM32                   yes                     NO
 *   Task Manager            yes                     NO
 *   Broadside Stitch FIFO   yes (PRU0/PRU1 only)    NO
 *   Spinlock (XFR2SPIN)     yes (64 flags, all 6)   NO
 *   BS RAM 2KB per core     yes                     NO
 *   RTU_PRU / TX_PRU cores  yes                     NO
 *   IEP instances           2                       1
 *   PWM module    yes (4 sets of 3 pairs) NO   (SPRUIM2J 6.4.10; SPRUJB6 7.3.1.1 lists no PWM)
 *
 * AM263Px is ICSSM-class (-motor-control-sdk docs: SOC_AM263PX || SOC_AM261X -> PRU-ICSSM).
 */

// Canonical widget identifiers — use these in requiresWidget declarations.
const WIDGETS = {
    MAC: "mac",
    CRC_HW: "crc_hw",
    BSWAP: "bswap",
    SUM32: "sum32",
    TASK_MGR: "task_manager",
    STITCH_FIFO: "stitch_fifo",
    BS_RAM: "bs_ram",
    RTU_PRU: "rtu_pru",
    TX_PRU: "tx_pru",
    IEP2: "iep2",       // second IEP instance (IEP0 exists on all; IEP1 only on ICSSG)
    SPAD: "spad",        // scratchpad banks (present on both, but kept for completeness)
    XFR2PSI: "xfr2psi",  // XFRDMA / PSI-L packet streaming (ICSSG only, no PSI-L on ICSSM SPRUJB6 7.3.1.1)
    XFR2TR: "xfr2tr",    // RTU_PRU XFR2TR ring (SPRUIM2J 6.4.6.3.3 / Table 6-112). Attached to the
                         // RTU_PRU cores, which exist on ICSSG only (SPRUIM2J 6.4.1.1); ICSSM has no RTU_PRU.
    FDB_GP: "fdb_gp",    // FDB Generic RAM + compare (SPRUIM2J 6.4.11.2.3.7.4, Tables 6-103/6-105;
                         // broadside IDs 30/31/35). PRU0/PRU1 only, ICSSG only.
    XFR2SPIN: "xfr2spin", // ICSSG hardware spinlock (SPRUIM2J Table 6-60 "XFR2SPIN 0x90 1 copy per
                          // PRU_ICSSG system"; 6.4.6.2.9 / Table 6-98). 64 ownership flags reachable from all
                          // six ICSSG cores. ICSSM (SPRUJB6 7.3.1.1) has no spinlock unit, and there is no
                          // software substitute for a cross-core atomic, so this is ICSSG-only.
    QUEUE_EMPTY: "queue_empty", // ICSSG QUEUE_EMPTY status query (SPRUIM2J Table 6-60 BS ID 0xF0)
    ICSSG_PWM: "icssg_pwm", // PRU_ICSSG PWM module driven by IEP compares (SPRUIM2J 6.4.10). ICSSM
                            // (SPRUJB6 7.3.1.1) has no PWM module; the R30 software PWM blocks are the fallback.
};

// ICSSG: full feature set
const ICSSG_CAPS = new Set([
    WIDGETS.MAC,
    WIDGETS.CRC_HW,
    WIDGETS.SPAD,
    WIDGETS.BSWAP,
    WIDGETS.SUM32,
    WIDGETS.TASK_MGR,
    WIDGETS.STITCH_FIFO,
    WIDGETS.BS_RAM,
    WIDGETS.RTU_PRU,
    WIDGETS.TX_PRU,
    WIDGETS.IEP2,
    WIDGETS.XFR2PSI,
    WIDGETS.XFR2TR,
    WIDGETS.FDB_GP,
    WIDGETS.XFR2SPIN,
    WIDGETS.QUEUE_EMPTY,
    WIDGETS.ICSSG_PWM,
]);

// ICSSM (AM261x, AM263Px): smaller PRU-ICSS
const ICSSM_CAPS = new Set([
    WIDGETS.MAC,
    WIDGETS.CRC_HW,
    WIDGETS.SPAD,
    // BSWAP, SUM32, TASK_MGR, STITCH_FIFO, BS_RAM, RTU_PRU, TX_PRU, IEP2 are absent
]);

const DEVICE_CAPS = {
    am64x: ICSSG_CAPS,
    am243x: ICSSG_CAPS,
    am261x: ICSSM_CAPS,
    am263px: ICSSM_CAPS,
    am263x: ICSSM_CAPS,
};

// fail closed. A missing or unknown SoC must never silently inherit
// a capability set — return an EMPTY set so every requiresWidget check reports
// the widget as missing (visible error) instead of quietly passing.
function isKnownSoc(socName) {
    if (!socName) return false;
    return Object.prototype.hasOwnProperty.call(DEVICE_CAPS, String(socName).toLowerCase());
}

function getCapsForSoc(socName) {
    if (!socName) return new Set();
    const key = String(socName).toLowerCase();
    return DEVICE_CAPS[key] || new Set();
}

function isWidgetAvailable(widget, socName) {
    const caps = getCapsForSoc(socName);
    return caps.has(widget);
}

function getMissingWidgets(requiresWidget, socName) {
    if (!requiresWidget) return [];
    const list = Array.isArray(requiresWidget) ? requiresWidget : [requiresWidget];
    const caps = getCapsForSoc(socName);
    return list.filter(function (w) { return !caps.has(w); });
}

// All known device ids (sorted for docs)
const ALL_DEVICES = Object.keys(DEVICE_CAPS).sort();

// SysConfig export (system.getScript)
if (typeof exports !== "undefined") {
    exports.WIDGETS = WIDGETS;
    exports.ICSSG_CAPS = ICSSG_CAPS;
    exports.ICSSM_CAPS = ICSSM_CAPS;
    exports.DEVICE_CAPS = DEVICE_CAPS;
    exports.getCapsForSoc = getCapsForSoc;
    exports.isKnownSoc = isKnownSoc;
    exports.isWidgetAvailable = isWidgetAvailable;
    exports.getMissingWidgets = getMissingWidgets;
    exports.ALL_DEVICES = ALL_DEVICES;
}

// Node / test harness export
if (typeof module !== "undefined" && module.exports) {
    module.exports.WIDGETS = WIDGETS;
    module.exports.ICSSG_CAPS = ICSSG_CAPS;
    module.exports.ICSSM_CAPS = ICSSM_CAPS;
    module.exports.DEVICE_CAPS = DEVICE_CAPS;
    module.exports.getCapsForSoc = getCapsForSoc;
    module.exports.isKnownSoc = isKnownSoc;
    module.exports.isWidgetAvailable = isWidgetAvailable;
    module.exports.getMissingWidgets = getMissingWidgets;
    module.exports.ALL_DEVICES = ALL_DEVICES;
}
