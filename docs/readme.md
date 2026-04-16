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
| Load Constant | Load immediate values | 0 | 1 | 1-2 |
| Arithmetic | Math operations (ADD, SUB) | 2 | 1 | 1 |
| Bitwise | Bit manipulation (AND, OR, XOR, shifts) | 1-2 | 1 | 1 |

---

# Program Control Blocks

## Overview

Program Control blocks manage the execution flow of PRU No-Code applications. These blocks enable repetition (loops), conditional branching (if/else), code organization (groups), flow termination, and memory configuration - essential constructs for building structured PRU programs.

The program control blocks include:
- **Loop Block**: Repeats a sequence of blocks multiple times
- **If/Else Block**: Conditional branching based on value comparisons
- **Group Block**: Organizes blocks into named, callable sections
- **Flow Control Block**: Terminates execution (jump to end or halt)
- **Configure Constant Table Block**: Configures PRU constant table registers

---

## Available Blocks

| Block | Purpose | Inputs | Outputs | Cycles |
|-------|---------|--------|---------|--------|
| Loop | Repeat blocks N times or infinitely | 0 | 0 | 2-3 |
| If/Else | Conditional branching | 2 | 0 | 1 |
| Group | Code organization container | 0 | 0 | 0 |
| Flow Control | End execution or halt PRU | 0 | 0 | 1 |
| Configure Constant Table | Setup constant table pointers | 0 | 0 | 2 |

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
| PRU GPI | Read digital input pin | 0 | 1 | 1 |
| PRU GPO | Set/Clear digital output pin | 0 | 0 | 1 |
| SPI Read | Receive data via SPI | 0 | 1 | Variable |
| SPI Write | Transmit data via SPI | 1 | 0 | Variable |
| SPI Transfer | Full-duplex SPI communication | 1 | 1 | Variable |
| UART TX | Transmit UART frame | 1 | 0 | ~50-100 |
| UART RX | Receive UART frame | 0 | 1 | ~50-100 |
| PRU LBCO | Load data from memory | 0-2 | 1 | 1 (+memory) |
| PRU SBCO | Store data to memory | 1-3 | 0 | 1 (+memory) |

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
| Delay | Timing delays | 0 | 0 | 1-255 |
| Lookup Table | Define data tables in DMEM | 0 | 0 | 0 (data only) |
| Access Lookup Table | Read from lookup tables | 1 (index) | 1 (data) | 5 |
| Label | Visual documentation | 0 | 0 | 0 |

---

# Application Specific Blocks

## Overview

Application Specific blocks provide ready-made implementations of common algorithms used in embedded and industrial communication systems. These blocks encapsulate complex operations behind a simple interface, letting users drop in proven algorithm implementations without writing assembly.

Currently available:
- **CRC Block**: Table-driven Cyclic Redundancy Check for error detection

---

## Available Blocks

| Block | Purpose | Inputs | Output | Cycles |
|-------|---------|--------|--------|--------|
| CRC | Cyclic Redundancy Check (CRC8/16/32) | 2 (init, data) | 1 (result) | 6–9 |

---