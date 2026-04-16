---

## PRU GPI Block (General Purpose Input)

### Purpose

Reads digital input signals from PRU input pins and outputs the pin state to the next block.

### Features

- Read any of 20 PRU input pins (GPI_0 through GPI_19)
- Single-cycle execution
- Output passes the masked bit value to downstream blocks
- Simulation support via Simulation Settings module

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| PRU GPI Signal | Input pin to read | PRU_GPI_0 through PRU_GPI_19 |

### How It Works

1. **Select Pin**: Choose which PRU input pin to read (PRU_GPI_0 through PRU_GPI_19)
2. **Read Operation**: Generates an AND instruction to mask and read the specific bit from R31
3. **Output**: Provides the pin value (0 or non-zero) to the next block

### Generated Assembly

```assembly
AND     result, R31, (1 << pin_number)    ; Mask the specific bit (1 cycle)
```

### Technical Details

- **R31 Register**: PRU's input register (32-bit, read-only). Reflects current state of all PRU input pins automatically
- **Pin Mapping**: PRU_GPI_N corresponds to bit N in R31. Physical pin mapping depends on device pinmux configuration
- **Performance**: 1 PRU cycle
- **Output Size**: 1-4 bytes depending on which bit is masked (bit 0-7 = 1 byte, bit 8-15 = 2 bytes, etc.)

### Simulating Input Data

To test without hardware, use the **Simulation Settings** module:

1. Open Simulation Settings and select the GPI pin in "Select R31 (Input) Signals"
2. Choose **Timestamp Mode** (specify values at specific cycles) or **Pattern Mode** (binary pattern)
3. Define when the pin should be HIGH (1) or LOW (0)

**Example — simulating a button press on PRU_GPI_5:**
```
R31 Bit 5 - Timestamp Mode:
  Input Cycles: [0, 100, 200, 300]
  Input Values: [0,   1,   1,   0]
```

**Example — simulating a 60% duty-cycle PWM on PRU_GPI_3:**
```
R31 Bit 3 - Pattern Mode:
  Pattern: 1111110000111111000011111100001111110000
```

### Common Use Cases

- Reading button or switch states
- Monitoring external trigger signals
- Sampling digital sensor outputs
- Observing clock or strobe signals from external devices

---
