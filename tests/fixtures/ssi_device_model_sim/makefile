include ../../imports.mak

PROJECT_NAME := ssi_device_model_sim
FW_DIR := firmware/am243x-lp/icss_g0_pru0_fw/ti-pru-cgt

.PHONY: all sim live clean syscfg
all:
	$(MAKE) -C $(FW_DIR) all

sim:
	$(MAKE) -C $(FW_DIR) sim

live:
	$(MAKE) -C $(FW_DIR) live

syscfg:
	$(MAKE) -C $(FW_DIR) syscfg

clean:
	$(MAKE) -C $(FW_DIR) clean
