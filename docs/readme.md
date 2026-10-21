# Data Handling Blocks

## Overview

Data Handling blocks are fundamental building blocks in the PRU No-Code tool that enable manipulation and processing of data values. These blocks perform mathematical operations, bitwise logic, and constant value loading - essential operations for any data processing application.

All Data Handling blocks share common characteristics:
- **Single-cycle execution**: Most operations complete in just 1 PRU cycle (5ns assuming the PRU frequency is set at 200MHz)
- **Dynamic register allocation**: Registers are automatically allocated by the register allocator 
- **Flexible data sizing**: Support for 1, 2, or 4 byte data widths
- **Chainable outputs**: Results can be passed to subsequent blocks for further processing

---

## Available Blocks

| Block | Purpose | Inputs | Output | Cycles |
|-------|---------|--------|--------|--------|
| [Load Constant](./data-handling/load_constant_block.md) | Load immediate values | 0 | 1 | 1-2 |
| [Arithmetic](./data-handling/arithmetic_block.md) | Math operations (ADD, SUB) | 2 | 1 | 1 |
| [Bitwise](./data-handling/bitwise_block.md) | Bit manipulation (AND, OR, XOR, shifts) | 1-2 | 1 | 1 |
| [Hardware MAC](./data-handling/mac_hw_block.md) | Multiply-accumulate mathematical operations | 3 | 1 | 9 |
| [IQMath PID](./data-handling/iqmath_pid_block.md) | Closed-loop PID control feedback compensation | 2 | 1 | 50 |
| [IQMath Park/Clarke](./data-handling/iqmath_park_clarke_block.md) | 3-phase frame coordinate vector transformations | 4 | 2 | 97 |

---

# Program Control Blocks

## Overview

Program Control blocks manage the execution flow of PRU No-Code applications. These blocks enable repetition (loops), conditional branching (if/else), code organization (groups), flow termination, and memory configuration - essential constructs for building structured PRU programs.

The program control blocks include:
- **Loop Block**: Repeats a sequence of blocks multiple times
- **If/Else Block**: Conditional branching based on value comparisons
- **Group Block**: Organizes blocks into named, callable sections
- **Flow Control Block**: Terminates execution (jump to end or halt)

---

## Available Blocks

| Block | Purpose | Inputs | Outputs | Cycles |
|-------|---------|--------|---------|--------|
| [Loop](./program-control/loop_block.md) | Repeat blocks N times or infinitely | 0 | 0 | 2-3 |
| [If/Else](./program-control/conditional_block.md) | Conditional branching | 2 | 0 | 1 |
| [Group](./program-control/group_block.md) | Code organization container | 0 | 0 | 0 |
| [Flow Control](./program-control/flow_control_block.md) | End execution or halt PRU | 0 | 0 | 1 |

---

# PRU I/O Blocks

## Overview

PRU I/O blocks provide direct hardware interaction capabilities for the PRU subsystem. These blocks handle digital input/output operations, serial communication protocols (SPI, UART), and memory access through constant table addressing.

The blocks in this category enable:
- **GPIO Control**: Direct pin-level control via R30/R31 registers
- **SPI Communication**: Bit-banged SPI in Controller and Peripheral modes
- **UART Communication**: Hardware-accelerated UART via ENDAT peripheral
- **Memory Access**: Efficient bulk memory operations using LBCO/SBCO instructions

---

## Available Blocks

| Block | Purpose | Inputs | Outputs | Cycles |
|-------|---------|--------|---------|--------|
| [PRU GPI](./input-output/pru_gpi_block.md) | Read digital input pin | 0 | 1 | 1 |
| [PRU GPO](./input-output/pru_gpo_block.md) | Set/Clear digital output pin | 0 | 0 | 1 |
| [SPI Read](./input-output/serial-protocol-emulation/pru_spi_read_block.md) | Receive data via SPI | 0 | 1 | Variable |
| [SPI Write](./input-output/serial-protocol-emulation/pru_spi_write_block.md) | Transmit data via SPI | 1 | 0 | Variable |
| [SPI Transfer](./input-output/serial-protocol-emulation/pru_spi_transfer_block.md) | Full-duplex SPI communication | 1 | 1 | Variable |
| [UART TX](./input-output/serial-protocol-emulation/uart_tx_block.md) | Transmit UART frame | 1 | 0 | ~50-100 |
| [UART RX](./input-output/serial-protocol-emulation/uart_rx_block.md) | Receive UART frame | 0 | 1 | ~50-100 |
| [SDFM](./input-output/sdfm_block.md) | Interface with Sigma-Delta Filter Module | 0 | 1 | Variable |
| [BiSS-C Initiator](./input-output/biss_c_initiator_block.md) | Shift a BiSS-C encoder frame into a register | 0 | 1 | Variable |

---

# Utility Blocks

## Overview

Utility blocks provide supporting functionality for PRU No-Code applications. These blocks handle timing control, data storage, memory access, and documentation - essential utilities that complement the core data handling and I/O blocks.

The utility blocks include:
- **Delay Block**: Precise timing delays
- **Lookup Table Block**: Data storage in PRU memory
- **Access Lookup Table Block**: Reading data from lookup tables
- **Label Block**: Documentation and notes in the visual interface

---

## Available Blocks

| Block | Purpose | Inputs | Output | Cycles |
|-------|---------|--------|--------|--------|
| [Delay](./utils/delay_block.md) | Timing delays | 0 | 0 | 1-255 |
| [Lookup Table](./utils/look_up_table_block.md) | Define data tables in DMEM | 0 | 0 | 0 (data only) |
| [Access Lookup Table](./utils/access_look_up_table_block.md) | Read from lookup tables | 1 (index) | 1 (data) | 5 |
| [Label](./utils/label_block.md) | Visual documentation | 0 | 0 | 0 |

---

# Application Specific Blocks

## Overview

Application Specific blocks provide ready-made implementations of common algorithms used in embedded and industrial communication systems. These blocks encapsulate complex operations behind a simple interface, letting users drop in proven algorithm implementations without writing assembly.

Currently available:
- **CRC Block**: Table-driven Cyclic Redundancy Check for error detection
- **IPC Shared Memory Block**: Store a value in a variable the host or another core can read

---

## Available Blocks

| Block | Purpose | Inputs | Output | Cycles |
|-------|---------|--------|--------|--------|
| [CRC](./application-specific/crc_block.md) | Cyclic Redundancy Check (CRC8/16/32) | 2 (init, data) | 1 (result) | 6–9 |
| [IPC Shared Memory](./application-specific/ipc_shared_mem_block.md) | Store a value in a variable the host can read | 1 | 0 | 4 |

---

# Simulation and Testing

## Overview

The PRU No-Code tool includes a cycle-accurate simulator environment that allows verifying and debugging code without physical hardware.

The simulation guides include:
- [Using the Simulator](./simulation/using-the-simulator.md): Detailed usage guide for GUI and CLI simulator environments.
- [Simulation Settings](./simulation/simulation_settings.md): Reference guide for setting up and configuring simulation runs.
