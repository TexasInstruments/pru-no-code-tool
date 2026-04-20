---

## Delay Block

### Purpose

Introduces a precise timing delay in PRU execution. Each delay count equals one PRU clock cycle. Use this block wherever timing gaps are needed between operations.

### Features

- 1–255 cycle delay per block
- Single NOP for 1-cycle delays (no loop overhead)
- Pass-through block — no data ports, only control flow
- Chain with Loop block for delays beyond 255 cycles

### Configuration

| Parameter | Description | Range |
|-----------|-------------|-------|
| PRU Clocks To Wait | Number of PRU clock cycles to delay | 1–255 |

### Timing Reference (200 MHz PRU clock)

| Delay Count | Time |
|------------|------|
| 1 | 5 ns |
| 10 | 50 ns |
| 100 | 500 ns |
| 200 | 1 µs |
| 255 (max) | 1.275 µs |

### Generated Assembly

**Single cycle (delayCount = 1):**
```assembly
NOP                          ; 1 cycle
```

**Multi-cycle (delayCount > 1):**
```assembly
    loop    endloop?, count - 1   ; Setup loop (2 cycles overhead)
    NOP
endloop?:
```

Total cycles = `delayCount` (the block reports `delayCount` cycles, overhead included).

### Delays Longer Than 255 Cycles

Use a **Loop block** wrapping one or more Delay blocks:

| Pattern | Formula | Example at 200 MHz |
|---------|---------|-------------------|
| Loop(N) → Delay(255) | N × 255 cycles | Loop(40) → ~51 µs |
| Nested Loop(A) → Loop(B) → Delay(D) | A × B × D cycles | Loop(1000) × Loop(200) × Delay(255) = 255 ms |

**Common delay targets:**

| Target | Configuration |
|--------|--------------|
| 10 µs | Loop(40) → Delay(50) |
| 100 µs | Loop(100) → Delay(200) |
| 1 ms | Loop(200) → Loop(5) → Delay(200) |
| 10 ms | Loop(1000) → Loop(10) → Delay(200) |

### Important Notes

- Maximum per block: **255 cycles** (hardware loop instruction limit)
- This is a **pass-through block** — no input/output data ports, only `prev` and `next`
- Loop overhead adds 2–3 cycles per iteration — account for this in precise timing

---
