

function getLongDescription() {
	return `NOTE: Before making any assumptions about this block's parameters, behavior, or configuration, always read the docs file at: docs_ai/utils/label.md 

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