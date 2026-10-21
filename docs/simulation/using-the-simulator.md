# Using the Simulator

The PRU No-Code Tool includes a cycle-accurate software simulator that lets you execute and debug your PRU block design without physical hardware.

---

## 1. In-Tool Visual Simulator (GUI)

The visual simulator executes generated assembly code directly inside the SysConfig environment using the custom simulation engine located in `.metadata/sysconfig/.meta/pru_blocks/common/simulation/` (`pru_core.js`, `pru_dmem0.js`, `pru_smem.js`, `r30_simulation.js`).

### How to Launch and Run
1. Open your block diagram in the **SysConfig GUI**.
2. Add the **Simulation Settings** module from the left panel.
3. Configure the core parameters (such as clock frequency and cycle limit) inside the **Simulation Settings** instance (see [Simulation Settings Guide](./simulation_settings.md)).
4. Open the **Simulation** tab/window in the GUI.
5. Click **Step** to execute a single instruction or **Run** to simulate the entire configured cycle count.
6. The simulator will update the registers, DMEM, and SMEM tables in real-time, and plot output signals in the waveform viewer.

### Reading State and Waveforms
* **Waveform Viewer**: Shows the states of selected `R30` (Output) and `R31` (Input) pins over simulated cycles.
* **Register Table**: Displays current values of `R0` through `R31`.
* **Memory Tables**: Shows data residing in PRU Data RAM (`DMEM0` / Constant Table `c28`) and Shared RAM (`SMEM` / Constant Table `c30`).
* **Cycle Count**: The simulator tracks exactly how many cycles have elapsed. Each standard instruction takes **1 cycle** (5 ns at 200 MHz), while memory accesses (like `LBBO`/`SBBO`) take more depending on data size.

---

## 2. Headless CLI Testbench (`test_headless_sim.js`)

For automated testing, validation, and Continuous Integration (CI), the tool includes a headless simulator runner located at [test_headless_sim.js](../../scripts/test_headless_sim.js).

This script acts as a Node.js compatibility shim for `pru_core.js` and `pru_dmem0.js`, executing raw assembly instructions in a sandboxed JavaScript Virtual Machine (`vm`) context without the CCS GUI.

### How to Run
Execute the following command from the repository root:
```bash
node scripts/test_headless_sim.js
```
To run the entire compliance suite including ledger verification:
```bash
node scripts/run_all_tests.js
```

### Writing a New Block Test
To add unit tests or validation checks for a new block, append a test function inside `scripts/test_headless_sim.js`:

1. **Load the block's module schema**:
   ```javascript
   const myModule = loadBlockModule('my_block_name', 'pru_io_blocks');
   ```
2. **Retrieve and expand the macro snippet**:
   ```javascript
   const expandedAsm = expandMacro(myModule.getMacro('', 'm_my_macro'), {
       PARAM_NAME: 'R4',
       PIN: '5'
   });
   ```
3. **Execute the instruction stream**:
   ```javascript
   const simResult = runSim([
       'ldi R4, 10',
       ...expandedAsm,
       'halt'
   ], 100); // cycle limit
   ```
4. **Assert post-conditions**:
   ```javascript
   if (simResult.pruState.registers[4] !== expectedVal) {
       throw new Error('My Block validation failed!');
   }
   ```

---

## 3. Simulator Limitations (What is Modeled vs Not)

The simulator is a **lightweight logical instruction executor**, not a gate-level cycle-accurate hardware emulator.

### Supported and Modeled
* **Standard ALU instructions**: `ADD`, `SUB`, `ADC`, `SBC`, `AND`, `OR`, `XOR`, `NOT`, `LSL`, `LSR`, `LDI`, `LDI32`.
* **Flow control**: `JMP`, `CALL`, `RET`, `HALT`, conditional branches (`QBNE`, `QBEQ`, `QBGT`, `QBLT`, `QGE`, `QBA`).
* **Memory transactions**: `LBBO` and `SBBO` (with correct byte offsets and sizing).
* **Direct Input/Output**: Toggling `R30` output pins and reading injected history waveforms from `R31` input pins.

### NOT Modeled / Limitations
* **Unsupported Hardware Operations**: The PRU core has no hardware multiplier. Instructions like `MULL` are not supported by the assembler or the simulator. Ensure your designs rely on shifts or the **Hardware MAC** block for multiplication.
* **No Real Peripherals**: The simulator does not model the internal registers of actual SoC peripherals (e.g. UART, I2C, IEP timers, CAN controllers) at the transistor level. Instead, these are stubbed or mocked in the testbench using the `mmioMap` and `r31Hist` parameters.
* **No Pipeline Stall / Memory Latency**: External memory accesses (DDR or SoC MSMC) are treated as instantaneous, ignoring potential interconnect arbitration delays or bus contention.
