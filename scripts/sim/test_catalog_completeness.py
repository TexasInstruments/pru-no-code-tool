#!/usr/bin/env python3
"""Every DeviceModel subclass in perif/ and pru_io/ is a kind in the GUI device catalogue
(DEVICE_MODEL_KINDS in common/simulation/device_models.js), so a new model cannot be added
without being selectable. Runs under pytest, or directly as a script."""
import os
import glob
import re
import sys


def missing_from_catalog():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    js_path = os.path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "simulation", "device_models.js")
    with open(js_path, "r", encoding="utf-8") as f:
        js_content = f.read()

    match = re.search(r"const DEVICE_MODEL_KINDS = \[([\s\S]*?)\];", js_content)
    if not match:
        return ["DEVICE_MODEL_KINDS not found in device_models.js"], set()

    kinds_in_js = set(re.findall(r'kind:\s*"([^"]+)"', match.group(1)))

    py_files = []
    for d in ["perif", "pru_io"]:
        py_files.extend(glob.glob(os.path.join(root, d, "*.py")))

    found_classes = set()
    for pf in py_files:
        with open(pf, "r", encoding="utf-8") as f:
            content = f.read()
            for m in re.finditer(r"^class\s+([A-Za-z0-9_]+)\s*\(\s*(?:pru_io\.|perif\.)?DeviceModel\s*\)\s*:", content, re.MULTILINE):
                found_classes.add(m.group(1))

    abstract_classes = {"SsiEndatEncoder", "QuadratureIndexEncoder"}
    # Stimulus sources, not devices: WaveformPlayer replays a cycle-keyed GPI waveform
    # (Simulation Settings pattern/timestamp modes), so it has no catalogue kind.
    stimulus_classes = {"WaveformPlayer"}

    class_to_kind = {
        "HallSensorModel": "hall",
        "DualOssdEmitter": "ossd",
        "SpiAdc": "spi_adc",
        "StepDirDriver": "step_dir",
        "Ws2812String": "ws2812",
        "BissLineEncoder": "bissline",
        "EndatEncoder": "endat",
        "MdioPhyModel": "mdio_phy",
    }

    missing_from_catalog = []
    for cls in sorted(found_classes):
        if cls in abstract_classes or cls in stimulus_classes:
            continue
        kind = class_to_kind.get(cls)
        if kind is None:
            missing_from_catalog.append(f"{cls} (not mapped to a kind in test)")
            continue
        if kind not in kinds_in_js:
            missing_from_catalog.append(f"{cls} (kind '{kind}')")

    return missing_from_catalog, found_classes


def test_every_device_model_class_is_in_the_catalogue():
    missing, found = missing_from_catalog()
    assert found, "no DeviceModel subclasses found under perif/ or pru_io/"
    assert not missing, "DeviceModel subclasses missing from DEVICE_MODEL_KINDS: " + ", ".join(missing)


def main():
    missing, found = missing_from_catalog()
    if missing:
        print("FAIL: The following DeviceModel subclasses are missing from DEVICE_MODEL_KINDS:")
        for m in missing:
            print("  - " + m)
        sys.exit(1)
    print(f"PASS: All {len(found)} DeviceModel subclasses are accounted for in DEVICE_MODEL_KINDS.")
    sys.exit(0)

if __name__ == '__main__':
    main()