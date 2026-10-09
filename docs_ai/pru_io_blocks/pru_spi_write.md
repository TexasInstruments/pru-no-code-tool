## PRU SPI Write Block

### Purpose
Implements SPI (Serial Peripheral Interface) protocol to write data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins.

### How It Works

**Controller Mode:**
1. **Connect Input**: Connect data source to input port
2. **Configure Pins**: Select SCLK (clock output), SDO (data output), and CS (chip select output) pins
3. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
4. **Execute**: Generates bit-banged SPI write sequence with proper timing

**Peripheral Mode:**
1. **Connect Input**: Connect data source to input port
2. **Configure Pins**: Select SCLK (clock input), SDO (data output), and CS (chip select input) pins
3. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
4. **Execute**: Waits for CS assertion and controller clock, then writes data

### SPI Protocol
SPI is a synchronous serial communication protocol with:
- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
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

**Packet Size**: Number of bits to write (8-32)
- 8 bits = 1 byte (most common)
- 16 bits = 2 bytes
- 32 bits = 4 bytes (maximum)

**Endianness**: Bit order
- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
- **Least significant bit first** (LSB): Bit 0 → bit 7

**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

**SDO Signal**: Select PRU_GPO pin for data output

### Clock Timing (Controller Mode Only)
- **SCLK High Width**: PRU cycles clock stays HIGH
- **SCLK Low Width**: PRU cycles clock stays LOW
- **Cycle Period**: Depends on PRU Clock Frequency (should be configured from R5F core and update same frequency in Simulation Settings to use while simulation)
- 200 MHz: 1 cycle = 5ns
- 250 MHz: 1 cycle = 4ns
- 333.333 MHz: 1 cycle = 3ns
- **Example** (at 333.333 MHz): High=7, Low=7 → 14 cycles per bit → ~23.8MHz SPI clock
- **Example** (at 200 MHz): High=7, Low=7 → 14 cycles per bit → ~14.3MHz SPI clock
- The **SPI Clock Frequency** field below automatically calculates the actual frequency based on your configured PRU clock
- Peripheral mode follows controller's clock timing

### Maximum Achievable Frequency
Different SPI modes have different minimum SCLK width requirements due to timing overhead.
Cycles per bit: **(4+d1) + (3+d2)**

**Theoretical Maximum (d1=0, d2=0 — controller overhead only):**
- **MODE0**: Min High=2, Min Low=6 → 200 MHz = 25.00 MHz | 333 MHz = 41.63 MHz (Total: 8 cycles)
- **MODE1**: Min High=4, Min Low=3 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE2**: Min High=6, Min Low=1 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE3**: Min High=3, Min Low=4 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)

**Practical Maximum (d1=0, d2=1 — recommended for reliable operation):**
- All modes: Min High+Low = 8 cycles → **200 MHz = 25.00 MHz** | **333 MHz = 41.63 MHz**

**Note**: Theoretical maximums assume ideal peripheral response. Practical values (d1=0, d2=1) are recommended for reliable operation and are validated against the open-pru SPI slave macros. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. Always verify with oscilloscope and increase pulse widths if data corruption occurs.

### Setup and Hold Times (Controller Mode Only)

![](../.metadata/sysconfig/.meta/images/setup_and_hold_time.png)

- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
- **Data Setup Time**: Minimum time (in nanoseconds) data must be stable before the sampling clock edge. Automatically converted to PRU cycles internally using Math.ceil.

**Note**: CS Setup Time, CS Hold Time, and Data Setup Time are all specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

### Peripheral Mode Parameters
- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

### Technical Details  (Additional Information)

**Performance**:
- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold

### SPI Communication
**Typical SPI Transaction**:
1. Controller asserts CS (waits CS Setup Time)
2. Controller outputs data bit on SDO (waits Data Setup Time)
3. Controller generates clock pulse on SCLK
4. Peripheral device samples SDO on clock edge
5. Repeat for all bits in packet
6. Controller waits CS Hold Time, then deasserts CS

### Usage Notes
- No hardware SPI - uses GPIO bit-banging for flexibility
- Clock timing directly controls SPI speed
- MODE2 and MODE3 initialize SCLK to HIGH (idle state) before asserting CS
- Setup and hold times should match peripheral device datasheet requirements
- Data input must be connected to this block
- Ensure peripheral device supports the configured SPI mode and speed
- Physical pins must be configured via pin mux
- This is a **terminating block** - no output connections

### Simulation

The SPI Write block generates output signals (SCLK, SDO, CS) that can be viewed in the simulation waveform:

1. **Configure Simulation Settings**: Navigate to the Simulation Settings module
2. **Select Output Signals**: In "Select R30 (Output) Signals", select the pins configured for SCLK, SDO, and CS
3. **Set Cycle Count**: Ensure "Number Of PRU Cycles To Simulate" covers your entire SPI transaction
4. **Run Simulation**: View the generated waveforms to verify timing and data output

**Peripheral Mode Simulation:**
When using Peripheral mode, you need to simulate the controller's SCLK and CS signals:
1. Select the SCLK and CS pins in "Select R31 (Input) Signals"
2. Configure a clock pattern for SCLK using Pattern Mode
3. Configure CS assertion timing using Timestamp Mode
4. The PRU will respond to these simulated inputs by outputting data on SDO

**Example - Simulating controller clock for Peripheral mode:**
```
SCLK Pin - Pattern Mode:
Bit Pattern: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]  (7 LOW, 7 HIGH)
Pattern Start Cycle: 100
Repeat Count: 8 (for 8 bits)

CS Pin - Timestamp Mode:
Input Cycles: [50, 250]
Input Values: [0, 1]  (Assert at cycle 50, deassert at cycle 250)
```

### Terminology
- **SPI**: Serial Peripheral Interface - synchronous serial protocol
- **Bit-banging**: Software-controlled pin toggling to implement protocols
- **SCLK**: Serial Clock - timing signal for synchronization
- **SDO**: Serial Data Out - data from controller to peripheral
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

This section describes how to programmatically configure the SPI Write block in a .syscfg file.

### Adding a SPI Write Instance

\`\`\`javascript
const pru_spi_write = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_write", {}, false);
const spi_write1 = pru_spi_write.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE1" | Clock polarity and phase |
| packetSize | Integer | 8-32 | 8 | Number of bits to write |
| Endiness | String | "most significant bit first", "least significant bit first" | "least significant bit first" | Bit order |
| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
| SDO Signal | String | "0"-"19" | "1" | GPIO pin for data output |
| CS Signal | String | "0"-"19" | "2" | GPIO pin for chip select |
| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock high time (Controller only) |
| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
| CS Setup Time | Integer | 0-10000 | 10 | CS setup time in nanoseconds (Controller only) |
| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
| Data Setup Time | Integer | 0-10000 | 0 | Data setup time in nanoseconds, converted to PRU cycles internally (Controller only) |
| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |

### Example Configurations

**SPI Controller Write, MODE1, 8-bit, LSB first:**
\`\`\`javascript
spi_write1.$name = "SPI_Write_0";
spi_write1["Device Mode"] = "controller";
spi_write1["SPI Mode"] = "MODE1";
spi_write1.packetSize = 8;
spi_write1["Endiness"] = "least significant bit first";
spi_write1["SCLK Signal"] = "0";
spi_write1["SDO Signal"] = "1";
spi_write1["CS Signal"] = "2";
spi_write1["sclk high pulse width (in PRU cycles)"] = 7;
spi_write1["sclk low pulse width (in PRU cycles)"] = 7;
spi_write1["CS Setup Time"] = 10;
spi_write1["CS Hold Time"] = 10;
\`\`\`

**SPI Peripheral Write, MODE0, 32-bit, MSB first:**
\`\`\`javascript
spi_write1.$name = "SPI_Peripheral_Write";
spi_write1["Device Mode"] = "peripheral";
spi_write1["SPI Mode"] = "MODE0";
spi_write1.packetSize = 32;
spi_write1["Endiness"] = "most significant bit first";
spi_write1["SCLK Signal"] = "4";         // Input pin for clock
spi_write1["SDO Signal"] = "5";          // Output pin for data
spi_write1["CS Signal"] = "6";           // Input pin for CS
spi_write1["CS Filter Cycles"] = 2;
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect data source to SPI Write input (data to transmit)
scripting.connect(load_constant1, "output1", spi_write1, "input1");

// Connect control flow
scripting.connect(prev_block, "next", spi_write1, "prev");
scripting.connect(spi_write1, "next", next_block, "prev");
\`\`\`

### Important Notes

1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI). SDO is always output (GPO).

2. **Pin Uniqueness**: All three signals (CS, SCLK, SDO) must use different GPIO pins.

3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	- MODE0: Min High=2, Min Low=6
	- MODE1: Min High=4, Min Low=3
	- MODE2: Min High=6, Min Low=1
	- MODE3: Min High=3, Min Low=4

4. **Input Required**: This block requires a data input connection. Connect a Load Constant block or other data source to input1.

5. **Write-Only Operation**: This block only writes data to the SPI bus. Use SPI Read or SPI Transfer for receiving data.