function getAIContext() {
    return getLongDescription() + `
	
## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the Label block in a .syscfg file.

### Adding a Label Instance

\\\`\\\`\\\`javascript
const label_block = scripting.addModule("/pru_blocks/utils/label", {}, false);
const label1 = label_block.addInstance();
\\\`\\\`\\\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| $name | String | Any valid identifier | "Label_0" | Instance name (displayed as label text) |

### Example Configuration

**Add a documentation label:**
\\\`\\\`\\\`javascript
label1.$name = "UART_TX_Section";
\\\`\\\`\\\`

### Important Notes

1. **No Code Generation**: Label blocks are purely for documentation and generate no assembly code.

2. **No Ports**: Labels have no input/output ports and cannot be connected to other blocks.

3. **Visual Only**: Labels appear only in the SysConfig GUI and don't affect PRU execution.
`;
}

function getLongDescription() {
	return `
## Label Block

### Purpose
This is a text box which can be used in the visual interface for user to maintain notes on block connections. It doesn't play any role in the actual code generation.

### How It Works
- Add labels anywhere in your block diagram to document your design
- Labels are purely visual annotations - they generate no code
- Use them to explain complex logic, mark sections, or add reminders

### Usage Notes
- Labels don't have input or output ports
- They don't affect PRU execution or timing
- Useful for team collaboration and documentation

---`;
}

exports = {
	displayName: "Label",
	defaultInstanceName: "Label_",
	uiView: "graph",
    longDescription : getLongDescription(),
	templates: {
		//need to check what can be passed as argument to template file, right now no argument is required
        "/pru_blocks/common/pru_syscfg.asm.xdt": null
    },
	config: [
		{
			name: "$shape",
			hidden: true,
			default: "label",
		},
        {
			name: "$topLabel",
			hidden: true,
            default: "",
		}
	],
}