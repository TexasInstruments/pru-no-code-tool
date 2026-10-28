NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/utils/data_splitter.md

## Data Splitter Block

### Purpose
Extracts the lower or upper 32 bits from a 64-bit input (two consecutive registers). Connect the output of a 64-bit block (e.g. UART RX Op in extended mode, Memory Access with dataSize > 4) to this block's input, and select which half you need.

### How It Works
1. **Input**: Receives a 64-bit value spread across two consecutive registers (dataRegLo and dataRegHi)
2. **Selection**: Based on `splitSelect`, outputs either the lower 32 bits or upper 32 bits
3. **Output**: Produces a single 32-bit result in the output register

### Generated Assembly
**Lower 32 bits (splitSelect = lower):**
```assembly
MOV  R_out, dataRegLo   ; copy lower register (bits 31:0)
```

**Upper 32 bits (splitSelect = upper):**
```assembly
MOV  R_out, dataRegHi   ; copy upper register (bits 63:32)
```

### Ports
- **input1 (in64)**: 64-bit data input (two consecutive registers)
- **output1 (out32)**: 32-bit data output (selected half)
- **prev / next**: Control flow connections

### Configuration

**Split Select**
- Choose `lower` (bits 31:0) or `upper` (bits 63:32)
- Default: `lower`

### Performance
- **1 PRU cycle** (MOV instruction)

### Connection Notes
- This block is used to split a 64-bit result from blocks like UART RX Op or Memory Access when reading 8 bytes.
- The input is considered as two 32-bit halves; only `lower` or `upper` is output.

---

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Data Splitter block in a .syscfg file.

### Adding a Data Splitter Instance

```javascript
const data_splitter = scripting.addModule("/pru_blocks/utils/data_splitter", {}, false);
const split1 = data_splitter.addInstance();
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| splitSelect | String | "lower", "upper" | "lower" | Which 32-bit half to output |

### Example Configurations

**Extract lower 32 bits:**
```javascript
split1.$name = "Data_Splitter_0";
split1.splitSelect = "lower";  // Output bits 31:0
```

**Extract upper 32 bits:**
```javascript
split1.$name = "Data_Splitter_Upper";
split1.splitSelect = "upper";  // Output bits 63:32
```

### Connecting to Other Blocks

```javascript
// Input from a 64-bit source (e.g., UART RX Op or Memory Access)
scripting.connect(uart_rx_op1, "output1", split1, "input1");

// Output to downstream 32-bit consumer
scripting.connect(split1, "output1", next_block, "input1");

// Control flow
scripting.connect(prev_block, "next", split1, "prev");
scripting.connect(split1, "next", next_block, "prev");
```

### Important Notes

1. **64-bit Input Required**: The input port is 64-bit (input1Size=8). Connect from a block that produces 64-bit output (e.g., UART RX Op with dataSize=8, or Memory Access with dataSize=8).

2. **Single 32-bit Output**: Only one 32-bit value is produced (`output1Size=4`).

3. **One Cycle**: The MOV instruction takes a single PRU cycle.

4. **Split Select Values**:
   - `"lower"`: Outputs the lower 32 bits (`bits 31:0`)
   - `"upper"`: Outputs the upper 32 bits (`bits 63:32`)

5. **No Data Ports Beyond Input/Output**: Only one input (`input1`) and one output (`output1`) are available.
