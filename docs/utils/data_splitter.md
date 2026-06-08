---

## Data Splitter Block

### Purpose

Extracts either the lower or upper 32 bits from a 64-bit input (two consecutive registers) and outputs it as a 32-bit value. Use this to consume one half of a 64-bit output produced by blocks such as `UART RX Op` in extended mode or a `Memory Access` block with data size > 4 bytes.

### Features

- Single-instruction extraction (one MOV) — 1 cycle
- Selectable lower half (bits 31:0) or upper half (bits 63:32)
- 64-bit input, 32-bit output — bridges 64-bit producers to 32-bit consumers

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Split Select | Which 32-bit half to extract from the 64-bit input | Lower 32 bits (bits 31:0), Upper 32 bits (bits 63:32) |

### Ports

| Port | Type | Description |
|------|------|-------------|
| input1 | 64-bit (input64) | 64-bit data input from a two-register source |
| output1 | 32-bit (output32) | Selected 32-bit half |

### Generated Assembly

**Lower 32 bits (Split Select = lower):**
```assembly
MOV  dataOut, dataRegLo   ; copy lower register (bits 31:0)
```

**Upper 32 bits (Split Select = upper):**
```assembly
MOV  dataOut, dataRegHi   ; copy upper register (bits 63:32)
```

### Performance

1 cycle regardless of selection.

### Typical Use Case

`UART RX Op` with `RX Frame Size > 32` produces a 64-bit output. Connect it to two Data Splitter blocks — one set to `lower`, one to `upper` — to route each 32-bit half independently downstream.

```
[UART RX Op (64-bit out)] ──► [Data Splitter lower] ──► [downstream block A (32-bit in)]
                          └──► [Data Splitter upper] ──► [downstream block B (32-bit in)]
```

### Important Notes

- The input port is fixed at 64-bit — it must be connected to a 64-bit output port
- The output port is fixed at 32-bit — downstream blocks must accept a 32-bit input
- No arithmetic is performed — this is purely a register copy

---
