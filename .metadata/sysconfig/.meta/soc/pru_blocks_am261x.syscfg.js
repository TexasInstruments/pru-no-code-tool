
let common = system.getScript("/common");

const topModules_main = [

];

const topModules_mcu = [

];

const topModules_a53 = [

];

const topModules_pru = [
    {
        displayName: "PRU-BLOCKS",
        categories:[
            {
                displayName: "UTILS",
                modules: [
                    "/pru_blocks/utils/delay_block",
                    "/pru_blocks/utils/label",
                    "/pru_blocks/utils/look_up_table",
                    "/pru_blocks/utils/access_look_up_table",
                ],
                categories: [
                    {
                        displayName: "MEMORY CONFIGURATION",
                        modules: [
                            "/pru_blocks/utils/memory_access_block",
                            "/pru_blocks/utils/memory_variable_block",
                        ]
                    }
                ]
            },
            {
                displayName: "PROGRAM CONTROL",
                modules: [
                    "/pru_blocks/program_control/flow_control_block",
                    "/pru_blocks/program_control/conditional_block",
                    "/pru_blocks/program_control/loop_block",
                    "/pru_blocks/program_control/group_block"
                ],
            },
            {
                displayName: "DATA HANDLING",
                modules: [
                    "/pru_blocks/data_handling/load_constant_block",
                    "/pru_blocks/data_handling/arithmetic_block",
                    "/pru_blocks/data_handling/bitwise_block",
                ],
            },
            {
                displayName: "APPLICATION SPECIFIC",
                modules: [
                    "/pru_blocks/application_specific/crc_block",
                ],
            },
            {
                displayName: "INPUT & OUTPUT",
                modules: [
                    "/pru_blocks/pru_io_blocks/pru_gpo_block",
                    "/pru_blocks/pru_io_blocks/pru_gpi_block",
                ],
                categories: [
                    {
                        displayName: "SERIAL PROTOCOL EMULATION",
                        modules: [
                            "/pru_blocks/pru_io_blocks/uart_tx",
                            "/pru_blocks/pru_io_blocks/uart_rx",
                            "/pru_blocks/pru_io_blocks/pru_spi_write",
                            "/pru_blocks/pru_io_blocks/pru_spi_read",
                            "/pru_blocks/pru_io_blocks/pru_spi_transfer",
                        ]
                    }
                ]
            },
            {
                displayName: "SIMULATION SETTINGS",
                modules: [
                    "/pru_blocks/common/pru_blocks_static_module"
                ]
            },
            
        ]
    }
];

const topModules_rtu_tx_pru =[
    {
        displayName: "PRU-BLOCKS",
        categories:[
            {
                displayName: "UTILS",
                modules: [
                    "/pru_blocks/utils/delay_block",
                    "/pru_blocks/utils/label",
                    "/pru_blocks/utils/look_up_table",
                    "/pru_blocks/utils/access_look_up_table",
                ],
                categories: [
                    {
                        displayName: "MEMORY CONFIGURATION",
                        modules: [
                            "/pru_blocks/utils/memory_access_block",
                            "/pru_blocks/utils/memory_variable_block",
                        ]
                    }
                ]
            },
            {
                displayName: "PROGRAM CONTROL",
                modules: [
                    "/pru_blocks/program_control/flow_control_block",
                    "/pru_blocks/program_control/conditional_block",
                    "/pru_blocks/program_control/loop_block",
                    "/pru_blocks/program_control/group_block"
                ],
            },
            {
                displayName: "DATA HANDLING",
                modules: [
                    "/pru_blocks/data_handling/load_constant_block",
                    "/pru_blocks/data_handling/arithmetic_block",
                    "/pru_blocks/data_handling/bitwise_block",
                ],
            },
            {
                displayName: "APPLICATION SPECIFIC",
                modules: [
                    "/pru_blocks/application_specific/crc_block",
                ],
            },
            {
                displayName: "INPUT & OUTPUT",
                modules: [
                    "/pru_blocks/pru_io_blocks/pru_gpi_block",
                ],
            },
            {
                displayName: "SIMULATION SETTINGS",
                modules: [
                    "/pru_blocks/common/pru_blocks_static_module"
                ]
            },
            
        ]
    }
]

exports = {
    getTopModules: function() {

        let topModules = topModules_main;

        if(common.getSelfSysCfgCoreName().includes("m4f")) {
            topModules = topModules_mcu;
        }
        if (common.getSelfSysCfgCoreName().match(/a53*/))
        {
            topModules = topModules_a53;
        }
        if((common.getSelfSysCfgCoreName().includes("pru"))){ 
            if((!common.getSelfSysCfgCoreName().includes("tx")) && (!common.getSelfSysCfgCoreName().includes("rtu"))){
                topModules = topModules_pru;
            }
            else
            {
                topModules = topModules_rtu_tx_pru; 
            }
        }
        
        return topModules;
    },
    
    getViews: function(){
        if((common.getSelfSysCfgCoreName().includes("pru"))){ 
            return [
                {
                    name: "/pru_blocks/common/pru_register_allocation_summary",
                    displayName: "PRU register allocation summary",
                    viewType: "markdown",
                    icon: "state-machine",
                },
                {
                    name: "/pru_blocks/common/pru_pin_usage_summary",
                    displayName: "PRU pin usage summary",
                    viewType: "markdown",
                    icon: "chip",
                }
            ];
        }
    }
};