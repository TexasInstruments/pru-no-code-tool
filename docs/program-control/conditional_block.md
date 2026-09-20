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
QBGT  If_Else_0_TRUE, input1_reg, input2_reg   ; Branch if input1 > input2 (1 cycle)
; FALSE path blocks here
; FALSE branch MUST end in a Flow Control block (see "Flow Control Requirement" below)
If_Else_0_TRUE:
; TRUE path blocks here
; TRUE branch MUST end in a Flow Control block
```

### Technical Details

- **Performance**: 1 PRU cycle for the comparison and branch
- **Comparison type**: All comparisons are **unsigned** — values treated as positive integers
- Both `t_next` and `f_next` ports should be connected (warnings issued if not)
- Every block, including this one, has an addressable `<blockName>_start` entry point that a [Flow Control block](flow_control_block.md) elsewhere in the design can jump to (e.g. to re-run this comparison)

### Flow Control Requirement

The FALSE path is placed immediately after the branch instruction, with the TRUE path at the branch target label. **Any connected branch (t_next or f_next) that has no explicit terminator falls through into the other branch — causing both to execute regardless of the condition.** SysConfig validation enforces this as an error: every connected branch must end in a [Flow Control block](flow_control_block.md). Leaving a branch entirely unconnected is fine; only connected-but-unterminated branches are rejected.

**Where that Flow Control block should jump to depends on where the If/Else block lives:**

- **Standalone If/Else** (not inside a Loop block): jump to Sysconfig Generated End, Halt, or any other block's `_start`/`_end` target.
- **If/Else nested inside a Loop block**: jump to that Loop's own `<LoopName>_start` target so execution resumes the loop instead of exiting the whole program. Jumping to Sysconfig Generated End or Halt from inside a loop's branch ends the entire program early rather than just this iteration — only do that if that's genuinely the intent. To break out of the loop early without ending the whole program, jump to the Loop's `<LoopName>_end` target instead.

### Common Use Cases

- Threshold checking (e.g., is sensor value above limit?)
- Zero detection (`notEqualToInput2` with input2 = 0)
- Range validation
- State machine transitions
- Loop early-exit / break (nested inside a Loop block, jumping to `<LoopName>_end` on some exit condition)

---
