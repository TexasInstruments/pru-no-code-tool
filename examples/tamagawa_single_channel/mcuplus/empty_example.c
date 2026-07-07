/*
 *  Copyright (C) 2024-2025 Texas Instruments Incorporated
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions
 *  are met:
 *
 *    Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *
 *    Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the
 *    distribution.
 *
 *    Neither the name of Texas Instruments Incorporated nor the names of
 *    its contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 *  "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 *  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 *  A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 *  OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 *  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 *  LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 *  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 *  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 *  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 *  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include <stdio.h>
#include <kernel/dpl/DebugP.h>
#include <kernel/dpl/ClockP.h>
#include <drivers/gpio.h>
#include <kernel/dpl/AddrTranslateP.h>
#include "ti_drivers_config.h"
#include "ti_drivers_open_close.h"
#include "ti_board_open_close.h"
#include <drivers/pruicss.h>

#include <pru1_load_bin.h>

/*
 *  IPC shared memory layout (PRU1 SHAREDMEM physical base = 0x30010000):
 *      offset 0x00 : uint8_t  trigger     (R5F writes 1; PRU clears to 0 when done)
 *      offset 0x01 : uint8_t  command     (R5F writes pre-encoded TX byte before trigger)
 *      offset 0x02 : uint8_t  reserved[2]
 *      offset 0x04 : uint32_t result_lo   (PRU stores R1 here — bits [31:0] of raw RX)
 *      offset 0x08 : uint32_t result_hi   (PRU stores R2 here — bits [39:32] of raw RX)
 *
 *  Command byte values (raw CF byte, framing handled by no-code TX Op block):
 *      0x92 (146) -> DATA_ID_2 : Encoder ID        — 4 RX frames (40 wire bits)
 *      0x02   (2) -> DATA_ID_0 : Absolute position — 6 RX frames (60 wire bits)
 *      0x8A (138) -> DATA_ID_1 : Multi-turn data   — 6 RX frames (60 wire bits)
 */
#define PRU1_DRAM_BASE       (0x30010000U)
#define IPC_TRIGGER_OFFSET   (0x00U)
#define IPC_COMMAND_OFFSET   (0x01U)
#define IPC_RESULT_OFFSET    (0x04U)

#define CMD_DATA_ID_2        (0x92U)   /* Encoder ID        — 4 RX frames */
#define CMD_DATA_ID_0        (0x02U)   /* Absolute position — 6 RX frames */
#define CMD_DATA_ID_1        (0x8AU)   /* Multi-turn data   — 6 RX frames */

#define IPC_POLL_TIMEOUT_US (5000U)
#define IPC_POLL_SLEEP_US   (10U)

PRUICSS_Handle gPruIcss0Handle;

void empty_example_main(void *args)
{
    int status;
    uint32_t input;
    volatile uint8_t  *pTrigger = (volatile uint8_t  *)(PRU1_DRAM_BASE + IPC_TRIGGER_OFFSET);
    volatile uint8_t  *pCommand = (volatile uint8_t  *)(PRU1_DRAM_BASE + IPC_COMMAND_OFFSET);
    volatile uint32_t *pResult  = (volatile uint32_t *)(PRU1_DRAM_BASE + IPC_RESULT_OFFSET);

    Drivers_open();

    status = Board_driversOpen();
    DebugP_assert(SystemP_SUCCESS == status);

    /* Enable encoder booster pack power (GPIO1_78 = MMC1_SDWP) */
    uint32_t gpioBaseAddr = (uint32_t)AddrTranslateP_getLocalAddr(TAMAGAWA0_BP_POWER_EN0_BASE_ADDR);
    GPIO_setDirMode(gpioBaseAddr, TAMAGAWA0_BP_POWER_EN0_PIN, GPIO_DIRECTION_OUTPUT);
    GPIO_pinWriteHigh(gpioBaseAddr, TAMAGAWA0_BP_POWER_EN0_PIN);
    ClockP_usleep(1000);

    gPruIcss0Handle = PRUICSS_open(CONFIG_PRU_ICSS0);

    /* Route GPI9 to PERIF0_IN via SA_MX_REG (required for channel 0 RX) */
    status = PRUICSS_setSaMuxMode(gPruIcss0Handle, PRUICSS_SA_MUX_MODE_SD_ENDAT);
    DebugP_assert(SystemP_SUCCESS == status);

    status = PRUICSS_initMemory(gPruIcss0Handle, PRUICSS_DATARAM(PRUICSS_PRU0));
    DebugP_assert(status != 0);
    status = PRUICSS_initMemory(gPruIcss0Handle, PRUICSS_DATARAM(PRUICSS_PRU1));
    DebugP_assert(status != 0);
    volatile uint8_t *pSmem = (volatile uint8_t *)PRU1_DRAM_BASE;
    pSmem[IPC_TRIGGER_OFFSET] = 0U;
    pSmem[IPC_RESULT_OFFSET]  = 0U;
    pSmem[IPC_RESULT_OFFSET+1] = 0U;
    pSmem[IPC_RESULT_OFFSET+2] = 0U;
    pSmem[IPC_RESULT_OFFSET+3] = 0U;
    status = PRUICSS_loadFirmware(gPruIcss0Handle, PRUICSS_PRU1, PRU1Firmware_0, sizeof(PRU1Firmware_0));
    DebugP_assert(SystemP_SUCCESS == status);
    DebugP_log("Loaded encoder firmware.\r\n");

    DebugP_log("Commands:\r\n");
    DebugP_log("  0 -> DATA_ID_0 : Absolute position    (CF, SF, ABS[23:0], CRC)\r\n");
    DebugP_log("  1 -> DATA_ID_1 : Multi-turn data      (CF, SF, ABM[23:0], CRC)\r\n");
    DebugP_log("  2 -> DATA_ID_2 : Encoder ID readout   (CF, SF, ENID, CRC)\r\n");

    while (1)
    {
        DebugP_log("\r\nEnter command (0, 1 or 2): ");
        DebugP_scanf("%d", &input);

        if (input > 2)
        {
            DebugP_log("Invalid input, enter 0, 1 or 2.\r\n");
            continue;
        }

        /* Write command byte then trigger PRU */
        *pCommand = (input == 0) ? CMD_DATA_ID_0 :
                    (input == 1) ? CMD_DATA_ID_1 : CMD_DATA_ID_2;
        *pTrigger = 1U;

        /* Poll until PRU clears trigger (transaction done) */
        uint32_t elapsed = 0U;
        while (*pTrigger != 0U)
        {
            ClockP_usleep(IPC_POLL_SLEEP_US);
            elapsed += IPC_POLL_SLEEP_US;
            if (elapsed >= IPC_POLL_TIMEOUT_US)
            {
                DebugP_log("ERROR: PRU timeout.\r\n");
                break;
            }
        }

        if (*pTrigger != 0U)
        {
            continue;
        }

        /*
         * Raw bitstream layout (bit 0 = first data bit received, 10-bit frames):
         *   Each Tamagawa frame occupies 10 bits: 8 data bits + stop + start of next frame.
         *   Frame N data bits: raw >> (N * 10) & 0xFF
         *
         * DATA_ID_2 (4 frames): CF | SF | ENID | CRC
         *   bits [7:0]   = CF
         *   bits [17:10] = SF
         *   bits [27:20] = ENID
         *   bits [37:30] = CRC
         *
         * DATA_ID_0 (6 frames): CF | SF | ABS[7:0] | ABS[15:8] | ABS[23:16] | CRC
         *   bits [7:0]   = CF
         *   bits [17:10] = SF
         *   bits [27:20] = ABS[7:0]   (lower byte)
         *   bits [37:30] = ABS[15:8]  (middle byte)
         *   bits [47:40] = ABS[23:16] (upper byte)
         *   bits [57:50] = CRC
         */
        uint64_t raw = ((uint64_t)pResult[1] << 32) | pResult[0];

        uint8_t cf  =  raw        & 0xFF;
        uint8_t sf  = (raw >> 10) & 0xFF;

        if (input == 0)
        {
            /* DATA_ID_0: Absolute position */
            uint8_t  abs_lo  = (raw >> 20) & 0xFF;
            uint8_t  abs_mid = (raw >> 30) & 0xFF;
            uint8_t  abs_hi  = (raw >> 40) & 0xFF;
            uint8_t  crc     = (raw >> 50) & 0xFF;
            uint32_t abs_pos = ((uint32_t)abs_hi << 16) | ((uint32_t)abs_mid << 8) | abs_lo;
            DebugP_log("DATA_ID_0  CF=0x%02X  SF=0x%02X  ABS=0x%06X  CRC=0x%02X\r\n",
                       cf, sf, abs_pos, crc);
        }
        else if (input == 1)
        {
            /* DATA_ID_1: Multi-turn data */
            uint8_t  abm_lo  = (raw >> 20) & 0xFF;
            uint8_t  abm_mid = (raw >> 30) & 0xFF;
            uint8_t  abm_hi  = (raw >> 40) & 0xFF;
            uint8_t  crc     = (raw >> 50) & 0xFF;
            uint32_t abm     = ((uint32_t)abm_hi << 16) | ((uint32_t)abm_mid << 8) | abm_lo;
            DebugP_log("DATA_ID_1  CF=0x%02X  SF=0x%02X  ABM=0x%06X  CRC=0x%02X\r\n",
                       cf, sf, abm, crc);
        }
        else
        {
            /* DATA_ID_2: Encoder ID */
            uint8_t enid = (raw >> 20) & 0xFF;
            uint8_t crc  = (raw >> 30) & 0xFF;
            DebugP_log("DATA_ID_2  CF=0x%02X  SF=0x%02X  ENID=0x%02X  CRC=0x%02X\r\n",
                       cf, sf, enid, crc);
        }
    }

    Board_driversClose();
    Drivers_close();
}
