include ../imports.mak

SUBDIRS := \
    empty \
	spi_loopback \
	uart_crc \
	conditional \
	gray_encoder_4_bit \
	incremental_spi \
	tamagawa_single_channel \
	spi_10mhz \

# "make" or "make all" builds projects that match $(DEVICE) set in imports.mak
all: ARGUMENTS = all
all: $(SUBDIRS)

pru: ARGUMENTS = pru
pru: $(SUBDIRS)

host: ARGUMENTS = host
host: $(SUBDIRS)

# "make clean" cleans projects that match $(DEVICE) set in imports.mak
clean: ARGUMENTS = clean
clean: $(SUBDIRS)

$(SUBDIRS):
	$(MAKE) -C $@ $(ARGUMENTS)

.PHONY: all clean pru host $(SUBDIRS)
