---

## Application Host Block

### Purpose

The Application Host block configures the R5F host-side compiler templates. It generates the necessary C initialization code (`main.c`) required to configure the SoC, launch the PRU cores with the loaded firmware, and prepare IPC notifications.

### Features

- Executes entirely on the R5F Host compiler via custom template injection (`r5f_main.c.xdt`)
- Automates Sciclient initialization for power, clock, and boot configuration
- Scaffolds IPC Notify interrupt handlers
- Emits a standalone, compile-ready `main.c` file in the build directory

### Configuration

| Parameter | Description | Default | Options |
|-----------|-------------|---------|---------|
| Initialize Sciclient | Generate power and clock initialization code | `true` | `true`, `false` |
| Initialize IPC Notify | Enable host-to-PRU interrupt configuration | `true` | `true`, `false` |
| PRU Firmware Name | The file name of the PRU binary to load | `pru_firmware.out` | Text string |

### How It Works

This block does not emit PRU assembly. Instead, during the code generation phase, the SysConfig tool uses the block's parameters to inject templates:
1. Emits R5F platform initialization functions (Sciclient API calls).
2. Generates the PRU core boot and release sequences.
3. Maps shared memory variable offsets so the host R5F can access parameters from the PRU memory layouts.

### Important Notes

- Since this block executes on the host processor, it consumes 0 PRU execution cycles.
- The output C code is generated in the `build_out/` directory and can be directly included in CCS or makefile builds.

### Example Usage

To prepare a complete closed-loop motor control firmware setup:
1. Place an Application Host block in the SysConfig layout.
2. Set "PRU Firmware Name" to `dual_encoder_motor_control_pru0.out`.
3. Generate files. Use the emitted `main.c` as the entry point for your R5F MCU+ SDK project.

---
