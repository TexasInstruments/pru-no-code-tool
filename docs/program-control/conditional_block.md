---

## If/Else Block (Conditional Branching)

### Purpose

Implements conditional logic to control program flow based on comparing two input values. Directs execution to different paths depending on whether the condition is true or false.

### Features

- Six comparison operations (>, <, ==, !=, >=, <=)
- Unsigned integer comparisons
- Single-cycle execution
- Two independent output paths (true and false)
- No output data value — controls flow only

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Condition To Check | Comparison operation between input1 and input2 | See table below |

### Available Conditions

| Option | PRU Instruction | Condition |
|--------|----------------|-----------|
| Greater Than Input2 | QBGT | input1 > input2 |
| Less Than Input2 | QBLT | input1 < input2 |
| Equal To Input2 | QBEQ | input1 == input2 |
| Not Equal To Input2 | QBNE | input1 != input2 |
| Greater Than Or Equal To Input2 | QBGE | input1 >= input2 |
| Less Than Or Equal To Input2 | QBLE | input1 <= input2 |

### Ports

| Port | Type | Description |
|------|------|-------------|
| input1 | Input | First comparison value |
| input2 | Input | Second comparison value |
| t_next | Output | Path executed when condition is **TRUE** |
| f_next | Output | Path executed when condition is **FALSE** |
| prev | Control | Connects from previous block's next |

### How It Works

1. Both inputs are compared using the selected condition
2. If the condition is TRUE → blocks connected to `t_next` execute
3. If the condition is FALSE → blocks connected to `f_next` execute
4. Both paths are generated in assembly; only one executes at runtime

### Generated Assembly

```assembly
QBGT  TRUE_LABEL, input1_reg, input2_reg   ; Branch if input1 > input2 (1 cycle)
; FALSE path blocks here
QBA   END_LABEL                             ; Jump past true path
TRUE_LABEL:
; TRUE path blocks here
END_LABEL:
```

### Technical Details

- **Performance**: 1 PRU cycle for the comparison and branch
- **Comparison type**: All comparisons are **unsigned** — values treated as positive integers
- Both `t_next` and `f_next` ports should be connected (warnings issued if not)

### Common Use Cases

- Threshold checking (e.g., is sensor value above limit?)
- Zero detection (`notEqualToInput2` with input2 = 0)
- Range validation
- State machine transitions

---
