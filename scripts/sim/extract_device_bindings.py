"""Extract the binding record emitted in the CLI's always-run assembly template."""
import argparse
import json
from pathlib import Path


def extract(asm, destination):
    lines = Path(asm).read_text(encoding="utf-8").splitlines()
    start = lines.index("; PRU_DEVICE_BINDINGS_BEGIN")
    end = lines.index("; PRU_DEVICE_BINDINGS_END", start + 1)
    payload = "\n".join(line.removeprefix("; ") for line in lines[start + 1:end])
    manifest = json.loads(payload)
    if manifest.get("version") != 1 or not isinstance(manifest.get("bindings"), list):
        raise ValueError("invalid generated device-binding record")
    Path(destination).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asm")
    parser.add_argument("destination")
    args = parser.parse_args()
    extract(args.asm, args.destination)
