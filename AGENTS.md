# AGENTS.md — AI Context for PRU No-Code Tool

This file guides AI assistants when working with the PRU No-Code Tool inside TI SysConfig.

---

## Critical Rules

**Rule 1: MANDATORY — Always `listModules()` → `getAIContext()` → `addModuleInstances()`**
- Call `listModules()` to get exact full module paths (short names like `"uart_tx"` do NOT work)
- Call `getAIContext(modulePath)` on every block before adding it — **NO EXCEPTIONS**, even for familiar blocks
- **CRITICAL: Read the "How to Configure (For AI/Scripting)" section in the context — this is ESSENTIAL for proper functioning**
- Reason: `getAIContext()` reveals critical details you CANNOT guess:
  - Parameter encodings (e.g., `oversampleSize = 7` means 8x oversampling, not 8)
  - Baud rate calculation formulas and timing constraints
  - Correct parameter types (int vs string)
  - Valid value ranges and special encodings
- If you skip this step, acknowledge your mistake immediately and re-read the full context before proceeding

**Rule 2: Always build after completing block setup**
- After adding, configuring, and connecting blocks, trigger a build to check for errors
- Fix errors before reporting the setup as complete

**Rule 3: Always `getModuleInstances()` after renaming a block**
- When you set `$name` on an instance, the `moduleInstanceId` auto-updates
- Using the old ID in subsequent connections will fail silently
- Pattern: Set name → call `getModuleInstances()` → use new IDs for connections

**Rule 4: No AI tool for connections — edit .syscfg directly**
- Add `scripting.connect(instanceA, "portOnA", instanceB, "portOnB")` calls in the `.syscfg` file under "Connections between modules"
- Port types: `"output1"`/`"input1"` (data), `"next"`/`"prev"` (control flow)
- If `getAIContext()` returns nothing, verify the path with `listModules()` first

---

## Available AI Tools

| Tool | Purpose |
|------|---------|
| `listModules()` | Get exact full paths for all available blocks |
| `getAIContext(modulePath)` | Read block documentation, parameters, encodings, and usage notes |
| `addModuleInstances(modulePath, configs)` | Add block instances with configuration |
| `getModuleInstances(modulePath)` | Get current instances including up-to-date IDs (call after rename) |
| `removeModuleInstances(modulePath, instanceIds)` | Remove block instances |
| `setConfigurables(instanceId, configs)` | Update configuration on an existing instance |

---

## Design Build Pattern

1. `listModules()` → get full paths for needed blocks
2. `getAIContext(modulePath)` for each block → read parameters, types, valid values
3. `addModuleInstances(modulePath, {})` → add with correct config
4. [If renamed] `getModuleInstances()` → retrieve updated IDs
5. Edit `.syscfg` → add `scripting.connect()` calls
6. Build → verify no errors, fix if needed

---

## Connection Example

```js
// Data connections
scripting.connect(load_constant_1, "output1", memory_access_1, "input1");
scripting.connect(memory_access_1, "output1", uart_tx1, "input1");

// Control flow (execution order)
scripting.connect(load_constant_1, "next", memory_access_1, "prev");
scripting.connect(memory_access_1, "next", uart_tx1, "prev");
```

Key: Blocks can have both data and control connections. Port names matter; order of pairs doesn't.

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

## Quick Reference

- **Simulation Settings** (always present): Controls PRU clock, cycle count, R30 output display, R31 input injection (Timestamp or Pattern mode)
- See `docs/simulation/simulation_settings.md` for full documentation and SPI loopback example
