# SPI Transfer at 10MHz

## Introduction

This example demonstrates replicating the input (GPI) signals and producing the same waveform on the output (GPO) pins

<figure>
<img src="images/mirror_input.png" alt="mirror_input" width="900">
<figcaption>In the figure, yellow signal represent the input signal and the red signal represents the output waveform produced</figcaption>
</figure>

## No-Code Tool Block Design

This example uses two PRU cores running concurrently inside ICSSM1. The core demonstration is on **PRU0** — it reads an input signal on a GPI pin and mirrors it in real time onto a GPO pin using the No-Code Tool blocks. PRU1 is a helper that simply generates a repeating signal and feeds it as input to PRU0, so there is something to mirror.

**PRU1 — Signal Generator (helper only)**

PRU1 continuously produces a square wave on GPO bit 4 using an infinite Loop block:
- SET GPO bit 4 → wait 40 cycles → CLR GPO bit 4 → wait 20 cycles → repeat

No inputs are needed. The block design is a single infinite Loop containing four alternating GPO (SET/CLR) and Delay blocks, with Flow Control jumping back to the loop start.

**PRU0 — Input Mirror (main example)**

PRU0 reads GPI bit 0 (connected to PRU1's GPO bit 4 output) and reproduces the same signal on GPO bit 1 using an If/Else block inside an infinite Loop:

1. **PRU_GPI** — read R31 bit 0 into a register
2. **Load_Constant** — load the value 0 into a second register
3. **If/Else** — compare GPI reading to 0:
   - **FALSE branch** (input is non-zero / HIGH): SET GPO bit 1 → Flow Control jumps back to loop start
   - **TRUE branch** (input is zero / LOW): CLR GPO bit 1 → Flow Control jumps back to loop start

Both Flow Control blocks jump to `Loop_0_start` so the loop keeps iterating on every cycle regardless of which branch was taken.

**Generated Assembly (PRU0)**

```asm
startloop_0:
    AND R0.b0, R31, 1 << 0      ; read GPI bit 0
    LDI R0.b1, 0                 ; constant 0
    QBEQ If_Else_0_TRUE, R0.b1, R0.b0  ; branch if input == 0 (LOW)
    SET R30, R30, 1              ; FALSE: input HIGH → set GPO bit 1
    JMP startloop_0
If_Else_0_TRUE:
    CLR R30, R30, 1              ; TRUE: input LOW → clear GPO bit 1
    JMP startloop_0
```

# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSM          | ICSSM1 - PRU0, PRU1 (am261x only)
 Toolchain      | pru-cgt
 Board          | am261x-lp
 Example folder | examples/mirror_input/

# Steps to Run the Example

> Prerequisite: [PRU-CGT-2-3](https://www.ti.com/tool/PRU-CGT) (ti-pru-cgt) should be installed at: `C:/ti/`

- **When using CCS projects to build**, import the CCS project from the above mentioned Example folder path for R5F and PRU. After this `main.asm`, `linker.cmd` files get copied to the CCS workspace of the PRU project. The `main.asm` contains sample code to halt the PRU program.

     - Build the PRU project using the CCS project menu (see [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - Build Flow: Once you click on build in PRU project, the firmware header file generated in the release or debug folder of the CCS workspace is moved to `<pru-no-code-tool/examples/mirror_input/firmware/device/>`

     - Build the R5F project using the CCS project menu (see [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_PROJECTS_PAGE.html)).
          - The firmware header file path is included in R5F project include options by default. Instructions in the firmware header file can be written into PRU IRAM memory using the PRUICSS_loadFirmware API.

     - Launch a CCS debug session and run the executable (see [for AM261x](https://software-dl.ti.com/mcu-plus-sdk/esd/AM261X/latest/exports/docs/api_guide_am261x/CCS_LAUNCH_PAGE.html)).

     - Connect the SPI controller and peripheral pins as per the pin connections table above.

- **When using makefiles to build**:
     - For steps on how to use makefiles, run `make help` from the root folder of the pru-no-code-tool repository.
