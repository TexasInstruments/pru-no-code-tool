include ../imports.mak

SUBDIRS := \
    empty \
	SPI_loopback \
	UART_CRC \

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
