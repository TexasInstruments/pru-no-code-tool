---

## Delay Block

### Purpose

Introduces a precise timing delay in PRU execution. Each delay count equals one PRU clock cycle. Use this block wherever timing gaps are needed between operations.

### Features

- 1–255 cycle delay per block
- Single NOP for 1-cycle delays (no loop overhead)
- Pass-through block — no data ports, only control flow
- Chain Delay blocks sequentially for delays beyond 255 cycles. A Delay with count greater than one emits a hardware `LOOP`, so it cannot be placed inside a Loop block.

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
    loop    endloop?, count - 1   ; Setup loop (1 cycle)
    NOP
endloop?:
```

Total cycles = `delayCount` (the block takes exactly `delayCount` cycles, matching noOfCycles).

### Delays Longer Than 255 Cycles

One Delay block waits at most 255 cycles. For longer waits:

- **Chain Delay blocks.** Delay(255) -> Delay(255) -> Delay(100) waits 610 cycles.
- **Put the chain in an infinite Loop** for a periodic task. An infinite Loop compiles to a branch, not the hardware LOOP instruction, so Delay blocks of any length are legal inside it.
- **Use a software counter loop** (an Arithmetic block that decrements a counter and a Conditional block that branches back while it is non-zero) for very long waits.

Do not wrap a Delay longer than one cycle in a finite Loop: both emit the PRU hardware LOOP instruction and the PRU has one hardware-loop context, so SysConfig rejects it. Delay(1) is a plain NOP and is allowed inside any Loop.

**Common delay targets (200 MHz):**

| Target | Cycles | Configuration |
|--------|--------|--------------|
| 10 µs | 2,000 | 8 chained Delay(255) blocks |
| 100 µs | 20,000 | ~79 chained Delay blocks is impractical; use a software counter loop |
| 1 ms and up | 200,000+ | software counter loop, or schedule from the host |

### Important Notes

- Maximum per block: **255 cycles** (hardware loop instruction limit)
- This is a **pass-through block** — no input/output data ports, only `prev` and `next`
- Hardware LOOP executes with zero overhead per iteration; the block takes exactly `delayCount` cycles matching noOfCycles

---
