// Control-flow class ("sequential" or "continuous") of each block, used by the GUI pin-sharing check in
// pru_blocks_static_module: instances of one sequential module may share a two-way pad, and a GPO driven by
// two instances is flagged when either block is continuous. A block that is not listed is treated as
// continuous (the check fails closed). blockControlFlowBound names a config that makes a continuous block
// sequential when it is > 0.
exports = {
    blockControlFlow: {
        "access_look_up_table": "sequential",
        "arithmetic_block": "sequential",
        "bitwise_block": "sequential",
        "conditional_block": "continuous",
        "crc_block": "sequential",
        "delay_block": "continuous",
        "flow_control_block": "continuous",
        "group_block": "continuous",
        "label": "continuous",
        "load_constant_block": "sequential",
        "look_up_table": "continuous",
        "loop_block": "continuous",
        "memory_access_block": "continuous",
        "memory_variable_block": "continuous",
        "pru_gpi_block": "sequential",
        "pru_gpo_block": "sequential",
        "pru_spi_read": "sequential",
        "pru_spi_transfer": "sequential",
        "pru_spi_write": "sequential",
    },
    blockControlFlowBound: {
    }
};
if (typeof module !== 'undefined') {
    module.exports = exports;
}
