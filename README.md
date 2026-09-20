<div align="center">

<img src="https://upload.wikimedia.org/wikipedia/commons/b/ba/TexasInstruments-Logo.svg" width="150"><br/>
# PRU No-Code Tool

</div>

## Introduction

The PRU No-Code tool is a visual programming environment for the PRU-ICSS (Programmable Real-Time Unit and Industrial Communication Subsystem). It enables developers to create PRU firmware using a block-based graphical interface without writing assembly code manually.

The tool generates PRU assembly code from visual block diagrams, handling register allocation, timing calculations, and code organization automatically.

### Supported Devices

- AM64x
- AM243x
- AM261x

---

## Key Features

- **Visual Block-Based Programming**: Drag-and-drop blocks to create PRU programs
- **Automatic Code Generation**: Generates optimized PRU assembly code
- **Dynamic Register Allocation**: Registers allocated automatically, no manual management
- **Cycle-Accurate Timing**: Each block displays exact PRU cycle count
- **Simulation**: Simulate block execution to verify data flow and timing
- **Modular Code Organization**: Group blocks into callable subroutines
- **Pre-built I/O Blocks**: Ready-to-use SPI, UART, GPIO, and memory access blocks

---

## Using AI Assistants with This Tool

An **[AGENTS.md](AGENTS.md)** file is provided at the root of this repository. If you are using an AI assistant (CCS AI Chat, Claude, Copilot, or any other) to help build or modify designs with the PRU No-Code Tool, it is strongly recommended to load `AGENTS.md` as context for your AI session before starting.

The file contains critical workflow rules that prevent common AI mistakes such as using wrong parameter encodings, incorrect module paths, and stale instance IDs after renaming blocks. Loading it as context gives the AI the information it needs to call the SysConfig tools in the correct order and with the correct values.

---

## Getting Started

### Prerequisites

- TI SysConfig tool
- MCU+ SDK for your target device
- Code Composer Studio (CCS) or compatible IDE

### Installing dependencies 

- Install MCU+SDK , follow the steps mentioned in [here](./docs/getting_started_mcuplus.md)
- For AM64x install the dependencies by following the steps [here](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/SDK_DOWNLOAD_PAGE.html)
- For AM243x install the dependencies by following the steps [here](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/SDK_DOWNLOAD_PAGE.html)

## Building the examples 

### Building With Makefiles

> [!NOTE]
> Use `gmake` in Windows, and `make` in Linux.
>
> gmake is present in CCS. Add the path to the CCS gmake at
> `C:\ti\ccsxxxx\ccs\utils\bin` to your windows PATH.
>
> Unless mentioned otherwise, all `make` commands are invoked from the root
> folder of the `pru-no-code-tool` repository.

Makefiles can be used to:
   - build or clean all pru-no-code-tool projects
   - build or clean a specific pru-no-code-tool project
   - build or clean code for a specific core

For detailed steps on how to use makefiles, run ```make help``` from the root
folder of the `pru-no-code-tool` repository.

### Building With CCS

#### Building MCU+ projects in CCS

- The PRU firmware must be built before the MCU+ firmware. By default, projects
  from the pru-no-code-tool repo place the PRU firmware header file in the CCS workspace,
  in the top level of the PRU project's directory

- The MCU+ project include paths **must** include the path to the PRU project
  directory in the CCS workspace

- For more information about using MCU+ SDK projects with CCS, refer to the
  MCU+ SDK documentation: **Developer Guides > Using SDK with CCS Projects** 
  - [AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html)
  - [AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html)
  - [AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)

### Using an EVM with MCU+ SDK

For more details on EVM Board usage, please refer to the Getting started section of MCU+ SDK README_FIRST_*.html page. The MCU+ SDK User guides contain information on
  
- EVM setup
- CCS Setup, loading and running examples
- Flashing the EVM
- SBL, ROV and much more.

Getting started guides of MCU+ SDK are specific to a particular device. The links for all the supported devices are given below
- [AM64x  Getting Started Guide](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/GETTING_STARTED.html)
- [AM243x Getting Started Guide](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/GETTING_STARTED.html)
- [AM261x Getting Started Guide](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/GETTING_STARTED.html)

### Basic Workflow

1. Open SysConfig from your firmware project and add PRU No-Code module
2. Add blocks from the palette to your design
3. Connect blocks using input/output ports (data flow) and prev/next ports (control flow)
4. Configure block parameters
5. The code will be automatically generated and updated according to the configurations selected or changed (produces pru_syscfg.asm and pru_syscfg.inc)
6. Include generated code in your main.asm by using the label generated
7. Build and deploy to PRU

### Generated Files

| File | Purpose |
|------|---------|
| pru_syscfg.asm | Generated PRU assembly code |
| pru_syscfg.inc | Macro definitions and register aliases |

---

## Block Categories

The PRU No-Code tool provides five categories of blocks:

### Data Handling Blocks

Blocks for loading constants, performing arithmetic, and bitwise operations.

| Block | Purpose | Cycles |
|-------|---------|--------|
| Load Constant | Load immediate values (0-0xFFFFFFFF) | 1-2 |
| Arithmetic | ADD, SUB, ADC, SUC operations | 1 |
| Bitwise | AND, OR, XOR, NOT, LSL, LSR operations | 1 |


### Program Control Blocks

Blocks for controlling execution flow, repetition, and code organization.

| Block | Purpose | Cycles |
|-------|---------|--------|
| Loop | Repeat blocks N times or infinitely | 2-3 (overhead) |
| If/Else | Conditional branching | 1 |
| Group | Organize code into callable sections | 0 |
| Flow Control | End execution or halt PRU | 1 |


### PRU I/O Blocks

Blocks for GPIO, SPI, UART, and memory operations.

| Block | Purpose | Cycles | Max Frequency (200MHz PRU) |
|-------|---------|--------|---------------------------|
| PRU GPI | Read GPIO input pins (R31) | 1 | N/A |
| PRU GPO | Write GPIO output pins (R30) | 1 | N/A |
| SPI Read | Read data via SPI | Variable | Up to 8.33 MHz |
| SPI Write | Write data via SPI | Variable | Up to 25.00 MHz |
| SPI Transfer | Full-duplex SPI | Variable | Up to 7.69 MHz |
| UART config | configure 3 channel interface for UART transmission | Variable | N/A |
| UART TX op | Transmit UART frame (up to 62 data bits) | Variable | Up to 32 Mbaud |
| UART RX op | Receive UART frame (up to 64 bits) | Variable | Up to 32 Mbaud |


### Utility Blocks

Blocks for timing, data storage, and documentation.

| Block | Purpose | Cycles |
|-------|---------|--------|
| Delay | Precise timing delays | 1-255 |
| Lookup Table | Define pre-initialized data tables in DMEM or SMEM | 0 (data only) |
| Access Lookup Table | Read from lookup tables | 5 |
| Memory Variable | Reserve named uninitialized buffer in DMEM or SMEM | 0 (declaration only) |
| Memory Access | Read/write a Memory Variable buffer (LBBO/SBBO) | 3 |
| Label | Documentation notes | 0 |


### Application-Specific Blocks

Blocks implementing ready-to-use embedded algorithms, eliminating the need to write assembly by hand for common protocol-level computations.

| Block | Purpose | Cycles |
|-------|---------|--------|
| CRC | CRC8/16/32 checksum calculation (1 byte per block, table-lookup) | 6 (CRC8), 9 (CRC16/32) |


---

## Core Concepts

### Block Connections

Blocks have two types of connections:

**Data Ports (input/output)**
- Connect output ports to input ports to pass data between blocks
- Data flows from output of one block to input of another
- Registers are automatically allocated for data transfer

**Control Flow Ports (prev/next)**
- Connect prev/next ports to define execution order
- Blocks execute in sequence following prev-to-next connections
- Some blocks have special ports (t_next/f_next for conditionals)

### Data Flow vs Control Flow

- **Data Flow**: Determined by input/output port connections. A block's inputs must be available before it executes.
- **Control Flow**: Determined by prev/next port connections. Defines the sequential order of block execution.

### Register Allocation

The tool automatically manages PRU registers:

- **Dynamic Allocation**: Registers R0-R27 are allocated as needed
- **Automatic Sizing**: Register sub-fields (byte, word) selected based on data size
- **Reserved Registers**:
  - R28 (TEMP_REG1): Temporary register for complex operations
  - R29 (TEMP_REG2): Secondary temporary register
  - R30: Output register (GPO)
  - R31: Input register (GPI)

### Output Sizes

Each block that produces data has an output size configuration:

| Size | Bytes | Register Notation | Value Range |
|------|-------|-------------------|-------------|
| 1 byte | 1 | Rx.b0, Rx.b1, etc. | 0-255 |
| 2 bytes | 2 | Rx.w0, Rx.w2 | 0-65,535 |
| 4 bytes | 4 | Rx | 0-4,294,967,295 |

---

## Integration with main.asm

### Basic Integration

Include the generated files and call the generated code from your main.asm:

```assembly
; main.asm
    .include "pru_syscfg.inc"      ; Include macro definitions
    .ref sysconfig_generated_start ; Reference generated code entry
    .global sysconfig_generated_end   ; Reference generated code exit

    .text
    .global main
main:
    ; Your initialization code here...

    ; Call generated SysConfig code
    JMP sysconfig_generated_start

    ; Execution continues here after generated code completes
    ; (if using JMP sysconfig_generated_end at the end)

done:
    HALT
```

### Using Group Blocks

For modular code organization, use Group blocks and call them selectively:

```assembly
; main.asm
    .include "pru_syscfg.inc"
    .ref sysconfig_generated_start
    .ref sensor_init_start         ; Reference a Group named "sensor_init"
    .ref data_process_start        ; Reference a Group named "data_process"

    .text
    .global main
main:
    ; Run initialization (ungrouped blocks)
    JMP sysconfig_generated_start

after_init:
    ; Call sensor initialization group
    CALL sensor_init_start
    ; Execution returns here automatically

main_loop:
    ; Call data processing group in a loop
    CALL data_process_start
    ; Execution returns here

    JMP main_loop

done:
    HALT
```

### Labels Reference

| Label | Purpose |
|-------|---------|
| sysconfig_generated_start | Entry point for ungrouped blocks |
| sysconfig_generated_end | Exit point for ungrouped blocks |
| <groupName>_start | Entry point for a Group block |
| <blockName>_start | Entry point for any individual block — addressable by a [Flow Control block](docs/program-control/flow_control_block.md) to (re-)run that block |
| <blockName>_end | Exit point for any ordinary block (position right after that block's own instruction) |
| <LoopName>_end | Dedicated early-exit target for a Loop block — jump here from inside the loop's body to break out before its counter/condition finishes naturally |

If/Else (Conditional) blocks only expose `<blockName>_start` — they have two forward addresses (`_TRUE`/`_FALSE`), not a single "end". Every one of these labels appears directly in a [Flow Control block](docs/program-control/flow_control_block.md)'s "Jump To" dropdown — no manual label-name entry required.

---

## Simulation

The PRU No-Code tool includes a simulation feature to verify your design before deployment.

### Using Simulation

1. Configure simulation settings (cycles to simulate)
2. Set input values for GPI and other input blocks
3. Run simulation
4. View output values and cycle counts

### What Simulation Shows

- **Data Values**: Actual values flowing through each block
- **Cycle Counts**: Exact PRU cycles consumed by each block
- **Peak Cycles**: Maximum cycles in any execution path
- **Register Usage**: Which registers are allocated to which blocks

---

## Views and Summaries

The PRU No-Code tool provides helpful summary views to understand your design:

### Register Allocation Summary

Shows which PRU registers (R0-R27) are allocated to each block's output ( also included in the generated pru_syscfg.asm file ). This helps you:
- Understand register usage across your design
- Identify which registers are available for custom code
- Debug data flow issues

### Pin Usage Summary

Displays PRU pin assignments in a pin-centric format:

```
PIN | USED BY
GPO2 | SPI_Write_0 (SDO)
GPO6 | SPI_Write_0 (CS), SPI_Read_0 (CS)
GPO11 | SPI_Write_0 (SCLK), SPI_Read_0 (SCLK)
GPI1 | SPI_Read_0 (SDI)
```

This format makes it easy to:
- Identify pin conflicts at a glance
- See which blocks share pins
- Understand pin utilization across the design
- Verify pinmux requirements

Pins are sorted by direction (GPO pins first, then GPI pins) and by pin number in ascending order.

### Simulation Limitations

- Simulation runs in JavaScript, not actual PRU hardware
- External hardware interactions are simulated with test values
- Simulation currently does not support UART block  
- Timing is calculated, not measured

---

## Best Practices

### Design Patterns

1. **Initialize First**: Place configuration blocks before main logic
2. **Use Groups**: Organize related functionality into Group blocks for modularity
3. **Pre-Initialize Accumulators**: Use Loop block's Pre-Initialization feature for counters and accumulators

### Performance Optimization

1. **Minimize Loop Body**: Every cycle inside a loop multiplies by iteration count
2. **Use Hardware Loops**: The Loop block uses PRU's hardware LOOP instruction for efficiency
3. **Batch Memory Operations**: Combine multiple reads/writes when possible
4. **Choose Appropriate Data Sizes**: Use 1-byte operations when 8 bits suffice

### Memory Management

1. **PRU DMEM**: 8 KB per PRU core - use for lookup tables, Memory Variable buffers, and local data accessed by a single PRU
2. **SMEM (Shared RAM)**: 64 KB shared between all PRU cores and ARM - use for inter-core communication or when multiple PRUs share the same lookup table or buffer
3. **Memory Variable + Memory Access**: Use this block pair for runtime read/write of named buffers; choose DMEM for speed, SMEM for sharing
4. **Lookup Table memory**: Choose DMEM for single-PRU tables; choose SMEM when multiple PRUs need the same pre-initialized table

### Timing Considerations

1. **Check Cycle Counts**: Each block shows its cycle count - use for timing calculations
2. **Use Delay Blocks**: For precise timing delays (1-255 cycles per block)
3. **Account for Loop Overhead**: Loops add 2-3 cycles overhead plus per-iteration cost
4. **Verify with Simulation**: Use simulation to confirm total cycle counts

---

## Technical Reference

### PRU Architecture Overview

The PRU is a 32-bit processor optimized for real-time control:

- **Registers**: 32 general-purpose 32-bit registers (R0-R31)
- **Memory**: 8 KB instruction RAM, 8 KB data RAM per PRU core
- **Shared Memory**: 64 KB shared RAM between PRU cores
- **Constant Tables**: 32 constant table registers for efficient memory addressing

### PRU Clock Timing

At 200 MHz PRU clock:

| Cycles | Time |
|--------|------|
| 1 | 5 ns |
| 10 | 50 ns |
| 100 | 500 ns |
| 200 | 1 µs |
| 1000 | 5 µs |
| 200,000 | 1 ms |

### Generated Code Structure

The tool generates two files:

**pru_syscfg.asm** contains:
- Global label declarations
- Register aliases
- Generated block code
- Group subroutines (if any)

**pru_syscfg.inc** contains:
- Macro definitions for complex operations
- Register name definitions (TEMP_REG1, TEMP_REG2, RET_ADDR0)
- Constant definitions

---

### Getting Help

- Check block-specific READMEs for details 
- Review generated assembly code for unexpected instructions
- Use simulation to trace data flow issues
- Use AI chatbot's help for issues or code explanation 

---

## Glossary

| Term | Definition |
|------|------------|
| **Block** | Visual programming element that generates PRU instructions |
| **CRC** | Cyclic Redundancy Check — error-detecting checksum computed from data using a generator polynomial |
| **DMEM** | PRU Data Memory — 8 KB local RAM per PRU core, fast private access |
| **SMEM** | Shared Memory — 64 KB RAM shared between all PRU cores and ARM |
| **GPI** | General Purpose Input (R31) |
| **GPO** | General Purpose Output (R30) |
| **LBBO** | Load Byte Burst from Offset — PRU instruction used by Memory Access block to read from memory |
| **SBBO** | Store Byte Burst to Offset — PRU instruction used by Memory Access block to write to memory |
| **Memory Variable** | Block that reserves a named uninitialized buffer in DMEM or SMEM via `.usect` directive |
| **Memory Access** | Block that reads (LBBO) or writes (SBBO) a buffer declared by a Memory Variable block |
| **PRU** | Programmable Real-Time Unit |
| **PRU-ICSS** | PRU Industrial Communication Subsystem |
| **Register Allocation** | Automatic assignment of PRU registers to block outputs |
| **SysConfig** | TI configuration tool that hosts PRU No-Code |

