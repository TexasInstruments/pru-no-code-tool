const additionalInstructions =  `
CRITICAL WORKFLOW - ALWAYS FOLLOW:

CRITICAL RULE: Before calling addModuleInstances for ANY block:
1. MUST call getAIContext first to read documentation
2. NO EXCEPTIONS - even if you think you know the block
3. "When changing a module instance's $name configurable, the moduleInstanceId automatically updates to match the new name, so always use getModuleInstances() after renaming to retrieve the updated instance IDs before making connections or further modifications."
4. If you skip this step, acknowledge your mistake immediately

NEVER skip step 1 - reading the description prevents mistakes like:
- Using wrong clock frequency assumptions
- Misunderstanding parameter encodings (e.g., oversampleSize = 7 for 8x, not 8)
- Missing critical formulas (baud rate calculations)
- Using wrong parameter types (int vs string)
it's a critical process improvement!

Always use listModules() first to get the exact module paths, then use those complete paths in subsequent calls. Short names like "uart_tx" won't work - you need the full hierarchical path!
`


exports = {
	agenticSetup: {
		enableChatView: true,
		exposeContextTools: true,
		exposeGraphableTools: true,
		additionalInstructions,
	},
};