export PRU_NO_CODE_TOOL_PATH?=$(abspath ../../../../../..)
include $(PRU_NO_CODE_TOOL_PATH)/imports.mak

# Define build outputs
OUTPUT_NAME := ssi_device_model_sim_am243x-lp_icss_g0_pru0_fw

# MCU+ projects: rename & move hex array output
MCU_HEX_NAME := pru0_load_bin.h
HEX_ARRAY_PREFIX := PRU0Firmware
MCU_HEX_PATH := $(abspath ../..)/$(MCU_HEX_NAME)

# which directories to search for assembly & C source files?
FILES_PATH := .. ../../.. . syscfg/

# Linker command file
COMMAND_FILES := linker.cmd

# Silicon version (3: PRUSS, PRU-ICSS; 4: PRU_ICSSG)
PRU_VERSION := 4
EXPECTED_DEVICE := am243x

# Default values are defined in pru_rules.mak:
#   - include paths (INCLUDE)
#   - compiler flags (CFLAGS)
#   - linker flags (LFLAGS)

# Optional:
# Pre-define here to override default value
#   OPT_LEVEL, STACK_SIZE, HEAP_SIZE, or ENTRY_POINT

# pru_rules.mak has shared settings for all PRU/RTU/TX_PRU core makefiles
include $(PRU_NO_CODE_TOOL_PATH)/pru_rules.mak

# Optional:
# Append values to INCLUDE, CFLAGS, or LFLAGS here.
# Values can be appended like this:
# INCLUDE += --include_path=<value>

# Defines (pass instance specific definitions to the program)
# see --define or -D in 'PRU Optimizing C/C++ Compiler User's Guide'
# For example, to define PRU0, ICSSG1, SOC_AM243X, and set _DEBUG_=1:
# -DPRU0 -DICSSG1 --define=SOC_AM243X -D_DEBUG_=1
DFLAGS :=

# Libraries
# see --library in 'PRU Optimizing C/C++ Compiler User's Guide'
LIBS :=

syscfg: ../example.syscfg
	@echo Generating SysConfig files ...
	$(SYSCFG_NODE) $(SYSCFG_CLI_PATH)/dist/cli.js --product $(SYSCFG_PRU_NO_TOOL_PRODUCT) --device AM243x_ALX_beta --context icss_g0_pru0 --part ALX --package ALX --output syscfg/ ../example.syscfg

syscfg-gui:
	$(SYSCFG_NWJS) $(SYSCFG_PATH)/app --product $(SYSCFG_PRU_NO_TOOL_PRODUCT) --device AM243x_ALX_beta --context icss_g0_pru0 --part ALX --package ALX --output syscfg/  ../example.syscfg



$(GEN_DIR)/pru_syscfg.obj: syscfg/pru_syscfg.inc

# Re-evaluate generated include timestamps after SysConfig has refreshed them.
sim: syscfg
	$(MAKE) $(TARGET)
	python $(PRU_NO_CODE_TOOL_PATH)/scripts/sim/extract_device_bindings.py syscfg/pru_syscfg.asm syscfg/pru_device_bindings.json
	python $(PRU_NO_CODE_TOOL_PATH)/scripts/sim/run_bound_devices.py $(TARGET) syscfg/pru_device_bindings.json --vcd syscfg/ssi_device_model_waveform.vcd

# The same run with a browser dashboard on it. Depends on sim so the
# verdict exists first. Needs fastapi + uvicorn (TI pru-simulator requirements).
live: sim
	python $(PRU_NO_CODE_TOOL_PATH)/scripts/sim/live_view.py $(TARGET) syscfg/pru_device_bindings.json
