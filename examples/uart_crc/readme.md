# UART CRC

## Introduction

This example demonstrates the use of pru-no-code-tool for sending a data byte and its crc through a UART frame from PRU0 and its reception on PRU1 and then checking the recieved CRC with the calculated CRC of the data recieved to check if the data byte was transmitted correctly 

The data and its CRC are transmitted in a single UART frame whose snapshot from the logic analyzer is attached below :

<figure>
<img src="images/uart_crc_ss.png" alt="uart_crc" width="900">
<figcaption>The data and its CRC is transmitted in a single frame (start bit 1 and stop bit 0) , white signal -> data+CRC, brown -> tx enable, red -> clock</figcaption>
</figure>

---

## No-Code Tool Block Design

The entire TX pipeline (data store, CRC compute, CRC store, peripheral config, transmit) on PRU0 and the RX pipeline (receive, data extract, CRC recompute) on PRU1 are implemented using no-code blocks. No hand-written assembly handles the protocol logic — only the final SMEM write and CRC comparison at the end of `main.asm` are manual.

The TX side uses the **UART Config + UART TX Op** block pair. The UART Config block handles one-time peripheral setup (baud rate, frame size, bit order), and the UART TX Op block handles the per-transmission work (frame construction, FIFO load, start trigger, wait for completion). This separation means the peripheral only needs to be configured once even if multiple TX operations were needed.

### PRU0 — Transmitter Block Flow

```
[Load Constant: Load_Constant_0]   value = 0xAA (data byte)
        │
        ▼
[Memory Write: Memory_Access_0]    write 1 byte → buffer[0]   (stores data byte in PRU DMEM)
        │
        ▼
[Memory Read:  Memory_Access_1]    read  1 byte ← buffer[0]   (feeds data byte into CRC block)
        │                                    ▲
        │            [Load Constant: Load_Constant_1]  value = 0 (CRC init value)
        │                                    │
        ▼                                    │
[CRC: CRC_0]   polynomial = 0x07 (CRC-8-ATM), input2 = data byte, input1 = init 0
        │
        ▼
[Memory Write: Memory_Access_2]    write 1 byte → buffer[1]   (stores computed CRC)
        │
        ▼
[Memory Read:  Memory_Access_3]    read  2 bytes ← buffer[0]  (reads data+CRC as a 16-bit word)
        │
        ▼
[UART Config: PRU_UART_CONFIG_0]   configure peripheral (baud rate, frame size, bit order)
        │
        ▼
[UART TX Op: PRU_UART_TX_OP_0]     transmit 16-bit frame (data byte in low byte, CRC in high byte)
        │
        ▼
[Flow Control: Flow_Control_0]     HALT
```

### PRU1 — Receiver Block Flow

```
[UART Config: PRU_UART_CONFIG_0]   configure peripheral (baud rate, oversample, frame size, bit order)
        │
        ▼
[UART RX Op: PRU_UART_RX_OP_0]    receive 18-bit frame (start + 16 data bits + stop)
        │
        ▼
[Memory Write: Memory_Access_0]    write 2 bytes → buffer[0]  (stores raw received frame: data at [0], received CRC at [1])
        │
        ▼
[Memory Read:  Memory_Access_1]    read  1 byte ← buffer[0]   (extracts received data byte)
        │                                    ▲
        │            [Load Constant: Load_Constant_0]  value = 0 (CRC init value)
        │                                    │
        ▼                                    │
[CRC: CRC_0]   polynomial = 0x07, input2 = received data byte, input1 = init 0
        │
        ▼
[Flow Control: Flow_Control_0]     HALT  (CRC result in register, passed to main.asm for comparison)
```

### Block Configuration Details

**PRU0 Blocks**

**Memory Variable (`Memory_Variable_0`)**
- Size: 2 bytes, location: PRU DMEM
- Shared by all four Memory Access blocks as the named buffer `buffer`
- Layout: `buffer[0]` = data byte, `buffer[1]` = CRC byte

**Load Constant (`Load_Constant_0`)**
- Value: 170 (0xAA) — the data byte to be transmitted

**Memory Access (`Memory_Access_0`)**
- Operation: write, offset: 0x00, size: 1 byte
- Writes 0xAA to `buffer[0]` in PRU DMEM

**Memory Access (`Memory_Access_1`)**
- Operation: read, offset: 0x00, size: 1 byte
- Reads `buffer[0]` back as the data input to the CRC block

**Load Constant (`Load_Constant_1`)**
- Value: 0 — CRC initialisation value (no chaining, fresh CRC per frame)

**CRC (`CRC_0`)**
- Polynomial: 0x07 (CRC-8-ATM / CCITT)
- input1: CRC init value (0) from `Load_Constant_1`
- input2: data byte from `Memory_Access_1`
- Computes an 8-bit CRC over the single data byte

**Memory Access (`Memory_Access_2`)**
- Operation: write, offset: 0x01, size: 1 byte
- Writes the CRC result to `buffer[1]` — now `buffer` holds `[data | CRC]`

**Memory Access (`Memory_Access_3`)**
- Operation: read, offset: 0x00, size: 2 bytes
- Reads the full 2-byte `[data | CRC]` word to feed the UART TX Op block

**UART Config (`PRU_UART_CONFIG_0`)**
- TX only (RX disabled)
- Configures the ENDAT peripheral: baud rate, frame size, bit order, start/stop polarity
- Runs once before the TX Op — handles GPCFG, TXCFG, and CH_CFG0 register writes including `TX_FIFO_SWAP_BITS` for bit order

**UART TX Op (`PRU_UART_TX_OP_0`)**
- Data bits: 16
- Reads configuration from the paired `PRU_UART_CONFIG_0` block automatically
- Handles per-transmission work only: frame construction, FIFO load, start trigger, wait for TX complete
- Transmits `buffer[0:1]` as a single 16-bit UART frame (data in bits [7:0], CRC in bits [15:8])

---

**PRU1 Blocks**

**Memory Variable (`Memory_Variable_0`)**
- Size: 4 bytes, location: PRU DMEM
- Shared by both Memory Access blocks as the named buffer `buffer`
- Layout: `buffer[0]` = received data byte, `buffer[1]` = received CRC byte

**UART Config (`PRU_UART_CONFIG_0`)**
- RX only (TX disabled)
- Configures the ENDAT peripheral for reception: baud rate, oversample size, RX frame size, start bit polarity
- Runs once before the RX Op

**UART RX Op (`PRU_UART_RX_OP_0`)**
- Frame size: 18 bits (start bit + 16 data bits + stop bit)
- Reads configuration from the paired `PRU_UART_CONFIG_0` block automatically
- Receives the full frame transmitted by PRU0 and outputs the 16-bit payload

**Memory Access (`Memory_Access_0`)**
- Operation: write, offset: 0x00, size: 2 bytes
- Stores the received 16-bit payload into `buffer[0:1]` (received data at [0], received CRC at [1])

**Memory Access (`Memory_Access_1`)**
- Operation: read, offset: 0x00, size: 1 byte
- Reads `buffer[0]` — the received data byte — to pass to the CRC block for recomputation

**Load Constant (`Load_Constant_0`)**
- Value: 0 — CRC init value

**CRC (`CRC_0`)**
- Polynomial: 0x07 (same as PRU0)
- Recomputes the CRC over the received data byte
- Result is compared against the received CRC in `main.asm` to validate integrity

---

### Shared Memory Layout and CRC Validation (main.asm)

After both PRUs halt, `main.asm` writes results to SMEM (`0x30010000` on AM243x) and performs the comparison:

```
SMEM offset | Content
------------|--------------------------------------------
0x00        | RX calculated CRC  (PRU1 recomputed CRC)
0x01        | TX received CRC    (CRC extracted from the received frame)
0x02        | Match flag: 0x01 = CRC match, 0xFF = CRC mismatch
0x03        | Raw received data byte (from RX frame)
0x04        | Original TX data byte  (0xAA, written by PRU0)
```

The R5F reads these SMEM locations and prints the result over UART:

```
CRC MATCH   → "Data=0xAA  TX_CRC=0xXX  RX_CRC=0xXX  Status: PASS"
CRC MISMATCH→ "Data=0xAA  TX_CRC=0xXX  RX_CRC=0xXX  Status: FAIL"
```

---

# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSG          | ICSSG0 - PRU0, PRU1
 ICSSM          | ICSSM1 - PRU0, PRU1 (am261x only)
 Toolchain      | pru-cgt
 Board          | am243x-lp, am261x-lp
 Example folder | examples/uart_crc/

# Steps to Run the Example

> Prerequisite: [PRU-CGT-2-3](https://www.ti.com/tool/PRU-CGT) (ti-pru-cgt) should be installed at: `C:/ti/`

- **When using CCS projects to build**, import the CCS project from the above mentioned Example folder path for R5F and PRU, After this `main.asm`, `linker.cmd` files gets copied to ccs workspace of PRU project. The `main.asm` contains sample code to halt PRU program

     - Build the PRU project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Build Flow: Once you click on build in PRU project, firmware header file which is generated in release or debug folder of ccs workspace, is moved to  `<pru-no-code-tool/examples/empty/firmware/device/>`

     - Build the R5F project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Firmware header file path is included in R5F project include options by default, Instructions in Firmware header file can be written into PRU IRAM memory using PRUICSS_loadFirmware API (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe))
          - Build Flow: Once you click on build in R5F project, SysConfig files are generated, Finally the R5F project will be generated using both the generated SysConfig and PRU project binaries.

     - Launch a CCS debug session and run the executable, (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_LAUNCH_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_LAUNCH_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_LAUNCH_PAGE.html))

     - Connect on the 243x-lp board the following pins with a wire -> PRG0_PRU1_GPI11 (J7.10 , pin number 70) which is the PERIF2_IN (for UART rx) to PRG0_PRU0_GPO1 (J4.2, pin number 32) which is the PERIF0_OUT (for UART tx) , the data and its CRC flows from tx to rx. For the am261x-lp board connect the following pins -> PR1_PRU0_GPIO1 (J7.67) which is the PERIF0_OUT (for UART tx) to  PR1_PRU1_GPIO11 (J1.8) which is the PERIF2_IN (for UART rx)
