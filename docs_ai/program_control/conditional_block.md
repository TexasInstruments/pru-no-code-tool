## If/Else Block (Conditional Branching)

### Purpose
Implements conditional logic (IF/ELSE statements) to control program flow based on comparing two input values. Directs execution to different paths depending on whether the condition is true or false.

### How It Works
1. **Input 1**: First value to compare
2. **Input 2**: Second value to compare
3. **Condition**: Select comparison operation (>, <, ==, !=, >=, <=)
4. **Branching**:
- If condition is TRUE → executes blocks connected to **t_next** port
- If condition is FALSE → executes blocks connected to **f_next** port

### Configuration

**Condition To Check**: Select the comparison operation
- **Greater Than Input2**: Input1 > Input2
- **Less Than Input2**: Input1 < Input2
- **Equal To Input2**: Input1 == Input2
- **Not Equal To Input2**: Input1 != Input2
- **Greater Than Or Equal To Input2**: Input1 >= Input2
- **Less Than Or Equal To Input2**: Input1 <= Input2

### Technical Details (Additional Information)

**Generated Assembly**:
- ; Example: Greater Than Input2 (QBGT)
- FalseBranchHead_start:
- QBGT If_Else_0_TRUE, input1_reg, input2_reg   ; Branch if input1 > input2 (1 cycle)
- ; FALSE path code here
- ; FALSE branch MUST end in a Flow Control block (e.g. JMP sysconfig_generated_end)
- If_Else_0_TRUE:
- TrueBranchHead_start:
- ; TRUE path code here
- ; TRUE branch MUST end in a Flow Control block

**PRU Branch Instructions**:
- **QBGT**: Quick Branch if Greater Than (unsigned comparison)
- **QBLT**: Quick Branch if Less Than (unsigned comparison)
- **QBEQ**: Quick Branch if Equal
- **QBNE**: Quick Branch if Not Equal
- **QBGE**: Quick Branch if Greater than or Equal
- **QBLE**: Quick Branch if Less than or Equal

**Performance**: 1 PRU cycle for the comparison and branch decision

**Comparison Type**: All comparisons are **unsigned** integer comparisons
- Treats values as unsigned (0 to 255 for bytes, 0 to 65535 for shorts, etc.)
- Negative numbers are not supported in standard mode

### Connection Ports

**Input Ports**:
- **input1**: First comparison value
- **input2**: Second comparison value

**Output Ports**:
- **t_next** (true next): Connect blocks to execute when condition is TRUE
- **f_next** (false next): Connect blocks to execute when condition is FALSE

### Usage Notes
- Both input ports must be connected for conditional operation
- Both t_next and f_next ports should be connected to avoid warnings
- Comparisons are unsigned - values treated as positive integers
- The conditional check happens instantly (1 cycle)
- Code on both branches is generated, only one path executes at runtime
- This block does not produce an output value - it only controls flow
- **Any connected branch (T or F) MUST terminate in a Flow Control block**: The FALSE path falls through to the TRUE path in the generated assembly unless explicitly stopped, and vice versa. SysConfig validation now enforces this as an error — connect a Flow Control block at the end of every connected branch. Leaving a branch entirely unconnected is fine; only connected-but-unterminated branches are rejected.
- **What that Flow Control block should jump to depends on where the If/Else block lives**:
  - **Standalone If/Else** (not inside a Loop block): jump to Sysconfig Generated End, Halt, or any other block's `_start` target.
  - **If/Else nested inside a Loop block**: jump to that Loop's `<LoopName>_start` target so execution resumes the loop instead of exiting the whole program. Jumping to Sysconfig Generated End or Halt from inside a loop's branch ends the entire program early rather than just this iteration — only intentional if that's really the goal. To break out of the loop early, jump to the next connected block or sysconfig_generated_end via Flow Control.
- Every block, including this one and every block on either branch, has an addressable `<blockName>_start` entry point that a Flow Control block elsewhere in the design can jump to (e.g. to re-run this comparison, or to re-enter a Loop block from inside a branch).

### Terminology
- **Conditional branching**: Changing program flow based on a condition
- **IF/ELSE**: Fundamental programming construct for decisions
- **Branch instruction**: Assembly instruction that jumps to different code location
- **Quick Branch (QB)**: PRU's fast comparison and branch instructions
- **Unsigned comparison**: Treating all values as positive (0 to max)
- **Label**: Named location in assembly code for branching target
- **Control flow**: Order in which instructions execute
- **t_next/f_next**: True next and False next - execution paths after condition

---
	
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the If/Else (Conditional) block in a .syscfg file.

### Adding an If/Else Instance

\`\`\`javascript
const conditional_block = scripting.addModule("/pru_blocks/program_control/conditional_block", {}, false);
const if_else1 = conditional_block.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| conditionToCheck | String | See table below | "greaterThanInput2" | Comparison operation |

### Valid Values for conditionToCheck

| Value | Display Name | PRU Instruction | Description |
|-------|--------------|-----------------|-------------|
| "greaterThanInput2" | Greater Than Input2 | QBGT | input1 > input2 |
| "lessThanInput2" | Less Than Input2 | QBLT | input1 < input2 |
| "equalToInput2" | Equal To Input2 | QBEQ | input1 == input2 |
| "notEqualToInput2" | Not Equal To Input2 | QBNE | input1 != input2 |
| "greaterThanEqualtoInput2" | Greater Than Or Equal To Input2 | QBGE | input1 >= input2 |
| "lessThanEqualtoInput2" | Less Than Or Equal To Input2 | QBLE | input1 <= input2 |

### Example Configurations

**Check if value is greater than threshold:**
\`\`\`javascript
if_else1.$name = "Check_Threshold";
if_else1.conditionToCheck = "greaterThanInput2";
\`\`\`

**Check for equality:**
\`\`\`javascript
if_else1.$name = "Check_Equal";
if_else1.conditionToCheck = "equalToInput2";
\`\`\`

**Check if not zero:**
\`\`\`javascript
if_else1.$name = "Check_Not_Zero";
if_else1.conditionToCheck = "notEqualToInput2";
// Connect input1 to value, input2 to Load_Constant with value 0
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect comparison inputs
scripting.connect(value_block, "output1", if_else1, "input1");
scripting.connect(threshold_block, "output1", if_else1, "input2");

// Connect true path (executes when condition is TRUE)
scripting.connect(if_else1, "T", true_path_block, "prev");

// Connect false path (executes when condition is FALSE)
scripting.connect(if_else1, "F", false_path_block, "prev");

// Connect control flow input
scripting.connect(prev_block, "next", if_else1, "prev");

// REQUIRED: both true_path_block's and false_path_block's chains must each
// end in a Flow Control block, or validation fails. Example (standalone
// If/Else, NOT inside a Loop block):
const flow_control_block = scripting.addModule("/pru_blocks/program_control/flow_control_block", {}, false);
const flow_true = flow_control_block.addInstance();
flow_true.$name = "Flow_Control_True_End";
flow_true.jumpTarget = "JMP"; // or "HALT", or any real "<blockName>_start" target to jump elsewhere
scripting.connect(true_path_block, "next", flow_true, "prev");

const flow_false = flow_control_block.addInstance();
flow_false.$name = "Flow_Control_False_End";
flow_false.jumpTarget = "JMP";
scripting.connect(false_path_block, "next", flow_false, "prev");
\`\`\`

**If the If/Else block is inside a Loop block's \`$groupContents\`**, "JMP"/"HALT" would exit the loop
entirely (or halt the PRU) instead of continuing the loop — jump to the loop's own \`_start\`
target instead so the loop keeps iterating:
\`\`\`javascript
// if_else1 is one of the instances inside loop_block1.$groupContents
const flow_true = flow_control_block.addInstance();
flow_true.$name = "Flow_Control_True_End";
flow_true.jumpTarget = "Loop_0_start"; // for INFINITE loops, this continues cleanly; for finite loops it re-arms LOOP (not a true continue)
scripting.connect(true_path_block, "next", flow_true, "prev");

const flow_false = flow_control_block.addInstance();
flow_false.$name = "Flow_Control_False_End";
flow_false.jumpTarget = "Loop_0_start";
scripting.connect(false_path_block, "next", flow_false, "prev");
\`\`\`
Jumping to `_start` resumes the loop for INFINITE loops (clean continue), but for finite loops it re-arms LOOP (counter reloads). For behavior corresponding to `break` use the flow control to jump to the start label of the block connected next to the loop block, `Continue and Break implementation using Flow Control Blocks` section in docs/program-control/loop_block.md for full context and details 

### Important Notes

1. **Two Inputs Required**: Both input1 and input2 must be connected for comparison.

2. **Two Output Paths**: Connect blocks to both T (true) and F (false) ports.

3. **Unsigned Comparison**: All comparisons treat values as unsigned integers.

4. **Single Cycle**: Comparison and branch decision execute in 1 PRU cycle.

5. **Port Names**: True path uses "T" port, False path uses "F" port (displayed as t_next/f_next).

6. **Every Connected Branch MUST Terminate in a Flow Control Block**: The code generator places the FALSE path immediately after the branch instruction, with the TRUE path at the branch target label. If a connected branch (T or F) has no explicit terminator, execution falls through into the other branch — causing both to execute regardless of the condition. This is now enforced by SysConfig validation (an error, not a warning) — any connected T or F branch that doesn't end in a Flow Control block will fail validation. A branch left entirely unconnected is still fine (nothing happens on that path).

7. **Where the Flow Control Block Should Jump To Depends On Context**:
   - **Standalone If/Else** (not inside a Loop block): jump to \`JMP\` (SysConfig Generated End), \`HALT\`, or any other block's \`_start\` target.
   - **If/Else nested inside a Loop block**: jump to that Loop's own \`<LoopName>_start\` target, so execution resumes the loop instead of exiting it. Using \`JMP\`/\`HALT\` here ends the whole program early instead of continuing the loop — only do that if that's actually the intent (e.g. an early-exit condition that should stop everything, not just this iteration). To break out of the loop early without ending the whole program, jump to the the start label of the  block connected to the loop block's next port or sysconfig_generated_end/halt depending on the usecase 