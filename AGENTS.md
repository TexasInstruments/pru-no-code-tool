# AGENTS.md — AI Context for PRU No-Code Tool

This file guides AI assistants when working with the PRU No-Code Tool inside TI SysConfig.

---

## Critical Rules

**Rule 1: MANDATORY — Always `listModules()` → Read docs `.md` files → `addModuleInstances()`**
- Call `listModules()` to get exact full module paths (short names like `"uart_tx"` do NOT work)
- Read the docs `.md` file for every block before adding it — **NO EXCEPTIONS**, even for familiar blocks
- **ALSO READ THE DOCS FILE:** Pattern is `docs_ai/<category>/<block>.md`. Key examples per category:
  - Program Control: `docs_ai/program_control/loop_block.md`, `conditional_block.md`, `flow_control_block.md`
  - Data Handling: `docs_ai/data_handling/load_constant_block.md`, `arithmetic_block.md`
  - PRU I/O: `docs_ai/pru_io_blocks/pru_gpi_block.md`, `pru_spi_read.md`
  - Utilities: `docs_ai/utils/delay_block.md`, `memory_variable_block.md`
  - Always read the "How to Configure (For AI/Scripting)" section.
- **CRITICAL: Read the "How to Configure (For AI/Scripting)" section in the docs file** — this is ESSENTIAL
- Reason: The `.md` docs reveal critical details you CANNOT guess:
  - Parameter encodings (e.g., `oversampleSize = 7` means 8x oversampling, not 8)
  - Baud rate calculation formulas and timing constraints
  - Correct parameter types (int vs string)
  - Valid value ranges and special encodings
- If you skip reading the docs, acknowledge your mistake immediately and read the full `.md` file before proceeding

**Rule 2: Semantic naming prevents connection errors**
- Rename blocks immediately after creation to reflect PURPOSE, not just type
- Example: `Load_Constant_0` → `Data_Byte`, `Load_Constant_1` → `CRC_Init`, `Load_Constant_2` → `Shift_Amount_8`
- When connecting, semantic names make "right port to right source" obvious
- This catches "constant connected to wrong input" errors BEFORE building

**Rule 3: Pre-validate connections before building**
- For each block input, explicitly verify:
  1. Source block is correct (not accidentally using a different constant)
  2. Source port is correct (output1, not something else)
  3. Semantic purpose matches the connection (e.g., shift amount = 8, not data = 0xAA)
  4. Data type/size is compatible
- Use the Pre-Connection Validation Checklist (see Design Build Pattern) to catch errors

**Rule 4: Always build after completing block setup**
- After adding, configuring, and connecting blocks, trigger a build to check for errors
- Fix errors before reporting and build again to check for any other errors

**Rule 5: Always `getModuleInstances()` after renaming a block**
- When you set `$name` on an instance, the `moduleInstanceId` auto-updates
- Using the old ID in subsequent connections will fail silently
- Pattern: Set name → call `getModuleInstances()` → use new IDs for connections

**Rule 6: No AI tool for connections — edit .syscfg directly**
- Add `scripting.connect(instanceA, "portOnA", instanceB, "portOnB")` calls in the `.syscfg` file under "Connections between modules"
- Port types: `"output1"`/`"input1"` (data), `"next"`/`"prev"` (control flow)
- If the docs file (`docs_ai/<folder>/<block>.md`) is missing, verify the block path with `listModules()` first

---

## Available AI Tools

| Tool | Purpose |
|------|---------|
| `listModules()` | Get exact full paths for all available blocks |
| `readDocs(filePath)` | Read `.md` docs file at `docs_ai/<folder>/<block>.md` for parameters, encodings, usage notes |
| `addModuleInstances(modulePath, configs)` | Add block instances with configuration |
| `getModuleInstances(modulePath)` | Get current instances including up-to-date IDs (call after rename) |
| `removeModuleInstances(modulePath, instanceIds)` | Remove block instances |
| `setConfigurables(instanceId, configs)` | Update configuration on an existing instance |

---

## Design Build Pattern

### Step 0: Pre-Planning (CRITICAL — Do This First)

**Before adding ANY blocks**, sketch the complete data flow on paper or as text:

1. **Identify all data sources and operations:**
   - What constants are needed? (list each one with its purpose and value)
   - What blocks process the data?
   - What is the final output?

2. **Map inputs and outputs explicitly:**
   - For each block, list what connects to its inputs
   - Verify the SOURCE of each input (is it the right block?)
   - Verify the PURPOSE of each value (does it make logical sense?)

---

### Step 1: Add and Name Blocks (Semantic Naming)

1. `listModules()` → get full paths for needed blocks
2. `addModuleInstances(modulePath, {})` → add blocks
3. **Immediately rename each block to reflect its PURPOSE:**
   - `Load_Constant_0` → `Data_Byte` (or `Data_0xAA`)
   - `CRC_0` → `CRC_8bit` (clarifies CRC type)

   **Why:** When connecting later, semantic names make it obvious which constant goes where.

---

### Step 2: Configure and Validate Inputs

1. Read the docs `.md` file (`docs_ai/<folder>/<block>.md`) for the block → read parameters, types, valid values
2. `changeConfiguration()` → set values
3. **For each configurable, write down:**
   - What it does
   - Why this value (reference the pre-planning)
   - Expected behavior

---

### Step 3: Connect Blocks and Build

1. Edit `.syscfg` → add `scripting.connect()` calls (use semantic names from Step 1)
2. [If renamed] `getModuleInstances()` → retrieve updated IDs (if needed)
3. Build → verify no errors

---

## Complete Workflow Summary

```
PRE-PLANNING (before any tool calls):
  └─ Sketch data flow
  └─ List all constants needed (with PURPOSE and VALUE)
  └─ Map each block input to its source
  └─ Verify no "wrong variable to wrong port" mistakes

SETUP (add and configure):
  └─ listModules() 
  └─ addModuleInstances()
  └─ Rename each block semantically (by purpose)
  └─ getModuleDescription() / read parameters
  └─ changeConfiguration() + document WHY each value
  └─ save()

VALIDATION (verify before connecting):
  └─ For each block input, answer:
      • Source block: correct? ✓
      • Source port: correct? ✓
      • Semantic purpose: matches connection? ✓
      • Data type/size: compatible? ✓

CONNECT & BUILD:
  └─ Edit .syscfg with scripting.connect() calls
  └─ Build
  └─ Fix errors if found
```

---

## Architecture Facts

- Generates **PRU assembly code** (not C)
- Register allocation is automatic; do NOT manually assign
- Reserved: **R28** (TEMP_REG1), **R29** (TEMP_REG2), **R30** (GPO), **R31** (GPI)
- `Simulation Settings` controls PRU clock frequency, cycle count, R30/R31 signals, and input injection modes

---

## Block Categories

| Category | Examples |
|----------|---------|
| Data | Load Constant, Arithmetic, Bitwise |
| Control | Loop, If/Else, Group, Flow Control, Configure Constant Table |
| PRU I/O | PRU GPI, PRU GPO, SPI Read/Write/Transfer, UART TX/RX |
| Utility | Delay, Lookup Table, Memory Variable, Memory Access, Label |
| Application | CRC |

---

## Common Mistakes & How to Avoid Them

### Mistake 1: Wrong Constant Connected to Block Input

**Example:**
```
Load_Constant (Data=0xAA)  → Bitwise_LSL.input2 (WRONG)
                              Should be Bitwise_LSL.input1 for the value to shift
                              
Load_Constant (Shift=8)    → Bitwise_LSL.input1 (WRONG)
                              Should be Bitwise_LSL.input2 for the shift amount
```

**How to avoid:**
1. **Use semantic names:** `Data_Byte`, `Shift_Amount_8` make confusion obvious
2. **Validate before connecting:** Check the Pre-Connection Validation Checklist
3. **Document each connection:** Write why each constant goes to each port

### Mistake 2: Reusing a Constant for Multiple Different Purposes

**Example:**
```
Load_Constant_0 (Data=0xAA) → CRC.input2 ✓ (data to CRC)
Load_Constant_0 (Data=0xAA) → Bitwise.input2 (WRONG if input2 should be shift amount)
```

**How to avoid:**
1. **Plan upfront:** List ALL constants needed with their PURPOSE and VALUE
2. **Add dedicated constants:** If you need both data AND shift amount, create separate Load Constant blocks
3. **Name semantically:** Different purposes = different names

### Mistake 3: Not Validating Data Size/Type Through the Chain

**Example:**
```
CRC_0 (output = 8 bits) → Bitwise_LSL (input1) → OR (input1) → UART_TX (expects 16 bits)
  Bitwise_LSL with LSL expands to 16 bits ✓
  But what if you accidentally used AND? Output might be 8 bits ✗
```

**How to avoid:**
1. **Trace output size:** For each block, know the output size
2. **Verify compatibility:** Check if next block's input matches the output size
3. **Test the chain:** Mentally execute: CRC (8b) → LSL (16b) → OR (16b) → UART (16b) ✓

---

## Quick Reference

- **Simulation Settings** (always present): Controls PRU clock, cycle count, R30 output display, R31 input injection (Timestamp or Pattern mode)
- See `docs/simulation/simulation_settings.md` for full documentation and SPI loopback example

---

## Pre-Connection Validation Checklist Template

Use this for ANY block-based design:

```
BLOCK: [BlockName]

For each input port:
  □ Input: [inputN]
    Purpose (from pre-planning): ___________
    Source block: ___________
    Source port: output1? ✓
    Semantic check: Does this source make sense? ___________
    Data type: [8-bit|16-bit|32-bit]
    Compatible with next block? ✓
    
    Verification: Source is [CRC_0|Load_Constant_X|Bitwise_Y], NOT [other block]
                  Purpose matches: Sending [data|shift amount|init value], NOT [something else]
```

Example for Bitwise_LSL (Shift Left):
```
BLOCK: Bitwise_0 (CRC_ShiftLeft_8)

  □ Input: input1
    Purpose: CRC value to be shifted
    Source block: CRC_0
    Source port: output1 ✓
    Semantic check: "Shift the CRC output" ✓
    Data type: 8-bit input → 16-bit output after LSL
    Compatible: Yes, next block (Bitwise_OR) accepts 16-bit ✓
    
    Verification: Using CRC_0.output1, NOT Load_Constant_0 ✓

  □ Input: input2
    Purpose: Shift amount (must be constant 8)
    Source block: Load_Constant_2 (Shift_Amount_8)
    Source port: output1 ✓
    Semantic check: "Shift by 8 bits" ✓
    Data type: 8-bit (only lower bits used as shift count)
    
    Verification: Using Load_Constant_2 (8), NOT Load_Constant_0 (0xAA) ✓
                  NOT using Load_Constant_1 (0) ✓
```
