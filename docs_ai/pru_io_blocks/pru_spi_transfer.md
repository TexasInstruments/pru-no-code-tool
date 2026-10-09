## PRU SPI Transfer Block

### Purpose
Implements full-duplex SPI (Serial Peripheral Interface) transfer operation in both Controller and Peripheral modes using bit-banging on PRU GPIO pins. This block simultaneously sends and receives data in a single transaction.

### How It Works

**Controller Mode:**
1. **Connect Input**: Connect data source to input port (data to transmit)
2. **Configure Pins**: Select SCLK (clock output), SDI (data input), SDO (data output), and CS (chip select output) pins
3. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
4. **Execute**: Generates bit-banged SPI transfer sequence with concurrent read and write
5. **Output**: Provides received data to the next block

**Peripheral Mode:**
1. **Connect Input**: Connect data source to input port (data to transmit)
2. **Configure Pins**: Select SCLK (clock input), SDI (data input), SDO (data output), and CS (chip select input) pins
3. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
4. **Execute**: Waits for CS assertion and controller clock, then simultaneously reads and writes data
5. **Output**: Provides received data to the next block

### SPI Protocol
SPI is a synchronous serial communication protocol with:
- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
- **SDI (Serial Data In)**: Data line from device to PRU
- **SDO (Serial Data Out)**: Data line from PRU to device
- **CS (Chip Select)**: Activates the peripheral device (active low)
- **Modes**: Determines clock polarity (CPOL) and phase (CPHA)

### Configuration Parameters

**Device Mode**: Select Controller or Peripheral operation mode

**SPI Mode**: Select MODE0-3 based on clock polarity and phase
- **MODE0** (CPOL=0, CPHA=0): Clock idles low, data sampled on rising edge, shifted on falling edge
- **MODE1** (CPOL=0, CPHA=1): Clock idles low, data sampled on falling edge, shifted on rising edge
- **MODE2** (CPOL=1, CPHA=0): Clock idles high, data sampled on falling edge, shifted on rising edge
- **MODE3** (CPOL=1, CPHA=1): Clock idles high, data sampled on rising edge, shifted on falling edge

**Packet Size**: Number of bits to transfer (8-32)
- 8 bits = 1 byte (most common)
- 16 bits = 2 bytes
- 32 bits = 4 bytes (maximum)

**Endianness**: Bit order
- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
- **Least significant bit first** (LSB): Bit 0 → bit 7

**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

**SDI Signal**: Select PRU_GPI pin for data input (receive from device)

**SDO Signal**: Select PRU_GPO pin for data output (transmit to device)

### Clock Timing (Controller Mode Only)
- **SCLK High Width**: PRU cycles clock stays HIGH
- **SCLK Low Width**: PRU cycles clock stays LOW
- **Cycle Period**: Depends on PRU Clock Frequency(should be configured from R5F core and update same frequency in Simulation Settings to use while simulation)
- 200 MHz: 1 cycle = 5ns
- 250 MHz: 1 cycle = 4ns
- 333.333 MHz: 1 cycle = 3ns
- **Example** (at 333.333 MHz): High=13, Low=13 → 26 cycles per bit → ~12.8MHz SPI clock
- **Example** (at 200 MHz): High=13, Low=13 → 26 cycles per bit → ~7.69MHz SPI clock
- The **SPI Clock Frequency** field below automatically calculates the actual frequency based on your configured PRU clock
- Peripheral mode follows controller's clock timing
- **Important**: Timing margins must be sufficient for peripheral response time. Increase pulse widths if data transfer is unreliable.

### Maximum Achievable Frequency
Different SPI modes have different minimum SCLK width requirements due to timing overhead.
Cycles per bit: **(4+d1) + (6+d2)**

**Theoretical Maximum (d1=0, d2=0 — controller overhead only):**
- **MODE0**: Min High=4, Min Low=6 → 200 MHz = 20.00 MHz | 333 MHz = 33.30 MHz (Total: 10 cycles)
- **MODE1**: Min High=2, Min Low=6 → 200 MHz = 25.00 MHz | 333 MHz = 41.63 MHz (Total: 8 cycles)
- **MODE2**: Min High=6, Min Low=4 → 200 MHz = 20.00 MHz | 333 MHz = 33.30 MHz (Total: 10 cycles)
- **MODE3**: Min High=6, Min Low=2 → 200 MHz = 25.00 MHz | 333 MHz = 41.63 MHz (Total: 8 cycles)

**Practical Maximum (d1=9, d2=7 — validated for PRU-to-PRU loopback):**
- All modes: Min High=13, Min Low=13 → **200 MHz = 7.69 MHz** | **333 MHz = 12.80 MHz**

**Note**: Theoretical maximums assume ideal hardware peripheral response. For full-duplex PRU-to-PRU loopback using the SPI slave macros, use the practical values (d1=9, d2=7) which are validated against the open-pru SPI slave macros. The practical limit exists because the software-polled slave needs ~13 cycles minimum in both the high and low phases to detect edges and process data. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. If receiving corrupted data, increase SCLK pulse widths beyond these minimums.

### Setup and Hold Times (Controller Mode Only)

![](../.metadata/sysconfig/.meta/images/setup_and_hold_time.png)

- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
- **Data Setup Time**: Minimum time (in nanoseconds) data must be stable before the sampling clock edge. Automatically converted to PRU cycles internally using Math.ceil.

**Note**: CS Setup Time, CS Hold Time, and Data Setup Time are all specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

### Peripheral Mode Parameters
- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

### Technical Details (Additional Information)

**Performance**:
- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold
- Full-duplex: Same cycles as half-duplex, but transfers both directions simultaneously

### SPI Communication
**Typical SPI Full-Duplex Transfer**:
1. Controller asserts CS (waits CS Setup Time)
2. Controller outputs data bit on SDO and generates clock edge
3. On the sampling clock edge:
- Peripheral samples controller's data on SDI
- Controller samples peripheral's data on SDI (concurrently)
4. Repeat for all bits in packet
5. Controller waits CS Hold Time, then deasserts CS

**Key Timing Consideration**:
In full-duplex mode, the peripheral must output its data quickly enough after detecting the shifting clock edge so the controller can sample it on the sampling edge. If timing is too tight, increase SCLK Low Width (MODE1/MODE3) or SCLK High Width (MODE0/MODE2) to give the peripheral more time to respond.

### Usage Notes
- No hardware SPI - uses GPIO bit-banging for flexibility
- Full-duplex transfers data in both directions simultaneously
- Clock timing directly controls SPI speed
- MODE2 and MODE3 initialize SCLK to HIGH (idle state) before asserting CS
- Setup and hold times should match peripheral device datasheet requirements
- Data input must be connected to this block for transmit data
- Output provides received data for further processing
- Ensure peripheral device supports the configured SPI mode and speed
- Physical pins must be configured via pin mux
- **Timing margins are critical**: If receiving incorrect data, increase SCLK pulse widths to give peripheral more response time

### Simulating Input Data

To test SPI Transfer without hardware, use the **Simulation Settings** module to simulate the SDI (Serial Data In) signal:

1. **Open Simulation Settings**: Navigate to the Simulation Settings module
2. **Select GPI Pin**: In "Select R31 (Input) Signals", select the pin configured as SDI Signal
3. **Configure Input Mode**: Choose Timestamp Mode or Pattern Mode
4. **Define Data Pattern**: Enter the bit values the PRU should receive from the simulated peripheral device

**Example - Simulating peripheral sending 0xC3 (11000011) with MODE3:**
```
Input Mode: Timestamp
Input Cycles: [120, 144, 168, 192, 216, 240, 264, 288]
Input Values: [1, 1, 0, 0, 0, 0, 1, 1]
```

### Terminology
- **SPI**: Serial Peripheral Interface - synchronous serial protocol
- **Bit-banging**: Software-controlled pin toggling to implement protocols
- **Full-duplex**: Simultaneous bidirectional data transfer
- **SCLK**: Serial Clock - timing signal for synchronization
- **SDI**: Serial Data In - data from peripheral to controller
- **SDO**: Serial Data Out - data from controller to peripheral
- **CS**: Chip Select - enables/disables peripheral device
- **MSB/LSB**: Most/Least Significant Bit - bit order
- **Endianness**: Order of bit/byte transmission
- **CPOL**: Clock Polarity - idle state of clock (0=LOW, 1=HIGH)
- **CPHA**: Clock Phase - which edge shifts data (0=first edge, 1=second edge)
- **Setup Time**: Minimum time data must be stable before clock edge
- **Hold Time**: Minimum time data must remain stable after clock edge
- **CS Setup Time**: Time between CS assertion and first clock edge
- **CS Hold Time**: Time between last clock edge and CS deassertion

---
 

## How to Configure (For AI/Scripting)

This section describes how to programmatically configure the SPI Transfer block in a .syscfg file.

### Adding a SPI Transfer Instance

```javascript
const pru_spi_transfer = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_transfer", {}, false);
const spi1 = pru_spi_transfer.addInstance();
```

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE3" | Clock polarity and phase |
| packetSize | Integer | 8-32 | 32 | Number of bits per transfer |
| Endiness | String | "most significant bit first", "least significant bit first" | "most significant bit first" | Bit order |
| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
| SDI Signal | String | "0"-"19" | "1" | GPIO pin for data input |
| SDO Signal | String | "0"-"19" | "2" | GPIO pin for data output |
| CS Signal | String | "0"-"19" | "3" | GPIO pin for chip select |
| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 9 | Clock high time (Controller only) |
| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
| CS Setup Time | Integer | 0-10000 | 35 | CS setup time in nanoseconds (Controller only) |
| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
| Data Setup Time | Integer | 0-10000 | 0 | Data setup time in nanoseconds, converted to PRU cycles internally (Controller only) |
| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |

### Example Configurations

**SPI Controller, MODE3, 8-bit, MSB first:**
```javascript
spi1.$name = "SPI_Controller_0";
spi1["Device Mode"] = "controller";
spi1["SPI Mode"] = "MODE3";
spi1.packetSize = 8;
spi1["Endiness"] = "most significant bit first";
spi1["SCLK Signal"] = "0";
spi1["SDI Signal"] = "1";
spi1["SDO Signal"] = "2";
spi1["CS Signal"] = "3";
spi1["sclk high pulse width (in PRU cycles)"] = 13;
spi1["sclk low pulse width (in PRU cycles)"] = 11;
spi1["CS Setup Time"] = 35;
spi1["CS Hold Time"] = 10;
```

**SPI Peripheral, MODE0, 32-bit, LSB first:**
```javascript
spi1.$name = "SPI_Peripheral_0";
spi1["Device Mode"] = "peripheral";
spi1["SPI Mode"] = "MODE0";
spi1.packetSize = 32;
spi1["Endiness"] = "least significant bit first";
spi1["SCLK Signal"] = "4";         // Input pin for clock
spi1["SDI Signal"] = "5";
spi1["SDO Signal"] = "6";
spi1["CS Signal"] = "7";           // Input pin for CS
spi1["CS Filter Cycles"] = 2;
```

### Connecting to Other Blocks

```javascript
// Connect data source to SPI input (data to transmit)
scripting.connect(load_constant1, "output1", spi1, "input1");

// Connect SPI output to downstream block (received data)
scripting.connect(spi1, "output1", process_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", spi1, "prev");
scripting.connect(spi1, "next", next_block, "prev");
```

### Important Notes

1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI).

2. **Pin Uniqueness**: All four signals (CS, SCLK, SDI, SDO) must use different GPIO pins.

3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	- MODE0: Min High=4, Min Low=6
	- MODE1: Min High=2, Min Low=6
	- MODE2: Min High=6, Min Low=4
	- MODE3: Min High=6, Min Low=2

4. **Full-Duplex Operation**: This block simultaneously sends and receives data. Connect both input (transmit data) and use output (receive data) for full-duplex communication.