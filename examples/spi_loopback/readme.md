# SPI Loopback

## Introduction

This example demonstrates the use of pru-no-code-tool for SPI loopback, the code sends 32 bits of data from PRU0 to PRU1 through SPI protocol, PRU0 acts as controller (master) and PRU1 acts as preipheral (slave) in this example 
# Supported Combinations

 Parameter      | Value
 ---------------|-----------
 ICSSG          | ICSSG0 - PRU0, PRU1
 Toolchain      | pru-cgt
 Board          | am243x-lp
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

     - Connect the SPI master and slave pins as per configuration. In the example these pins are mapped as shown below:
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

