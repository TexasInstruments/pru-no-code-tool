---

## PRU GPO Block (General Purpose Output)

### Purpose

Sets or clears digital output signals on PRU output pins. This is a terminating block — it has no output port and directly controls physical pin states via the R30 register.

### Features

- Control any of 20 PRU output pins (GPO_0 through GPO_19)
- Single-cycle SET or CLEAR operation
- Pin state persists until explicitly changed by another GPO block
- Terminating block — no output data connection

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| PRU GPO Signal | Output pin to control | PRU_GPO_0 through PRU_GPO_19 |
| Output Operation | Pin state to set | SET SIGNAL (HIGH), CLEAR SIGNAL (LOW) |

### How It Works

1. **Select Pin**: Choose which PRU output pin to control (PRU_GPO_0 through PRU_GPO_19)
2. **Select Operation**: Choose SET (HIGH) or CLEAR (LOW)
3. **Execute**: Generates a SET/CLR instruction that changes the pin state immediately

### Generated Assembly

```assembly
SET     R30, R30, pin_number    ; Set pin HIGH (1 cycle)
; OR
CLR     R30, R30, pin_number    ; Set pin LOW (1 cycle)
```

### Technical Details

- **R30 Register**: PRU's output register (32-bit, write-only). Changes take effect immediately
- **Performance**: 1 PRU cycle
- **Terminating Block**: No output ports — ends the data flow for that path
- Pin states persist until explicitly changed

### Common Use Cases

- Controlling LEDs or status indicators
- Generating chip select (CS) signals for SPI
- Creating pulse or strobe signals (SET block → Delay block → CLEAR block)
- Multi-bit parallel output (one GPO block per bit)
- Bit-banging custom protocols

### Example: Generating a Pulse

```
PRU GPO (pin 3, SET)   → Pulse goes HIGH
[Delay block]
PRU GPO (pin 3, CLEAR) → Pulse goes LOW
```

### Example: SPI Chip Select

```
PRU GPO (CS pin, CLEAR) → Assert CS (active low)
[SPI transfer blocks]
PRU GPO (CS pin, SET)   → Deassert CS
```

---
