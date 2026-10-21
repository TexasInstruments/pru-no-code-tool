#!/usr/bin/env python3
"""Turn the emitted device-binding manifest into attached device models.

    python scripts/sim/device_bindings.py describe build_out/pru_device_bindings.json
    python scripts/sim/device_bindings.py check    build_out/pru_device_bindings.json

WHAT THIS IS
------------, the consumer half. SysConfig embeds the binding record in the
generated `pru_syscfg.asm` (see `buildDeviceBindings` in the static module) and
make extracts it to `pru_device_bindings.json`. This module
reads it and instantiates the real Python device models from TI pru-simulator,
so the build runs the oracle the user selected in the GUI without the user
naming a path or writing Python.

Decision C on the Python models are the authority. The GUI is a
selector, not a simulator.

WHY THE PIN TRANSLATION LIVES HERE AND NOT IN THE GUI
-----------------------------------------------------
The GUI has one generic set of pin fields - primary, clock/B, index/Z - because
a single selector must cover eight devices. Every model names its pins
differently: `a_pin/b_pin/z_pin`, `clk_pin/data_pin`, `ma_pin/slo_pin`,
`master_pin/slave_pin`, `clock_pin/data_pin`, `scl_pin/sda_pin`, `pin`.

The mapping is kept next to the models it must agree with, so renaming a pin in
a model breaks a test HERE rather than silently producing an idle trace in
someone's simulation.

The direction is the part worth getting right, and it is not guessable from the
names. Each model's `nets` dict declares which pins the DEVICE drives; every
other pin it only observes. So for a clocked device the device-driven pin is
the data line and the PRU-driven pin is the clock:

    ssi        nets = {data_pin}      -> primary is data,  clock is clk_pin
    bissc      nets = {slo_pin}       -> primary is SLO,   clock is MA
    bissline   nets = {slave_pin}     -> primary is slave, clock is master
    endat      nets = {data_pin}      -> primary is data,  clock is clock_pin
    tca9538    nets = {scl, sda}      -> primary is SDA,   clock is SCL

Wire BiSS-C the other way round - primary to MA - and the encoder waits forever
on a clock that never comes, producing a clean, silent, entirely wrong PASS.
That is the failure this table exists to prevent, and it is why the table is
derived from `nets` rather than from which name sounds like "the first pin".

TWO MODEL CONTRACTS, ONE INVARIANT
----------------------------------
the models in this repository's `perif/` package subclass
`core.device_model`, not the upstream `pru_io` base. They declare no `nets`;
their `tick(cycle, pins_out)` RETURNS the GPI word the device asserts. That is
the same fact, observed rather than declared, so `driven_pins()` reads whichever
of the two a model offers and the direction invariant above applies to every
kind in the registry. Exempting the models with no `nets` - or checking them by
reading back the keyword the binding just set, which cannot fail - would leave
exactly the silent reversal this module exists to catch.

Two of them drive nothing at all: a STEP/DIR driver and a WS2812 string are
pure PRU outputs. For those the primary slot cannot mean "the pin the device
drives", so they are declared `sink=True` and a separate test proves the claim
by observing that they really do assert nothing.

FAIL CLOSED
-----------
A manifest that cannot be read, a version this code does not understand, an
unknown device kind, or a parameter the model would silently drop are all
refusals. Attaching nothing and reporting success is the outcome the whole
device-in-the-loop effort exists to prevent: it looks green because it never
ran.
"""
from __future__ import annotations

import argparse
import contextlib
import inspect
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import elf_cosim  # noqa: E402


SimulatorNotFound = elf_cosim.SimulatorNotFound


def locate_simulator(explicit=None):
    """Find TI's pru-simulator checkout: an explicit path holding simulator.py, else
    elf_cosim.find_pru_simulator (PRU_SIMULATOR_PATH, then tools/pru-simulator-upstream)."""
    if explicit and os.path.isfile(os.path.join(explicit, "simulator.py")):
        return os.path.abspath(explicit)
    return elf_cosim.find_pru_simulator()

#: Manifest shapes this code understands. Bumped by the emitter when the shape
#: changes, so an old consumer refuses a new manifest instead of half-reading it.
SUPPORTED_VERSIONS = (1,)


class BindingError(Exception):
    """A binding that must not be attached. Carries user-facing text."""


class _Spec:
    """How one GUI device kind maps onto one model class.

    `primary`/`clock`/`index` are the model's own keyword names for the pin the
    GUI calls primary, clock/B and index/Z. `None` means the model has no such
    pin, and supplying one in the GUI is an error rather than something to drop.
    """

    def __init__(self, module, cls, primary, clock=None, index=None,
                 device_drives_second=False, sink=False, extra_pins=()):
        self.module = module
        self.cls = cls
        self.primary = primary
        self.clock = clock
        self.index = index
        # A sink drives NOTHING back at the PRU: every one of its pins is an
        # output of the PRU and an input of the device. The primary slot then
        # cannot mean "the pin the device drives", because there is no such
        # pin. Saying so explicitly is the point - the alternative is a spec
        # that looks identical to a reversed clocked device, which is the one
        # error this module exists to catch. Declared here, proved by
        # `test_a_sink_really_drives_nothing`.
        self.sink = sink
        # Model pin keywords with no GUI slot left to carry them. They arrive
        # through `params`, but they are PINS: they get the same range check,
        # the same reuse check and the same cross-device short check as the
        # pin fields, and a missing one is a refusal rather than a default.
        self.extra_pins = tuple(extra_pins)
        # Is the second pin a PRU-driven clock, or something the device also
        # drives? Not cosmetic - it is what makes "the device must not drive
        # its clock" a checkable invariant for the devices where it holds, and
        # an explicit, justified exception for the two where it does not.
        self.device_drives_second = device_drives_second

    @property
    def needs_clock(self):
        return self.clock is not None


# Kind strings are the `name` values of gpi{N}_deviceKind in the static module.
# Keep this table and that option list in step: a kind offered in the GUI with
# no entry here is a dead selector, which the test suite asserts against.
REGISTRY = {
    # B and Z are not a clock: a quadrature encoder DRIVES all three channels,
    # and the PRU only ever reads them. The "clock" slot is the GUI's generic
    # name for the second pin, not a claim about direction.
    "quadrature":  _Spec("pru_io.quadrature_encoder",   "QuadratureEncoder",
                         primary="a_pin", clock="b_pin", index="z_pin",
                         device_drives_second=True),
    "ssi":         _Spec("pru_io.ssi_encoder",          "SsiEncoder",
                         primary="data_pin", clock="clk_pin"),
    "bissc":       _Spec("pru_io.bissc_device_model",   "BissCModel",
                         primary="slo_pin", clock="ma_pin"),
    "bissline":    _Spec("pru_io.bissline_device_model", "BissLineModel",
                         primary="slave_pin", clock="master_pin"),
    "endat":       _Spec("pru_io.endat_encoder",        "EndatEncoder",
                         primary="data_pin", clock="clock_pin"),
    # I2C SCL is open-drain and a slave may stretch the clock, so the device
    # legitimately drives SCL low as well. This is the one clocked device where
    # both pins appear in nets, and it is correct.
    "tca9538":     _Spec("pru_io.tca9538_device_model", "TCA9538Model",
                         primary="sda_pin", clock="scl_pin",
                         device_drives_second=True),
    "uart":        _Spec("pru_io.uart_device",          "UartTransmitter",
                         primary="pin"),
    "sigma_delta": _Spec("pru_io.sd_modulator_device",  "SigmaDeltaModulator",
                         primary="data_pin", clock="clk_pin"),
    # ----------------------------------------------------------------
    # The four models below live in this repository's perif/ package and
    # subclass `core.device_model`, NOT the upstream `pru_io` base. They
    # declare no `nets`; instead `tick(cycle, pins_out)` RETURNS the GPI word
    # the device asserts, so the set bits of that return are the same fact
    # `nets` states declaratively. `driven_pins()` reads whichever of the two
    # a model offers, which is what keeps the direction invariant checkable
    # across both contracts instead of exempting half the registry from it.
    "spi_adc":    _Spec("perif.spi_adc",          "SpiAdc",
                        # The ADC drives MISO, which this model calls sdi_pin
                        # ("the pin the PRU reads"). SCLK and MOSI are the
                        # controller's. CS is a fourth pin and the manifest has
                        # only three slots, so it comes through params under
                        # full pin validation - see extra_pins.
                        primary="sdi_pin", clock="sclk_pin", index="sdo_pin",
                        extra_pins=("cs_pin",)),
    "step_dir":   _Spec("perif.step_dir_driver",  "StepDirDriver",
                        # "open-loop driver: nothing to feed back" - the model
                        # returns 0 forever. STEP/DIR/EN are all PRU outputs,
                        # and DIR occupies the clock slot because it is the
                        # second pin, not because anything clocks it.
                        primary="step_pin", clock="dir_pin", index="en_pin",
                        sink=True),
    "ws2812":     _Spec("perif.ws2812_string",    "Ws2812String",
                        # Single-wire NRZ input. "WS2812 drives nothing back".
                        primary="data_pin", sink=True),
    "mdio_phy":   _Spec("perif.mdio_phy_model",   "MdioPhyModel",
                        # MDIO is shared: the PHY drives it during read
                        # turn-around and read data, so it is genuinely the
                        # device-driven pin. MDC is the STA's.
                        primary="mdio_bit", clock="mdc_bit"),
}

#: Pin assignments come from the manifest's pin fields. A model keyword that is
#: also a pin name must never be settable through the params blob, or there are
#: two sources of truth for one fact and they drift. The GUI validator refuses
#: these too; duplicated deliberately, because this module is also reachable
#: from a hand-written manifest that never passed through the GUI.
_PIN_KEYWORDS = frozenset(
    {s.primary for s in REGISTRY.values()}
    | {s.clock for s in REGISTRY.values() if s.clock}
    | {s.index for s in REGISTRY.values() if s.index}
)


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------
def load_manifest(path):
    """Read and structurally validate a manifest. Raises BindingError."""
    if not os.path.isfile(path):
        raise BindingError(
            "no device-binding manifest at %s. make extracts it from the "
            "generated syscfg/pru_syscfg.asm (the core makefile's syscfg rule "
            "runs scripts/sim/extract_device_bindings.py); an absent file means "
            "generation or extraction did not run, which is not the same as "
            "'no devices attached'." % path)
    try:
        with open(path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as exc:
        raise BindingError("could not read manifest %s: %s" % (path, exc))

    if not isinstance(manifest, dict):
        raise BindingError("manifest must be a JSON object, got %s"
                           % type(manifest).__name__)

    version = manifest.get("version")
    if version not in SUPPORTED_VERSIONS:
        raise BindingError(
            "manifest version %r is not supported (this consumer understands "
            "%s). Refusing rather than reading a shape it may misinterpret."
            % (version, ", ".join(map(str, SUPPORTED_VERSIONS))))

    bindings = manifest.get("bindings")
    if not isinstance(bindings, list):
        raise BindingError("manifest 'bindings' must be a list, got %s"
                           % type(bindings).__name__)

    seen = {}
    for entry in bindings:
        if not isinstance(entry, dict):
            raise BindingError("each binding must be an object, got %s"
                               % type(entry).__name__)
        _validate_entry(entry, seen)
    return manifest


def _pin(entry, key, required):
    value = entry.get(key)
    if value is None:
        if required:
            raise BindingError("binding is missing required pin %r" % key)
        return None
    # bool is an int subclass; True would otherwise pass as pin 1.
    if isinstance(value, bool) or not isinstance(value, int):
        raise BindingError("%s must be an integer pin number, got %r"
                           % (key, value))
    if not 0 <= value <= 19:
        raise BindingError("%s must be 0-19, got %d" % (key, value))
    return value


def _validate_entry(entry, seen):
    kind = entry.get("kind")
    if kind not in REGISTRY:
        raise BindingError(
            "unknown device kind %r (known: %s). A kind offered by the GUI "
            "with no model behind it would attach nothing and pass."
            % (kind, ", ".join(sorted(REGISTRY))))
    spec = REGISTRY[kind]

    primary = _pin(entry, "primaryPin", required=True)
    clock = _pin(entry, "clockPin", required=False)
    index = _pin(entry, "indexPin", required=False)

    if spec.needs_clock and clock is None:
        raise BindingError(
            "device %r on pin %d is clocked and needs a clock pin. Without one "
            "it waits forever and produces an idle trace that looks exactly "
            "like a firmware that never ran." % (kind, primary))
    if not spec.needs_clock and clock is not None:
        raise BindingError("device %r has no clock pin, but clockPin=%d was set"
                           % (kind, clock))
    if spec.index is None and index is not None:
        raise BindingError("device %r has no index pin, but indexPin=%d was set"
                           % (kind, index))

    params = entry.get("params", {})
    if not isinstance(params, dict):
        raise BindingError("params for %r must be an object, got %s"
                           % (kind, type(params).__name__))

    # Pins with no GUI slot. They travel in params because there is nowhere
    # else, but they are validated as pins - a cs_pin that skipped the range,
    # reuse and short checks is the two-sources-of-truth drift this module
    # refuses everywhere else, and an absent one would silently take the
    # model's own default and put CS on a pin nobody selected.
    extra = []
    for key in spec.extra_pins:
        if key not in params:
            raise BindingError(
                "device %r needs %r, which has no GUI pin field and must be "
                "given in params. Without it the model takes its own default "
                "pin, and a device wired to a pin nobody chose produces an "
                "idle trace that looks exactly like a firmware that never ran."
                % (kind, key))
        extra.append(_pin(params, key, required=True))

    pins = [p for p in (primary, clock, index) if p is not None] + extra
    if len(set(pins)) != len(pins):
        raise BindingError("device %r on pin %d reuses a pin: %s"
                           % (kind, primary, pins))

    for pin in pins:
        if pin in seen and seen[pin] != primary:
            raise BindingError(
                "pin %d is claimed by two devices (%r and this one on pin %d). "
                "Two models driving one net is a short, not a configuration."
                % (pin, seen[pin], primary))
        seen[pin] = primary

    for reserved in sorted(_PIN_KEYWORDS & set(params)):
        raise BindingError(
            "params for %r must not set %r - pins come from the pin fields, "
            "and two sources of truth for one pin will drift."
            % (kind, reserved))
    return entry


# --------------------------------------------------------------------------
# instantiation
# --------------------------------------------------------------------------
#: Top-level package names this repository and the pru-simulator checkout both
#: define. Whichever root is first on sys.path wins for ALL of them, so an
#: import has to be scoped to one root rather than leaving both in place.
_COLLIDING_TOPS = frozenset({"core", "perif", "pru_io", "simulator", "tools"})


@contextlib.contextmanager
def _import_from(root):
    """Import with `root` winning, then put sys.path and sys.modules back.

    The two checkouts both define `core` and `perif`. Mutating sys.path in
    place and leaving it mutated makes the result depend on which device was
    bound FIRST: bind a perif model before an upstream one in the same process
    and the upstream import fails, because this repo's `pru_io` now shadows the
    simulator's. That is order-dependent and a test suite can be green on it by
    luck of alphabetical ordering, so the scope is restored rather than trusted.
    """
    saved_modules = {k: sys.modules.pop(k) for k in list(sys.modules)
                     if k.split(".")[0] in _COLLIDING_TOPS}
    saved_path = list(sys.path)
    sys.path.insert(0, root)
    try:
        yield
    finally:
        for k in [k for k in list(sys.modules)
                  if k.split(".")[0] in _COLLIDING_TOPS]:
            del sys.modules[k]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path


def resolve_class(spec, simulator_path=None):
    """Import a model class from the checkout that owns it."""
    path = locate_simulator(simulator_path)
    # models live in this repository's perif/ package and import this
    # repository's core/; every other binding resolves from the upstream
    # pru-simulator checkout, which has its own core/ and perif/.
    root = ROOT if spec.module.split(".")[0] == "perif" else path
    with _import_from(root):
        try:
            module = __import__(spec.module, fromlist=[spec.cls])
        except ImportError as exc:
            raise BindingError("could not import %s from %s: %s"
                               % (spec.module, root, exc))
        try:
            return getattr(module, spec.cls)
        except AttributeError:
            raise BindingError(
                "%s has no class %s - the model was renamed and this "
                "registry was not updated" % (spec.module, spec.cls))


def build_device(entry, simulator_path=None):
    """Instantiate one model from one validated binding entry."""
    spec = REGISTRY[entry["kind"]]
    cls = resolve_class(spec, simulator_path)

    kwargs = dict(entry.get("params") or {})
    kwargs[spec.primary] = entry["primaryPin"]
    if spec.clock and entry.get("clockPin") is not None:
        kwargs[spec.clock] = entry["clockPin"]
    if spec.index and entry.get("indexPin") is not None:
        kwargs[spec.index] = entry["indexPin"]

    # Reject a parameter the model would drop. The GUI promises "unknown keys
    # are reported rather than ignored"; this is where that promise is kept.
    # Models taking **kwargs forward to an inner encoder, so their unknown keys
    # surface as the TypeError caught below instead.
    sig = inspect.signature(cls.__init__)
    takes_var_kw = any(p.kind is inspect.Parameter.VAR_KEYWORD
                       for p in sig.parameters.values())
    if not takes_var_kw:
        unknown = sorted(set(kwargs) - set(sig.parameters))
        if unknown:
            raise BindingError(
                "device %r does not accept %s. A parameter the model drops "
                "silently gives you a model that is not the one you asked for. "
                "Accepted: %s"
                % (entry["kind"], ", ".join(map(repr, unknown)),
                   ", ".join(p for p in sig.parameters if p != "self")))

    try:
        return cls(**kwargs)
    except TypeError as exc:
        raise BindingError("could not construct %r with %s: %s"
                           % (entry["kind"], kwargs, exc))


def driven_pins(model, stimulus=None):
    """Which pin numbers does this DEVICE drive? Works for both contracts.

    Upstream `pru_io` models state it declaratively in `nets`. the `core.device_model` models state it by behaviour: `tick()` returns the GPI
    word the device asserts, so the union of set bits over a few cycles is the
    same fact, observed instead of asserted.

    `stimulus`, when supplied, is an iterable of ``(cycle, pins_out)`` samples.
    It lets callers prove a sink remains quiet while it processes a real input
    edge, rather than mistaking an unexercised early-return path for behaviour.
    The default is the all-pins-low quiet case, then all-pins-high, then low
    again: the high-to-low step is a genuine active-low chip-select assertion
    EDGE, so a device that only drives inside a frame is observed driving. (The
    all-low level alone no longer suffices: a first-tick level is the reset
    state, not an edge - r3.) A model that returns a tuple is an upstream model that should have
    had `nets`; that is a registry error, not something to guess around, so it
    raises.
    """
    nets = getattr(model, "nets", None)
    if nets is not None:
        return set(nets)
    if stimulus is None:
        stimulus = ((cycle, 0 if cycle < 4 or cycle >= 6 else 0xFFFFFFFF)
                    for cycle in range(10))
    driven = 0
    for cycle, pins_out in stimulus:
        word = model.tick(cycle, pins_out)
        if not isinstance(word, int) or isinstance(word, bool):
            raise BindingError(
                "%s.tick returned %r; a model with no `nets` must return the "
                "GPI word it drives, or this module cannot tell which pin it "
                "drives and the direction check is unenforceable"
                % (type(model).__name__, word))
        driven |= word
    return {b for b in range(20) if driven >> b & 1}


def build_all(manifest, simulator_path=None):
    """Instantiate every binding. Returns [(entry, model), ...]."""
    return [(e, build_device(e, simulator_path))
            for e in manifest.get("bindings", [])]


def attach_all(io_port, manifest, simulator_path=None):
    """Instantiate and attach every binding to a simulator IOPort."""
    attached = []
    for entry, model in build_all(manifest, simulator_path):
        io_port.attach_device(model)
        attached.append((entry, model))
    return attached


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _describe(manifest):
    out = []
    for e in manifest.get("bindings", []):
        spec = REGISTRY[e["kind"]]
        pins = ["%s=%d" % (spec.primary, e["primaryPin"])]
        if spec.clock and e.get("clockPin") is not None:
            pins.append("%s=%d" % (spec.clock, e["clockPin"]))
        if spec.index and e.get("indexPin") is not None:
            pins.append("%s=%d" % (spec.index, e["indexPin"]))
        out.append({"kind": e["kind"], "class": spec.cls,
                    "pins": pins, "params": e.get("params", {})})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("describe", "check"))
    ap.add_argument("manifest")
    ap.add_argument("--simulator", help="path to a pru-simulator checkout")
    ap.add_argument("--allow-empty", action="store_true",
                    help="treat a manifest with no devices as success")
    args = ap.parse_args(argv)

    try:
        manifest = load_manifest(args.manifest)
    except BindingError as exc:
        print("REFUSED: %s" % exc)
        return 2

    bindings = manifest.get("bindings", [])
    if not bindings and not args.allow_empty:
        # Comparing zero cases is a failure, not a pass - the same rule as
        # second_oracle.py. Pass --allow-empty when a project genuinely has no
        # attached devices and you want the step to be a no-op.
        print("REFUSED: manifest has no device bindings. A run that attaches "
              "nothing proves nothing; pass --allow-empty if that is intended.")
        return 2

    if args.command == "describe":
        print(json.dumps({"version": manifest["version"],
                          "devices": _describe(manifest)}, indent=1))
        return 0

    try:
        built = build_all(manifest, args.simulator)
    except SimulatorNotFound as exc:
        print("REFUSED: %s" % exc)
        return 2
    except BindingError as exc:
        print("REFUSED: %s" % exc)
        return 2

    for entry, model in built:
        print("  ok   %-12s -> %s(%s)  drives=%s"
              % (entry["kind"], type(model).__name__,
                 getattr(model, "name", entry["primaryPin"]),
                 sorted(driven_pins(model))))
    print("\n%d device(s) constructed and pin-mapped." % len(built))
    return 0


if __name__ == "__main__":
    sys.exit(main())
