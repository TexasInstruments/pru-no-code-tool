#!/usr/bin/env python3
import os
import glob
import re
import sys

def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    js_path = os.path.join(root, ".metadata", "sysconfig", ".meta", "pru_blocks", "common", "simulation", "device_models.js")
    with open(js_path, "r", encoding="utf-8") as f:
        js_content = f.read()

    match = re.search(r"const DEVICE_MODEL_KINDS = \[([\s\S]*?)\];", js_content)
    if not match:
        print("FAIL: Could not find DEVICE_MODEL_KINDS")
        sys.exit(1)

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
    for cls in found_classes:
        if cls in abstract_classes:
            continue
        kind = class_to_kind.get(cls)
        if kind is None:
            missing_from_catalog.append(f"{cls} (not mapped to a kind in test)")
            continue
        if kind not in kinds_in_js:
            missing_from_catalog.append(f"{cls} (kind '{kind}')")

    if missing_from_catalog:
        print("FAIL: The following DeviceModel subclasses are missing from DEVICE_MODEL_KINDS:")
        for m in missing_from_catalog:
            print("  - " + m)
        sys.exit(1)

    print(f"PASS: All {len(found_classes)} DeviceModel subclasses are accounted for in DEVICE_MODEL_KINDS.")
    sys.exit(0)

if __name__ == '__main__':
    main()