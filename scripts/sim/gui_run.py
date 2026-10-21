"""The "Run on TI pru-simulator" button's wrapper.

    python scripts/sim/gui_run.py --project <example.syscfg | firmware dir>
           --digest <design digest from the GUI> --com <result.json>

Runs the same chain as `gmake sim`, on the SAVED .syscfg:
  1. generate   SysConfig CLI via the project makefile's `syscfg` target
  2. stale gate the GUI's design digest must equal the one embedded in the
                generated pru_syscfg.asm, else REFUSED (the design on screen is
                not the design that would be run)
  3. build      clpru, via the makefile's `all` target
  4. run        scripts/sim/run_bound_devices.py <elf> <pru_device_bindings.json>

The verdict is ONLY the exit code of run_bound_devices.py (0 PASS, 1 FAIL,
2 REFUSED, 3 NOT CHECKED). This wrapper never judges: it does not read the
decoded value to decide anything, it only carries it to the panel. Anything that
stops the chain before the runner (no tool, stale design, failed build) is
REFUSED with the reason; an unknown exit code is REFUSED, never PASS.

With --live the live web view (scripts/sim/live_view.py) is started on
the ELF just built, detached so it outlives this process, once a PASS/FAIL/NOT
CHECKED verdict exists. It is never started for a REFUSED run, and it can never
change the verdict or the exit code: its outcome is the result's "liveView".

The result JSON is written to --com on every path, including internal errors.
"""
import argparse
import glob
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.sim import extract_device_bindings  # noqa: E402

VERDICT_BY_EXIT = {0: "PASS", 1: "FAIL", 2: "REFUSED", 3: "NOT CHECKED"}
MAKE_TIMEOUT = 600
RUN_TIMEOUT = 900
DEFAULT_LIVE_PORT = 8765
LIVE_READY_SECONDS = 15
#: Verdicts for which a live view is wanted: a failing design is exactly what
#: you want to watch. REFUSED has no ELF for the design on screen.
LIVE_VERDICTS = ("PASS", "FAIL", "NOT CHECKED")


def verdict_for(exit_code):
    """(verdict, not_a_verdict) from run_bound_devices.py's exit code - the only input.
    A code outside 0-3 is a crashed or killed runner, not a judgement: REFUSED."""
    if exit_code in VERDICT_BY_EXIT:
        return VERDICT_BY_EXIT[exit_code], False
    return "REFUSED", True


class Refused(Exception):
    """The chain cannot run. Carries the user-facing reason."""


def read_imports(root):
    """Variables imports.mak sets with = / := / ?= (literal values only)."""
    values = {}
    path = Path(root) / "imports.mak"
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\s*(?:export\s+)?([A-Z_]+)\s*(\?=|:=|=)\s*(.*?)\s*$", line)
        if m and "$(" not in m.group(3):
            values.setdefault(m.group(1), m.group(3))
    return values


def tools_path(root, env):
    return (env.get("TOOLS_PATH") or read_imports(root).get("TOOLS_PATH")
            or ((os.environ.get("SystemDrive", "C:") + "/ti") if os.name == "nt" else str(Path.home() / "ti")))


def find_gmake(root, env):
    """gmake is not on a GUI process's PATH. Env override, PATH, then CCS under
    imports.mak's TOOLS_PATH (any ccs* version: imports.mak names ccs1280, the
    install may be another)."""
    exe = "gmake.exe" if os.name == "nt" else "gmake"
    override = env.get("GMAKE")
    if override and Path(override).exists():
        return override
    for directory in env.get("PATH", "").split(os.pathsep):
        if directory and (Path(directory) / exe).exists():
            return str(Path(directory) / exe)
    imports = read_imports(root)
    ccs = env.get("CCS_PATH") or imports.get("CCS_PATH")
    candidates = [Path(ccs) / "utils" / "bin" / exe] if ccs else []
    candidates += [Path(p) for p in sorted(glob.glob(
        str(Path(tools_path(root, env)) / "ccs*" / "ccs" / "utils" / "bin" / exe)), reverse=True)]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise Refused("gmake not found: it is not on the GUI process PATH and no CCS install "
                  f"was found under {tools_path(root, env)}. Set GMAKE to its full path")


def find_clpru(root, env):
    exe = "clpru.exe" if os.name == "nt" else "clpru"
    path = Path(tools_path(root, env)) / "ti-cgt-pru_2.3.3" / "bin" / exe
    if not path.exists():
        raise Refused(f"clpru not found at {path} (TOOLS_PATH from the environment or imports.mak)")
    return str(path)


def resolve_project(project):
    """(syscfg, make_dir) from an example.syscfg path or a firmware/make dir."""
    if not project:
        raise Refused("no project: the GUI did not report the open .syscfg path; set "
                      "'TI Run Project' in Simulation Settings")
    path = Path(project).resolve()
    if path.is_file():
        if path.name != "example.syscfg":
            raise Refused(f"{path.name}: the project makefile builds example.syscfg, so "
                          f"only that file can be run")
        fw = path.parent
    elif path.is_dir():
        fw = path.parent if (path / "makefile").exists() and (path.parent / "example.syscfg").exists() else path
    else:
        raise Refused(f"project path does not exist: {project}")
    syscfg = fw / "example.syscfg"
    make_dir = fw / "ti-pru-cgt"
    if not syscfg.exists() or not (make_dir / "makefile").exists():
        raise Refused(f"{fw} has no example.syscfg with a ti-pru-cgt/makefile beside it")
    return syscfg, make_dir


def elf_path(make_dir):
    text = (make_dir / "makefile").read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^OUTPUT_NAME\s*:?=\s*(\S+)", text, re.M)
    if not m:
        raise Refused(f"{make_dir / 'makefile'} sets no OUTPUT_NAME")
    return make_dir / "generated" / f"{m.group(1)}.out"


def embedded_digest(asm):
    m = re.search(r"^; PRU_DESIGN_DIGEST (\S+)\s*$", Path(asm).read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else None


def run_logged(argv, cwd, env, log, timeout):
    with open(log, "a", encoding="utf-8", errors="replace") as f:
        f.write(f"\n$ {' '.join(argv)}\n")
        f.flush()
        try:
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
            proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, creationflags=flags)
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                kill_process_tree(proc)
                f.write(f"TIMEOUT after {timeout}s (terminated process tree rooted at {proc.pid})\n")
                raise Refused(f"{Path(argv[0]).name} timed out after {timeout}s; terminated its process tree")
            f.write((stdout or "") + (stderr or ""))
            return subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            f.write(f"TIMEOUT after {timeout}s\n")
            raise Refused(f"{Path(argv[0]).name} timed out after {timeout}s")


def kill_process_tree(proc):
    """Stop only this command and its children; never kill by image name."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, text=True, timeout=30)
    else:
        proc.kill()


class ProjectLock:
    def __init__(self, make_dir):
        self.path = Path(make_dir) / ".ti_run.lock"

    def _holder_pid(self):
        """The pid recorded in the lock file, or None when it holds no parsable pid."""
        try:
            m = re.match(r"pid=(\d+)", self.path.read_text(encoding="ascii"))
        except (OSError, UnicodeDecodeError):
            return None
        return int(m.group(1)) if m else None

    def _holder_alive(self):
        """False only when the recorded owner is provably gone (a hard-killed run).

        A lock with no parsable pid (empty, garbage, unreadable) is treated as held: it is
        also what a live run's lock looks like between O_EXCL create and the pid write."""
        pid = self._holder_pid()
        return True if pid is None else pid_alive(pid)

    def __enter__(self):
        for attempt in (0, 1):
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                if attempt == 0 and not self._holder_alive():
                    try:
                        self.path.unlink()
                    except FileNotFoundError:
                        pass
                    continue
                pid = self._holder_pid()
                holder = f"pid {pid}" if pid is not None else "an unreadable pid"
                raise Refused(f"another TI pru-simulator run is already using {self.path.parent}: "
                              f"lock file {self.path} is held by {holder}; wait for it to finish, "
                              "or delete that file if that process is gone")
        try:
            os.write(self.fd, f"pid={os.getpid()}\n".encode())
        except BaseException:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_):
        os.close(self.fd)
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def pid_alive(pid):
    """Is a process with this PID running? (os.kill(pid, 0) would TERMINATE it on Windows.)"""
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return kernel32.GetLastError() == 5  # access denied: it exists
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def live_view_command(env):
    """The argv prefix that starts the live view. NCP_LIVE_VIEW_CMD replaces it
    (test-only: lets tests stand in a stub without TI pru-simulator;
    POSIX quoting, so use forward slashes in paths)."""
    override = env.get("NCP_LIVE_VIEW_CMD")
    if override:
        return shlex.split(override)
    return [sys.executable, str(ROOT / "scripts" / "sim" / "live_view.py")]


def powershell_exe():
    """PowerShell by absolute path: SysConfig's GUI process may have a PATH without it."""
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or (os.environ.get("SystemDrive", "C:") + "\\Windows")
    exe = Path(root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    return str(exe) if exe.exists() else "powershell"


def process_command_line(pid):
    """The command line of a running process, or None when it cannot be read.
    psutil is not a dependency: Windows asks PowerShell (Win32_Process), POSIX
    reads /proc or `ps`."""
    if os.name == "nt":
        try:
            out = subprocess.run(
                [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command",
                 f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"],
                capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return out.stdout.strip() or None
    try:
        raw = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
        return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip() or None
    except OSError:
        pass
    try:
        out = subprocess.run(["ps", "-p", str(int(pid)), "-o", "args="],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() or None


def _norm_cmd(text):
    """Slashes and case folded, so a Windows command line compares equal to the
    path/argument strings this tool recorded."""
    return str(text).replace("\\", "/").lower()


def is_live_view_process(pid, port=None, elf=None):
    """True only when a live pid is really THE live_view.py this tool started: its
    command line must name live_view.py and, when given, the recorded `--port` and
    ELF path. A recycled pid - or another project's or the user's own live view -
    never matches. Asked without port/elf it only checks for live_view.py."""
    if not pid_alive(pid):
        return False
    cmd = _norm_cmd(process_command_line(pid) or "")
    if "live_view.py" not in cmd:
        return False
    if port is not None and not re.search(rf"--port[ =]+{int(port)}(?!\d)", cmd):
        return False
    if elf is not None and _norm_cmd(elf) not in cmd:
        return False
    return True


def kill_pid_tree(pid):
    """Stop exactly this pid and its children; never by image name."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       capture_output=True, text=True, timeout=30)
    else:
        import signal
        try:  # started with start_new_session, so the pid is its group id
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return predicate()


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def live_info_answers(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/live/info", timeout=2) as resp:
            return resp.status == 200
    except (OSError, ValueError):
        return False


def port_accepts(port, timeout=0.2):
    """True when something accepts a TCP connection on 127.0.0.1:port. A short
    connect_ex: on Windows urlopen against a closed port burns ~2 s in refused-connect
    retries however small its timeout is."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            return sock.connect_ex(("127.0.0.1", int(port))) == 0
        except OSError:
            return False


def spawn_detached(argv, env, log):
    """Start argv so it outlives this process (and the launcher, and SysConfig's
    wait): no console, own process group/session, stdio on the log file."""
    with open(log, "ab") as out:
        kwargs = {"env": env, "stdin": subprocess.DEVNULL, "stdout": out,
                  "stderr": subprocess.STDOUT, "close_fds": True}
        if os.name == "nt":
            base = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                    | subprocess.CREATE_NO_WINDOW)
            try:
                # Leave a parent job object if the host put us in one that allows
                # it. SysConfig 1.28 uses a plain child_process.spawn (no job), so
                # this is belt and braces; a job without breakaway raises: retry.
                return subprocess.Popen(argv, creationflags=base | 0x01000000, **kwargs)
            except OSError:
                return subprocess.Popen(argv, creationflags=base, **kwargs)
        return subprocess.Popen(argv, start_new_session=True, **kwargs)


def live_record_path(make_dir):
    return Path(make_dir) / ".ti_live_view.json"


def stop_recorded_live_view(make_dir):
    """Stop the live view an earlier --live run recorded - and ONLY it: the pid
    must be alive and its command line must be live_view.py with the recorded
    --port and ELF. Returns a note
    about a recorded pid that was left alone, else None."""
    try:
        record = json.loads(live_record_path(make_dir).read_text(encoding="utf-8"))
        pid = int(record.get("pid"))
        port, elf = int(record.get("port")), str(record.get("elf") or "")
    except (OSError, ValueError, TypeError, AttributeError):
        return None
    if not pid_alive(pid):
        return None
    if not elf or not is_live_view_process(pid, port, elf):
        return (f"pid {pid} recorded by an earlier live view is not that live_view.py "
                f"process (port {port}); left alone")
    kill_pid_tree(pid)
    wait_until(lambda: not pid_alive(pid), 10)
    return None


def start_live_view(make_dir, elf, manifest, port, env):
    """Start the live view on exactly this ELF and manifest. Returns the
    result's "liveView" dict; never raises and never touches the verdict."""
    log = Path(make_dir) / "syscfg" / "ti_live_view.log"
    view = {"status": "failed", "url": f"http://127.0.0.1:{port}", "pid": None,
            "reason": None, "log": str(log)}
    try:
        if not 1 <= port <= 65535:
            view.update(status="not started", reason=f"port {port} is not a valid TCP port")
            return view
        note = stop_recorded_live_view(make_dir)
        # The old view's port may need a moment to be released.
        if not wait_until(lambda: port_is_free(port), 5):
            view.update(status="not started",
                        reason=f"port {port} is in use by something that is not this tool's "
                               f"previous live view; pick another port"
                               + (f" ({note})" if note else ""))
            return view
        argv = live_view_command(env) + [str(elf), str(manifest), "--port", str(port)]
        if env.get("NCP_LIVE_NO_BROWSER") == "1":
            argv.append("--no-browser")
        log.parent.mkdir(exist_ok=True)
        log.write_text(f"$ {' '.join(argv)}\n", encoding="utf-8")
        proc = spawn_detached(argv, env, log)
        view["pid"] = proc.pid
        timeout = float(env.get("NCP_LIVE_READY_TIMEOUT") or LIVE_READY_SECONDS)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code = proc.poll()
            if code is not None:
                view.update(reason=f"the live view exited with code {code} before it answered; see {log}")
                return view
            if live_info_answers(port):
                view.update(status="started")
                live_record_path(make_dir).write_text(json.dumps(
                    {"pid": proc.pid, "port": port, "elf": str(elf),
                     "started": time.strftime("%Y-%m-%dT%H:%M:%S")}), encoding="utf-8")
                return view
            time.sleep(0.2)
        kill_pid_tree(proc.pid)
        view.update(reason=f"the live view did not answer on port {port} within {timeout:g}s; "
                           f"stopped it; see {log}")
        return view
    except Exception as exc:  # the view is a convenience: report, never raise
        view.update(status="failed", reason=f"{type(exc).__name__}: {exc}")
        return view


def not_started(port, reason):
    return {"status": "not started", "url": f"http://127.0.0.1:{port}", "pid": None,
            "reason": reason, "log": None}


def port_owner_pid(port):
    """The pid listening on 127.0.0.1:port, or None when it cannot be read.
    Windows asks PowerShell (Get-NetTCPConnection), POSIX asks lsof."""
    cmd = ([powershell_exe(), "-NoProfile", "-NonInteractive", "-Command",
            f"(Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue "
            f"| Select-Object -First 1).OwningProcess"]
           if os.name == "nt" else ["lsof", "-t", f"-iTCP:{int(port)}", "-sTCP:LISTEN"])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return int(out[0]) if out and out[0].isdigit() else None


def design_of_view_command(cmd):
    """A short design name from a live_view.py command line: the folder under
    examples/ that holds its ELF, else the ELF's file name, else None."""
    found = re.search(r'([^\s"]+\.(?:out|elf))', _norm_cmd(cmd))
    if not found:
        return None
    elf = found.group(1)
    under = re.search(r"/examples/([^/]+)/", elf)
    return under.group(1) if under else elf.rsplit("/", 1)[-1]


def other_design_view(port, elf):
    """a run that did not ask for a live view still says so when a live
    view of a DIFFERENT design is serving on the configured port. It only looks:
    that view is never stopped by a run that did not ask for one. None when
    nothing answers there, the view is this run's own ELF, or the ELF this run
    would build is unknown (then it cannot be told apart from the run's own view,
    and saying nothing beats calling it foreign), or the listener is readable and
    is not a live_view.py at all."""
    if not elf or not port_accepts(port) or not live_info_answers(port):
        return None
    pid = port_owner_pid(port)
    cmd = process_command_line(pid) if pid else None
    if cmd and _norm_cmd(elf) in _norm_cmd(cmd):
        return None
    if cmd and "live_view.py" not in _norm_cmd(cmd):
        return None  # something else is answering there; it is not a live view to report
    design = design_of_view_command(cmd) if cmd else None
    who = f"design '{design}'" if design else "a design this run cannot identify"
    return {"status": "other design", "url": f"http://127.0.0.1:{port}", "pid": pid, "design": design,
            "reason": f"a live view of {who} is still serving on port {port}; this run did not ask for "
                      f"a live view, so it was left running (tick 'Open live web view' to replace it)",
            "log": None}


def expected_elf(project):
    """The ELF this run builds (or would have built), known before any build so the
    own-design check works on a REFUSED run too. None when it cannot be resolved."""
    try:
        return str(elf_path(resolve_project(project)[1]))
    except Exception:
        return None


def parse_run_output(out):
    """Display-only facts from run_bound_devices.py's output. Not used to judge."""
    devices = []
    for block in re.split(r"\n(?=Device \w+ on GPI\d+:)", out):
        head = re.match(r"Device (\w+) on GPI(\d+):", block)
        if not head:
            continue
        device = {"kind": head.group(1), "pin": int(head.group(2))}
        m = re.search(r"Firmware decoded R[\d.\w]+: (\d+); model position: (\d+)", block)
        if m:
            device["decoded"], device["expected"] = int(m.group(1)), int(m.group(2))
        notes = [ln.strip() for ln in block.splitlines()
                 if re.match(r"\s*(FAIL|NOT CHECKED):", ln)]
        if notes:
            device["note"] = "; ".join(notes)
        devices.append(device)
    cycles = re.search(r"^Cycles: (\d+)", out, re.M)
    return devices, int(cycles.group(1)) if cycles else None


def run_chain(args, env, result):
    root = ROOT
    syscfg, make_dir = resolve_project(args.project)
    gmake = find_gmake(root, env)
    find_clpru(root, env)
    from scripts.sim.elf_cosim import find_pru_simulator
    try:
        env["PRU_SIMULATOR_PATH"] = find_pru_simulator()
    except RuntimeError as exc:
        raise Refused(str(exc))
    if not args.digest:
        raise Refused("the GUI sent no design digest, so the design on screen cannot be "
                      "matched to the saved file")
    env["PATH"] = os.path.dirname(gmake) + os.pathsep + env.get("PATH", "")
    env.setdefault("PRU_NO_CODE_TOOL_PATH", str(root))
    result["project"] = str(syscfg)
    with ProjectLock(make_dir):
        log = make_dir / "syscfg" / "ti_run.log"
        log.parent.mkdir(exist_ok=True)
        log.write_text("", encoding="utf-8")
        result["log"] = str(log)
        (make_dir / "generated").mkdir(exist_ok=True)
        make = [gmake, "-C", str(make_dir)]

        gen = run_logged(make + ["syscfg"], make_dir, env, log, MAKE_TIMEOUT)
        asm = make_dir / "syscfg" / "pru_syscfg.asm"
        if gen.returncode != 0 or not asm.exists():
            raise Refused(f"SysConfig generation failed (exit {gen.returncode}); see {log}")
        on_disk = embedded_digest(asm)
        result["designDigest"] = args.digest
        if on_disk is None:
            raise Refused("the generated assembly carries no design digest; cannot match it to the GUI")
        if on_disk != args.digest:
            raise Refused("the design on screen differs from the saved .syscfg (digest "
                          f"{args.digest} vs {on_disk}); save the design, then run again")

        build = run_logged(make + ["all", "BUILD_MCUPLUS=n"], make_dir, env, log, MAKE_TIMEOUT)
        if build.returncode != 0:
            raise Refused(f"clpru build failed (exit {build.returncode}); see {log}")
        if embedded_digest(asm) != on_disk:
            raise Refused("the saved .syscfg changed while building; run again")
        elf = elf_path(make_dir)
        if not elf.exists():
            raise Refused(f"build reported success but {elf} does not exist")
        manifest = make_dir / "syscfg" / "pru_device_bindings.json"
        extract_device_bindings.extract(asm, manifest)
        vcd = make_dir / "syscfg" / "ti_run.vcd"
        if vcd.exists():
            vcd.unlink()

        cmd = [sys.executable, str(root / "scripts" / "sim" / "run_bound_devices.py"),
               str(elf), str(manifest), "--vcd", str(vcd)]
        if args.cycles:
            cmd += ["--cycles", str(args.cycles)]
        run = run_logged(cmd, make_dir, env, log, RUN_TIMEOUT)
        result["exitCode"] = run.returncode
        result["verdict"], not_a_verdict = verdict_for(run.returncode)
        result["elf"], result["manifest"] = str(elf), str(manifest)
        result["devices"], result["cycles"] = parse_run_output(run.stdout)
        result["vcd"] = str(vcd) if vcd.exists() else None
        if not_a_verdict:
            result["reason"] = (f"run_bound_devices.py exited {run.returncode}, which is not a "
                                f"verdict; see {log}")
        elif result["verdict"] != "PASS":
            tail = [ln for ln in (run.stdout + run.stderr).splitlines()
                    if re.match(r"\s*(FAIL|NOT CHECKED|REFUSED)", ln)]
            result["reason"] = "; ".join(ln.strip() for ln in tail[:3]) or None
        if args.live:
            if result["verdict"] in LIVE_VERDICTS:
                result["liveView"] = start_live_view(make_dir, elf, manifest, args.live_port, env)
            else:
                result["liveView"] = not_started(args.live_port, f"the run was {result['verdict']}")


def write_result(path, result):
    """Atomic: the GUI may read $comFile the instant this process exits."""
    data = json.dumps(result, indent=2)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", default="")
    ap.add_argument("--digest", default="")
    ap.add_argument("--com", required=True)
    ap.add_argument("--cycles", type=int, default=None)
    ap.add_argument("--live", action="store_true",
                    help="after the run, open the live web view on the ELF just built")
    ap.add_argument("--live-port", type=int, default=DEFAULT_LIVE_PORT)
    args = ap.parse_args(argv)
    result = {"schema": 1, "verdict": None, "exitCode": None, "reason": None, "devices": [],
              "cycles": None, "vcd": None, "designDigest": args.digest or None}
    try:
        run_chain(args, dict(os.environ), result)
    except Refused as exc:
        result["verdict"], result["reason"] = "REFUSED", str(exc)
    except Exception as exc:  # never leave $comFile holding a stale or empty result
        result["verdict"], result["reason"] = "REFUSED", f"wrapper error: {type(exc).__name__}: {exc}"
    if not args.live:
        try:
            note = other_design_view(args.live_port, result.get("elf") or expected_elf(args.project))
        except Exception:  # a convenience line: never let it touch the verdict
            note = None
        if note:
            result["liveView"] = note
    if args.live and "liveView" not in result:
        result["liveView"] = not_started(
            args.live_port, f"no live view: the run was {result['verdict']}, so there is no "
                            f"ELF for the design on screen ({result['reason']})")
    write_result(args.com, result)
    print(f"{result['verdict']}: {result['reason'] or ''}".rstrip(": "))
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
