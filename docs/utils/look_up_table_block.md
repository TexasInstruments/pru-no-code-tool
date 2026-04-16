---

## Lookup Table Block

### Purpose

Defines a table of pre-computed data values stored in PRU Data Memory (DMEM or SMEM). The data is written by the R5F core before the PRU starts. Use the **Access Lookup Table** block to read values from this table at runtime.

### Features

- Up to 65,536 entries per table
- Three data types: 8-bit, 16-bit, 32-bit
- Multiple data input methods: manual, pattern, paste JSON, load JSON file
- Choice of DMEM (local, 8 KB) or SMEM (shared, 64 KB)
- No runtime overhead — data is pre-loaded in memory

### Configuration

| Parameter | Description | Options / Range |
|-----------|-------------|-----------------|
| Lookup Table Memory Location | Where to store the table | DMEM (Local), SMEM (Shared) |
| Number of Table Entries | How many values the table holds | 1–65,536 |
| Data Type | Width of each entry | 8-bit (byte), 16-bit (ushort), 32-bit (uint) |
| Data Input Method | How to populate the table | Manual/Pattern, Paste JSON, Load JSON File |
| Initialize Pattern | Auto-fill pattern | Sequential, All Zeros, All Ones, Custom Fill, Manual Entry |

### Memory Usage

| Data Type | Bytes per Entry | 256-entry table | 1024-entry table |
|-----------|----------------|-----------------|------------------|
| byte | 1 | 256 bytes | 1 KB |
| ushort | 2 | 512 bytes | 2 KB |
| uint | 4 | 1 KB | 4 KB |

### Data Input Methods

**Manual / Pattern** — edit values directly or auto-generate:
- Sequential: 0, 1, 2, 3, ...
- All Zeros / All Ones
- Custom fill: same value repeated N times
- Manual entry: edit the comma-separated list directly

**Paste JSON Data** — for large tables, paste JSON in this format:
```json
{
  "values": [0, 1, 2, 3, ...],
  "dataType": "byte"
}
```

**Load JSON From File** — browse and select a `.json` file with the same format. Recommended for very large tables.

### Generated Assembly

```assembly
.data
.align 4
Lookup_Table_0:  .byte  0, 1, 2, 3, 4, 5, ...
```

### Memory Location

| Location | Size | Access Speed | Accessibility |
|---------|------|-------------|---------------|
| DMEM | 8 KB per PRU | Fast | Private to each PRU |
| SMEM | 64 KB total | Slightly slower | Shared by all PRUs and R5F |

Use SMEM when multiple PRU cores need the same table, or to save DMEM for runtime buffers.

### Validation Rules

- Table size: 1–65,536 entries
- Value range must match data type (e.g., 0–255 for byte)
- Number of entered values must not exceed table size

### Workflow

1. Add a **Lookup Table** block and configure data type, size, and values
2. Add an **Access Lookup Table** block and point its `lutReference` to this block's name
3. Connect an index value to the Access block's `index` input
4. The Access block reads and outputs `table[index]` at runtime

---
