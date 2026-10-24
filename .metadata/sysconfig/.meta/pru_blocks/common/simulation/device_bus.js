/**
 * device_bus.js - the wire between the simulated PRU and attached device models.
 *
 * This is a JavaScript port of the DeviceBus contract in the TI pru-simulator
 * (pru_io/device_model.py). The semantics are intended to be IDENTICAL: if
 * you change the behaviour here, change it there too, in the same commit
 * series - one bus, two languages.
 *
 * WHY A BUS AT ALL
 * pru_core.js models the PRU core and, until now, took its R31 input from a
 * fixed, pre-authored history. That is open-loop: the "device" on the other
 * end cannot react to what the firmware does, so a wrong firmware is replayed
 * against a recording instead of being answered by the part. A DeviceBus
 * closes the loop: every cycle the PRU's R30 is resolved against whatever the
 * attached devices drive, and the resolved value is what R31 samples.
 *
 * ELECTRICAL MODEL
 * A device's tick() returns what it DRIVES as a (driveMask, driveValues)
 * pair; the bus resolves all drivers per net. Two net types:
 *
 *   OPEN_DRAIN  a device may only pull low; the net is the wired-AND of every
 *               driver, with a pull-up supplying the idle high.
 *   PUSH_PULL   one driver at a time. Two drivers disagreeing is contention,
 *               recorded as a fault rather than silently resolved - that is a
 *               real short on real hardware, and a model that quietly picks a
 *               winner hides a design error.
 *
 * ORDERING (same two-phase settle as the Python original)
 *   1. Resolve the PRU's CURRENT output against every device's PREVIOUS
 *      drive, and show that to the devices - a device must see what the PRU
 *      is doing this cycle, not a cycle late.
 *   2. Re-resolve with the drives the devices just produced; that is what
 *      R31 samples.
 * So a device sees the PRU immediately but never the result of its own drive
 * within the same cycle - which is the part real silicon cannot do either.
 */

const OPEN_DRAIN = "open_drain";
const PUSH_PULL = "push_pull";

const MASK_20 = (1 << 20) - 1;

class DeviceBus {
    constructor() {
        this.devices = [];
        this.contentions = [];
        this._lastDrives = [];      // [{device, mask, values}]
        this._bus = MASK_20;        // idle: pull-ups high
        this._pruDriveMask = MASK_20;
    }

    /**
     * Attach a device. Never enabled by default anywhere else - the caller
     * (Simulation Settings device mode) decides.
     */
    attach(device) {
        this.devices.push(device);
        return device;
    }

    detachAll() {
        this.devices = [];
    }

    /**
     * Which pins the PRU is actually driving (the rest are inputs). Defaults
     * to all 20. A design that configures pins as inputs should narrow this,
     * otherwise the PRU fights every device on those pins.
     */
    setPruDriveMask(mask) {
        this._pruDriveMask = mask & MASK_20;
    }

    _netType(pin) {
        // A pin is open-drain if ANY attached device declares it so - one
        // open-drain device makes the whole net open-drain, which is how a
        // real bus behaves.
        for (const dev of this.devices) {
            if (dev.nets && dev.nets[pin] === OPEN_DRAIN) {
                return OPEN_DRAIN;
            }
        }
        return PUSH_PULL;
    }

    _resolve(cycle, gpo, drives, recordContention) {
        let bus = MASK_20;
        for (let pin = 0; pin < 20; pin++) {
            const bit = 1 << pin;
            const net = this._netType(pin);
            const drivers = [];
            if (this._pruDriveMask & bit) {
                drivers.push({ name: "PRU", value: (gpo >> pin) & 1 });
            }
            for (const d of drives) {
                if (d.mask & bit) {
                    drivers.push({ name: d.device.name, value: (d.values >> pin) & 1 });
                }
            }

            let level;
            if (drivers.length === 0) {
                level = 1;                    // pull-up
            } else if (net === OPEN_DRAIN) {
                level = drivers.some(d => d.value === 0) ? 0 : 1;
            } else {
                level = drivers[0].value;
                const levels = new Set(drivers.map(d => d.value));
                if (recordContention && levels.size > 1) {
                    const who = drivers.map(d => `${d.name}=${d.value}`).join(", ");
                    this.contentions.push(
                        `cycle ${cycle}: push-pull contention on pin ${pin} (${who})`);
                }
            }

            if (level) {
                bus |= bit;
            } else {
                bus &= ~bit;
            }
        }
        return bus;
    }

    /**
     * One cycle of bus resolution. Returns the level every input samples.
     */
    settle(cycle, gpo) {
        const provisional = this._resolve(cycle, gpo, this._lastDrives, false);
        const drives = this.devices.map(d => {
            const [mask, values] = d.tick(cycle, provisional);
            return { device: d, mask, values };
        });
        this._lastDrives = drives;
        this._bus = this._resolve(cycle, gpo, drives, true);
        return this._bus;
    }

    /**
     * The word the PRU's output register must START from when devices are
     * attached. The bus contract is that undriven lines idle high (pull-ups);
     * starting R30 at 0 would instead present every clocked device with a
     * spurious falling edge on cycle 1 - a frame the firmware never sent,
     * which then desynchronises every real frame after it. Only the pins the
     * PRU actually drives are its business; the rest belong to the devices.
     */
    idlePruWord() {
        return this._pruDriveMask;
    }

    // -- aggregate views -------------------------------------------------

    events() {
        const out = [];
        for (const dev of this.devices) {
            for (const ev of (dev.events ? dev.events() : [])) {
                out.push(Object.assign({ device: dev.name }, ev));
            }
        }
        out.sort((a, b) => (a.cycle || 0) - (b.cycle || 0));
        return out;
    }

    faults() {
        const out = this.contentions.slice();
        for (const dev of this.devices) {
            for (const f of (dev.faults ? dev.faults() : [])) {
                out.push(`${dev.name}: ${f}`);
            }
        }
        return out;
    }

    reset() {
        this.contentions = [];
        this._lastDrives = [];
        this._bus = MASK_20;
        for (const dev of this.devices) {
            if (dev.reset) dev.reset();
        }
    }

    getState() {
        return {
            bus: this._bus,
            contentions: this.contentions.length,
            devices: this.devices.map(d => (d.getState ? d.getState() : { name: d.name }))
        };
    }
}

exports = { DeviceBus, OPEN_DRAIN, PUSH_PULL, MASK_20 };
