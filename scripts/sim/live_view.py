"""Watch a bound-device design run live in TI pru-simulator's browser dashboard.

    python scripts/sim/live_view.py <elf> <pru_device_bindings.json>
           [--port N] [--host H] [--core pruN] [--cycles N] [--no-browser]

`gmake live` is `gmake sim` with a window on it. It imports the
dashboard TI ships (ui/server.py from PRU_SIMULATOR_PATH - not forked, not
copied), loads the ELF, and attaches every binding in the manifest through
run_bound_devices.attach_bound_devices, the SAME function `gmake sim` uses.
Press Run or Step in the dashboard and the PRU is driving the real device
models; the pin grid and Signal Graph show the real exchange.

On top of the stock dashboard this adds, without editing it:
    GET /live/verdict   run_bound_devices.report_run on the current state -
                        PASS / FAIL / NOT CHECKED, the very judge `gmake sim`
                        runs, plus its full text. `final` is false until HALT.
    GET /live/vcd       the CLK/DATA waveform (same writer as `gmake sim --vcd`);
                        withheld (404) whenever the verdict is, for the same reason
    GET /live/info      what is attached and on which pins
    GET /               the stock page plus a verdict banner

Facts settled by reading and probing TI pru-simulator (see tests/test_live_view.py):
  * ui.server builds its Simulator at import, as a module global. Everything it
    does reaches that object through the module, so it is attached BEFORE
    uvicorn starts; nothing needs a running server.
  * hard_reset()/reset() keep attached devices but clear the bus, the devices'
    history and the PC (back to 0, not the ELF entry). Both are wrapped here to
    restore the entry PC and re-prime the bus, so a Reset button press gives a
    run identical to the first.
  * Run's graph capture is decimated 1 sample in 100 (ui.server._capture_due)
    unless the peripheral interface is on - a CLK with a period of 8 cycles
    vanishes at that stride. It is replaced here to sample every instruction.
  * Bindings and the grid share numbering: clockPin n is R30 bit n = GPO n,
    primaryPin n is R31 bit n = GPI n, 0..19. The graph records gpi[20], so
    the pins the device drives are visible.

Exit codes follow run_bound_devices: 2 = REFUSED (loudly, before any server
starts). The server itself exits 0 on Ctrl+C.
"""
import argparse
import contextlib
import io
import json
import os
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from scripts.sim import device_bindings, run_bound_devices as rbd
from scripts.sim.elf_cosim import find_pru_simulator, _sim_namespace

DEFAULT_PORT = 8765
LOOPBACK = ("127.0.0.1", "localhost", "::1")
#: Per-cycle (gpo, gpi) samples kept for the VCD. A runaway firmware must not
#: eat the machine; past this the VCD is withheld rather than silently clipped.
MAX_SAMPLES = 2_000_000


FOREIGN = ("the loaded program is not this design's ELF - the bound devices "
           "belong to the design, so nothing is judged. Reload the design's ELF, "
           "reset and run to get a verdict")
HAND_EDIT = "state edited by hand ({}) - reset and run to get a verdict"
STEP_BACK = HAND_EDIT.format("step back; the device models cannot be rewound")
REPLACED = ("the simulator was replaced (PUT /config or /config/clock_speed) - "
            "the bound devices are on the old one, so nothing is judged. Only "
            "restarting the live view recovers (press Run on TI pru-simulator "
            "again, or start live_view.py again); reloading the design does not")
#: Edits a Reset does NOT undo: upstream reset() clears registers, counters, PC
#: and the IO port, but keeps data memory and the peripheral/loopback/SD/XFR
#: configuration. Clearing "everything" on prime would mean enumerating all of
#: that upstream state, and a miss would read PASS; so these stay withheld until
#: the live view is restarted.
PERSISTENT_EDIT = ("state edited by hand ({}) and a Reset does not undo it - "
                   "memory and peripheral configuration survive a reset. Restart "
                   "the live view to get a verdict")
#: The only hand edits a Reset really undoes (registers, IO port pins, step back). Anything
#: else outside SAFE_ACTIONS - known or not - is treated as persistent.
RESET_UNDOES = ("set_register", "set_input", "step_back")
#: ALLOWLIST of dashboard actions that leave the run intact: the wrappers below
#: own step/run/reset/load handling (step_back is caught in restore), the rest
#: only read or set breakpoints. EVERY other action - known or not, whatever its
#: `core` field says (write_memory/fill_memory ignore it, run_multicore steps a
#: partner) - marks the run edited and withholds the verdict.
SAFE_ACTIONS = ("step", "run", "reset", "hard_reset", "load", "load_elf",
                "get_state", "read_memory", "toggle_breakpoint", "clear_breakpoints")


class LiveViewRefused(Exception):
    """The inputs cannot be shown live. Carries the user-facing reason."""


class LiveState:
    """Everything the live view tracks about the one loaded run."""

    def __init__(self, sim, core, entry_pc, attached, budget, budget_source,
                 decoded_register, elf_bytes=b"", max_samples=MAX_SAMPLES):
        self.sim, self.core, self.entry_pc = sim, core, entry_pc
        self.elf_bytes, self.max_samples = elf_bytes, max_samples
        #: Why no PASS/FAIL may be shown. `foreign`: the loaded program is not the
        #: design's ELF. `edited`: state was changed by hand (step back, register
        #: or memory write, pin toggle) and the device models cannot follow it.
        self.foreign = None
        self.edited = None
        #: Like `edited`, but prime() does not clear it: see PERSISTENT_EDIT.
        self.persistent = None
        #: ui.server module; set by _wrap_sim. PUT /config swaps its global `sim`.
        self.server = None
        self.attached = attached
        self.budget, self.budget_source = budget, budget_source
        self.decoded_register = decoded_register
        self.samples = []
        self.truncated = False
        self.resets = 0

    @property
    def pru(self):
        return self.sim.cores[self.core]

    def prime(self):
        """Put the core and the bus back at the state `gmake sim` starts from."""
        pru = self.pru
        pru.pc = self.entry_pc
        # Upstream reset leaves GPI alone ("external stimulus", io_port.reset), so
        # a pin set by hand (set_input, set_register 31) would survive a Reset and
        # `gmake sim` never has it. Clear it on EVERY prime (reset, hard_reset,
        # load, load_elf), whatever reset path got here; the devices re-drive theirs.
        pru.io_port.gpi = 0
        rbd.prime_device_bus(pru, self.attached)
        self.samples = [(pru.io_port.gpo, pru.io_port.gpi)]
        self.truncated = False
        self.edited = None

    def withheld(self):
        """The reason no verdict may be given, or None."""
        if self.server is not None and self.server.sim is not self.sim:
            return REPLACED
        return self.foreign or self.persistent or self.edited

    def record(self):
        if len(self.samples) >= self.max_samples:
            self.truncated = True
            return
        pru = self.pru
        self.samples.append((pru.io_port.gpo, pru.io_port.gpi))

    def verdict(self):
        """Judge the current state with run_bound_devices.report_run."""
        why = self.withheld()
        if why:
            return {"verdict": "NOT CHECKED", "exit_code": rbd.EXIT_NOT_CHECKED,
                    "final": bool(self.pru.halted), "halted": bool(self.pru.halted),
                    "cycles": self.pru.counters.cycles, "resets": self.resets,
                    "reason": why, "report": f"NOT CHECKED: {why}\n"}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = rbd.report_run(self.sim, self.core, self.attached, self.budget,
                                  self.budget_source, self.decoded_register)
        names = {rbd.EXIT_PASS: "PASS", rbd.EXIT_FAIL: "FAIL",
                 rbd.EXIT_NOT_CHECKED: "NOT CHECKED"}
        return {"verdict": names[code], "exit_code": code,
                "final": bool(self.pru.halted), "halted": bool(self.pru.halted),
                "cycles": self.pru.counters.cycles, "resets": self.resets,
                "reason": None, "report": out.getvalue()}

    def vcd_text(self):
        first = next((e for e, _ in self.attached if e["kind"] == "ssi"), None)
        if first is None:
            raise LookupError("no ssi binding attached: the VCD writer draws an "
                              "SSI CLK/DATA pair")
        if self.truncated:
            raise LookupError(f"more than {self.max_samples} cycles recorded; "
                              f"VCD withheld rather than clipped")
        import tempfile
        fd, path = tempfile.mkstemp(suffix=".vcd")
        os.close(fd)
        try:
            rbd.write_pin_vcd(path, self.samples, first["clockPin"], first["primaryPin"])
            with open(path, encoding="ascii") as f:
                return f.read()
        finally:
            os.unlink(path)

    def info(self):
        return {"core": self.core, "entry_pc": self.entry_pc,
                "budget": self.budget, "budget_source": self.budget_source,
                "attached": [{"kind": e["kind"], "model": type(m).__name__,
                              "gpi_pin": e["primaryPin"], "clk_r30_pin": e.get("clockPin"),
                              "driven_gpi_pins": sorted(device_bindings.driven_pins(m))}
                             for e, m in self.attached]}


BANNER = """
<div id="nc-live" style="position:fixed;right:12px;bottom:12px;z-index:99999;
 font:13px/1.35 Consolas,monospace;background:#1c1f26;color:#e6e6e6;
 border:2px solid #666;border-radius:6px;padding:8px 12px;max-width:34em">
 <b>NoCode live view</b> - bound devices attached<br>
 <span id="nc-live-v">verdict: (run to HALT)</span><br>
 <a id="nc-live-vcd" href="/live/vcd" download="live_view.vcd" style="color:#8ab4f8">download VCD</a>
 &nbsp;<a href="/live/verdict" target="_blank" style="color:#8ab4f8">full verdict</a>
</div>
<script>
(async function poll(){
  try {
    const r = await (await fetch("/live/verdict")).json();
    const el = document.getElementById("nc-live-v"), box = document.getElementById("nc-live");
    const colour = {PASS:"#2e9d4f", FAIL:"#d33", "NOT CHECKED":"#d9a300"}[r.verdict] || "#666";
    el.textContent = r.final ? "verdict: " + r.verdict + " (halted, " + r.cycles + " cycles)"
                             : "running - not halted yet (provisional: " + r.verdict + ")";
    box.style.borderColor = r.final ? colour : "#666";
  } catch (e) {}
  setTimeout(poll, 1000);
})();
</script>
"""


def _wrap_sim(state, server):
    """Hook the module-global Simulator and dashboard without editing either."""
    sim = state.sim
    pru = state.pru
    state.server = server
    original_step = pru.step

    def step():
        original_step()
        state.record()
    pru.step = step

    original_reset, original_hard = sim.reset, sim.hard_reset
    original_load_elf, original_load = sim.load_elf, sim.load

    def reset(core):
        original_reset(core)
        if core == state.core:
            state.resets += 1
            state.prime()

    def hard_reset():
        original_hard()
        state.resets += 1
        state.prime()

    def load_elf(core, elf_data):
        errors = original_load_elf(core, elf_data)
        if core == state.core and not errors:
            from tools.headless_runner import _validate_linked_elf
            try:
                state.entry_pc = _validate_linked_elf(elf_data)
            except ValueError as exc:
                return [f"invalid linked ELF: {exc}"]
            # Upstream load leaves halted and the counters as they were; a
            # loaded program starts from a fresh core, like Reset.
            original_reset(core)
            state.prime()
            state.foreign = None if bytes(elf_data) == state.elf_bytes else FOREIGN
        return errors

    def load(core, source, *args, **kwargs):
        errors = original_load(core, source, *args, **kwargs)
        if core == state.core:
            original_reset(core)
            state.prime()
            state.foreign = FOREIGN
        return errors

    original_restore = server._restore

    def restore(core, snap):
        original_restore(core, snap)
        if core == state.core:
            state.edited = STEP_BACK
            state.samples = []

    sim.reset, sim.hard_reset, sim.load_elf, sim.load = reset, hard_reset, load_elf, load
    server._restore = restore
    # Dashboard Run captures 1 sample in 100 by default; the SSI clock would
    # alias away. Sample every instruction while a device is attached.
    server._capture_due = lambda c, steps: True


def make_app(elf_path, manifest_path, core=None, cycles=None, decoded_register=None,
             max_samples=MAX_SAMPLES):
    """Build the live app. Call inside run_bound_devices' `_sim_namespace`.

    Raises LiveViewRefused for any input `gmake sim` would REFUSE, or fail to
    load, with the same reasons.
    """
    try:
        manifest = device_bindings.load_manifest(manifest_path)
        ns = argparse.Namespace(cycles=cycles)
        budget, budget_source = rbd.cycle_budget(ns, manifest)
    except device_bindings.BindingError as exc:
        raise LiveViewRefused(str(exc)) from exc
    if not manifest.get("bindings"):
        raise LiveViewRefused("manifest has no device bindings. An empty manifest "
                              "is REFUSED.")
    sim_dir = find_pru_simulator()
    from tools.headless_runner import _validate_linked_elf
    from ui import server

    sim = server.sim
    core = rbd.normalize_core(core or manifest.get("core"))
    if not core or core not in sim.cores:
        raise LiveViewRefused(f"unknown or absent PRU core {core!r}")
    with open(elf_path, "rb") as f:
        elf_data = f.read()
    try:
        entry_pc = _validate_linked_elf(elf_data)
    except ValueError as exc:
        raise LiveViewRefused(f"invalid linked ELF: {exc}") from exc
    errors = sim.load_elf(core, elf_data)
    if errors:
        raise LiveViewRefused(f"ELF load errors: {errors}")
    try:
        attached = rbd.attach_bound_devices(sim.cores[core], manifest, sim_dir)
    except rbd.DeviceRefused as exc:
        raise LiveViewRefused(str(exc)) from exc

    state = LiveState(sim, core, entry_pc, attached, budget, budget_source,
                      decoded_register, elf_bytes=bytes(elf_data),
                      max_samples=max_samples)
    state.prime()
    _wrap_sim(state, server)

    from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
    app = server.app
    app.router.routes[:] = [r for r in app.router.routes
                            if getattr(r, "path", None) != "/"]

    @app.get("/")
    async def index():
        page = open(os.path.join(server.STATIC_DIR, "index.html"),
                    encoding="utf-8").read()
        return HTMLResponse(page.replace("</body>", BANNER + "</body>", 1)
                            if "</body>" in page else page + BANNER)

    @app.get("/live/verdict")
    async def live_verdict():
        return JSONResponse(state.verdict())

    @app.get("/live/info")
    async def live_info():
        return JSONResponse(state.info())

    @app.get("/live/vcd")
    async def live_vcd():
        why = state.withheld()
        if why:
            return PlainTextResponse(f"VCD withheld: {why}", status_code=404)
        try:
            return PlainTextResponse(state.vcd_text(), media_type="text/plain")
        except LookupError as exc:
            return PlainTextResponse(str(exc), status_code=404)

    app.add_middleware(_HandEditWatch, state=state)
    app.state.live = state
    return app


class _HandEditWatch:
    """ASGI middleware: note dashboard actions that edit state behind the devices.

    Anything outside SAFE_ACTIONS may change the core, memory or pins directly;
    the device models never see it, so a verdict afterwards would judge a run
    that did not happen. Flagged until the next reset/load. Malformed frames are
    not actions (upstream drops them) and are left alone.
    """

    def __init__(self, app, state):
        self.app, self.state = app, state

    async def __call__(self, scope, receive, send):
        if scope["type"] != "websocket":
            return await self.app(scope, receive, send)

        async def watched():
            event = await receive()
            if event.get("type") == "websocket.receive" and event.get("text"):
                try:
                    msg = json.loads(event["text"])
                except ValueError:
                    msg = None
                action = msg.get("action") if isinstance(msg, dict) else None
                if action not in SAFE_ACTIONS:
                    if action in RESET_UNDOES:
                        self.state.edited = HAND_EDIT.format(action)
                    else:
                        self.state.persistent = PERSISTENT_EDIT.format(action)
            return event
        return await self.app(scope, watched, send)


@contextlib.contextmanager
def live_session(elf_path, manifest_path, **kwargs):
    """Yield the live FastAPI app with TI pru-simulator's namespace swapped in.

    The dashboard imports simulator packages lazily, per request, so the swap
    must last as long as the app is used. Leaving the block restores this
    repo's own `core`/`perif` modules.
    """
    with _sim_namespace(find_pru_simulator()):
        yield make_app(elf_path, manifest_path, **kwargs)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Live browser view of a bound-device run")
    ap.add_argument("elf", help="Path to compiled ELF (.out)")
    ap.add_argument("manifest", help="Path to pru_device_bindings.json")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1",
                    help="Bind address (default loopback). The dashboard can load "
                         "ELFs and write config with no authentication; anything "
                         "but loopback needs --allow-remote")
    ap.add_argument("--allow-remote", action="store_true",
                    help="Allow a non-loopback --host (exposes the dashboard to "
                         "the network, unauthenticated)")
    ap.add_argument("--max-samples", type=int, default=MAX_SAMPLES,
                    help="Per-instruction pin samples kept for /live/vcd and the "
                         "graph (default %(default)s, about 120 bytes each, so ~240 MB "
                         "at the default). Past it recording stops and the VCD is "
                         "withheld; Run in the dashboard samples EVERY instruction "
                         "(stock samples 1 in 100, which aliases the SSI clock)")
    ap.add_argument("--cycles", type=int, default=None,
                    help="Cycle budget the verdict is judged against (as gmake sim)")
    ap.add_argument("--core", help="Override the SysConfig core in the manifest")
    ap.add_argument("--decoded-register", type=int,
                    help="Explicit decoded-value register, hand-built ELFs only")
    ap.add_argument("--no-browser", action="store_true", help="Do not open a browser (also PRU_SIM_LIVE_NO_BROWSER=1)")
    args = ap.parse_args(argv)

    if args.host not in LOOPBACK and not args.allow_remote:
        print(f"REFUSED: --host {args.host} is not loopback. The dashboard accepts "
              f"ELF loads and config writes with no authentication; pass "
              f"--allow-remote to expose it anyway", file=sys.stderr)
        return rbd.EXIT_REFUSED
    if args.host not in LOOPBACK:
        print(f"WARNING: serving an unauthenticated dashboard on {args.host}",
              file=sys.stderr)
    try:
        with live_session(args.elf, args.manifest, core=args.core, cycles=args.cycles,
                          decoded_register=args.decoded_register,
                          max_samples=args.max_samples) as app:
            from ui import server
            import uvicorn
            if not server._port_is_free(args.host, args.port):
                print(f"REFUSED: port {args.port} on {args.host} is already in use; "
                      f"pass --port", file=sys.stderr)
                return rbd.EXIT_REFUSED
            url = f"http://{args.host}:{args.port}/"
            state = app.state.live
            print(f"Attached {len(state.attached)} devices: "
                  + ", ".join(f"{e['kind']} (GPI{e['primaryPin']})" for e, _ in state.attached))
            print(f"Live view: {url}  (Ctrl+C to stop)")
            if not (args.no_browser or os.environ.get("PRU_SIM_LIVE_NO_BROWSER") == "1"):
                threading.Timer(1.0, webbrowser.open, args=(url,)).start()
            uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    except LiveViewRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return rbd.EXIT_REFUSED
    return 0


if __name__ == "__main__":
    sys.exit(main())
