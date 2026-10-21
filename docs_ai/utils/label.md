```javascript
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
```

```javascript
function getLongDescription() { ... } (see source file for full definition)
```

Source file: utils\label.syscfg.js