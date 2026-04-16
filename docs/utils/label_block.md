---

## Label Block

### Purpose

A free-text annotation box for documenting the visual block diagram. Labels generate no assembly code and have no effect on PRU execution — they exist purely for readability and collaboration.

### Features

- Visual text box placed anywhere in the diagram
- No ports — cannot be connected to other blocks
- No code generation — zero impact on firmware
- Useful for team collaboration and design documentation

### Configuration

| Parameter | Description |
|-----------|-------------|
| $name | The text displayed in the label box |

### How to Use

1. Add a Label block from the Utils palette
2. Set the instance name (`$name`) to the text you want displayed
3. Position it near the blocks it describes

### Common Use Cases

- Marking functional sections (e.g., "SPI Initialization", "Data Processing Loop")
- Adding notes about timing constraints or hardware requirements
- Explaining complex conditional logic
- Indicating which hardware pins are expected to be connected

### Technical Details

- **Code generation**: None — the block is completely invisible to the assembler
- **Ports**: None — labels cannot be wired to other blocks
- **Performance**: 0 cycles

---
