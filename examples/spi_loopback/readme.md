# SPI Loopback

## Introduction

This example demonstrates the use of pru-no-code-tool for SPI loopback, the code sends 32 bits of data from PRU0 to PRU1 through SPI protocol, PRU0 acts as controller (master) and PRU1 acts as preipheral (slave) in this example 
---

## No-Code Tool Block Design

This is one of the simplest no-code designs: PRU0 needs just three blocks to drive a full 32-bit SPI transaction, and PRU1 needs only two. No memory buffers, no CRC, no branching.

### PRU0 — SPI Controller Block Flow

```
[Load Constant: Load_Constant_0]   value = 0xABCD1234 (32-bit data to transmit)
        │
        ▼
[SPI Write: PRU_SPI_Write_0]       transmit 32 bits, controller mode
        │                          SCLK high = 12 PRU cycles, low = 10 PRU cycles
        │                          SDO → GPO3, SCLK → GPO4, CS → GPO5
        ▼
[Flow Control: Flow_Control_0]     HALT
```

### PRU1 — SPI Peripheral Block Flow

```
[SPI Read: PRU_SPI_Read_0]         receive 32 bits, peripheral mode
        │                          waits for CS assert from PRU0, then clocks in data
        │                          CS ← GPI6, SCLK ← GPI11
        ▼
[Flow Control: Flow_Control_0]     HALT  (received word available in output register)
```

### Block Configuration Details

**PRU0 Blocks**

**Load Constant (`Load_Constant_0`)**
- Value: 2882382797 (0xABCD1234) — the 32-bit test pattern to send over SPI

**SPI Write (`PRU_SPI_Write_0`)**
- Packet size: 32 bits
- Device mode: controller (drives SCLK and CS)
- SCLK high pulse width: 12 PRU cycles (60 ns at 200 MHz)
- SCLK low pulse width: 10 PRU cycles (50 ns at 200 MHz)
- SDO signal: GPO3 (`PRG0_PRU0_GPO3`) — data out to peripheral
- SCLK signal: GPO4 (`PRG0_PRU0_GPO4`) — clock to peripheral
- CS signal: GPO5 (`PRG0_PRU0_GPO5`) — chip select to peripheral

**Flow Control (`Flow_Control_0`)**
- Operation: HALT — stops PRU0 after the single SPI transaction

---

**PRU1 Blocks**

**SPI Read (`PRU_SPI_Read_0`)**
- Packet size: 32 bits
- Device mode: peripheral (waits for CS and SCLK from controller)
- SCLK high pulse width: 12 PRU cycles, low: 10 PRU cycles (must match PRU0)
- CS signal: GPI6 (`PRG0_PRU1_GPO6`) — chip select from controller
- SCLK signal: GPI11 (`PRG0_PRU1_GPO11`) — clock from controller
- Received word is left in the output register for the R5F to read from SMEM

**Flow Control (`Flow_Control_0`)**
- Operation: HALT — stops PRU1 after the single SPI receive

---

### Pin Connections Summary

PRU0 (controller) drives three signals; PRU1 (peripheral) receives them. The wires that must be connected on the board are:

| Signal | PRU0 pin (controller) | PRU1 pin (peripheral) |
|--------|-----------------------|----------------------|
| SDO→SDI | GPO3 / J2.2 | GPO1 / J7.7 |
| CS | GPO5 / J2.8 | GPO6 / J7.9 |
| SCLK | GPO4 / J2.4 | GPO11 / J7.10 |

The PRU1 SDO→PRU0 SDI path exists in hardware but is unused here since this is a write-only loopback test.

---

# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSG          | ICSSG0 - PRU0, PRU1
 ICSSM          | ICSSM1 - PRU0, PRU1 (am261x only)
 Toolchain      | pru-cgt
 Board          | am243x-lp, am261x-lp
 Example folder | examples/spi_loopback/

# Steps to Run the Example

> Prerequisite: [PRU-CGT-2-3](https://www.ti.com/tool/PRU-CGT) (ti-pru-cgt) should be installed at: `C:/ti/`

- **When using CCS projects to build**, import the CCS project from the above mentioned Example folder path for R5F and PRU, After this `main.asm`, `linker.cmd` files gets copied to ccs workspace of PRU project. The `main.asm` contains sample code to halt PRU program

     - Build the PRU project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Build Flow: Once you click on build in PRU project, firmware header file which is generated in release or debug folder of ccs workspace, is moved to  `<pru-no-code-tool/examples/spi_loopback/firmware/device/>`

     - Build the R5F project using the CCS project menu (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_PROJECTS_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_PROJECTS_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Firmware header file path is included in R5F project include options by default, Instructions in Firmware header file can be written into PRU IRAM memory using PRUICSS_loadFirmware API (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/group__DRV__PRUICSS__MODULE.html#ga3e7c763e5343fe98f7011f388a0b7ffe))
          - Build Flow: Once you click on build in R5F project, SysConfig files are generated, Finally the R5F project will be generated using both the generated SysConfig and PRU project binaries.

     - Launch a CCS debug session and run the executable, (see [for AM64x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM64X/latest/exports/docs/api_guide_am64x/CCS_LAUNCH_PAGE.html), [for AM243x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM243X/latest/exports/docs/api_guide_am243x/CCS_LAUNCH_PAGE.html), [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_LAUNCH_PAGE.html))

     - Connect the SPI master and slave pins as per configuration. In the example for am243x these pins are mapped as shown below:
     <table>
     <tr>
     <th colspan="4">Slave
     <th colspan="4">Master
     </tr> 
     <tr>
     <th>Pin
     <th>SOC Pad name
     <th>PRU Signal name
     <th>Signal
     <th>Signal
     <th>PRU Signal name
     <th>SOC Pad name
     <th>Pin
     </tr> 
     <tr>
     <td>J7.7 (pin 67)
     <td>GPIO1_21
     <td>PRG0_PRU1_GPO1
     <td>SDI
     <td>SDO
     <td>PRG0_PRU0_GPO3
     <td>GPIO1_3
     <td>J2.2 (pin 19)
     </tr>
     <tr>
     <td>J7.8 (pin 68)
     <td>GPIO1_22
     <td>PRG0_PRU1_GPO2
     <td>SDO
     <td>SDI
     <td>PRG0_PRU0_GPO14
     <td>SPI3_D1
     <td>J2.7 (pin 14)
     </tr>
     <tr>
     <td>J7.9 (pin 69)
     <td>GPIO1_26
     <td>PRG0_PRU1_GPO6
     <td>CS
     <td>CS
     <td>PRG0_PRU0_GPO5
     <td>GPIO1_5
     <td>J2.8 (pin 13)
     </tr>
     <tr>
     <td>J7.10 (pin 70)
     <td>GPIO1_31
     <td>PRG0_PRU1_GPO11
     <td>SCLK
     <td>SCLK
     <td>PRG0_PRU0_GPO4
     <td>GPIO1_4
     <td>J2.4 (pin 17)
     </tr>
     </table>
     

- **When using makefiles to build**:
     - For steps on how to use makefiles, run `make help` from the root folder
       of the pru-no-code-tool repository.

