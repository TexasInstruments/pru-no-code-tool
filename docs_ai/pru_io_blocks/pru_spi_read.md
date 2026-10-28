## PRU SPI Read Block

### Purpose
Implements SPI (Serial Peripheral Interface) protocol to read data in both Controller and Peripheral modes using bit-banging on PRU GPIO pins.

### How It Works

**Controller Mode:**
1. **Configure Pins**: Select SCLK (clock output), SDI (data input), and CS (chip select output) pins
2. **Set Timing**: Configure clock pulse widths, setup/hold times, and packet size
3. **Execute**: Generates bit-banged SPI read sequence with proper timing
4. **Output**: Provides received data to the next block

**Peripheral Mode:**
1. **Configure Pins**: Select SCLK (clock input), SDI (data input), and CS (chip select input) pins
2. **Set Mode**: Configure SPI mode (MODE0-3), packet size, and CS filter cycles
3. **Execute**: Waits for CS assertion and controller clock, then reads data
4. **Output**: Provides received data to the next block

### SPI Protocol
SPI is a synchronous serial communication protocol with:
- **SCLK (Serial Clock)**: Clock signal (Controller generates, Peripheral follows)
- **SDI (Serial Data In)**: Data line from device to PRU
- **CS (Chip Select)**: Activates the peripheral device (active low)
- **Modes**: Determines clock polarity (CPOL) and phase (CPHA)

### Configuration Parameters

**Device Mode**: Select Controller or Peripheral operation mode

**SPI Mode**: Select MODE0-3 based on clock polarity and phase
- **MODE0** (CPOL=0, CPHA=0): Clock idles low, data sampled on rising edge, shifted on falling edge
- **MODE1** (CPOL=0, CPHA=1): Clock idles low, data sampled on falling edge, shifted on rising edge
- **MODE2** (CPOL=1, CPHA=0): Clock idles high, data sampled on falling edge, shifted on rising edge
- **MODE3** (CPOL=1, CPHA=1): Clock idles high, data sampled on rising edge, shifted on falling edge

**Packet Size**: Number of bits to read (8-32)
- 8 bits = 1 byte (most common)
- 16 bits = 2 bytes
- 32 bits = 4 bytes (maximum)

**Endianness**: Bit order
- **Most significant bit first** (MSB): Standard SPI, bit 7 → bit 0
- **Least significant bit first** (LSB): Bit 0 → bit 7

**CS Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for chip select

**SCLK Signal**: Select PRU_GPO (Controller) or PRU_GPI (Peripheral) pin for clock

**SDI Signal**: Select PRU_GPI pin for data input

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
Cycles per bit: **(2+d1) + (5+d2)**

**Theoretical Maximum (d1=0, d2=0 — controller overhead only):**
- **MODE0**: Min High=4, Min Low=3 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE1**: Min High=1, Min Low=6 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE2**: Min High=3, Min Low=4 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)
- **MODE3**: Min High=6, Min Low=1 → 200 MHz = 28.57 MHz | 333 MHz = 47.57 MHz (Total: 7 cycles)

**Practical Maximum (d1=10, d2=7 — recommended for reliable operation):**
- All modes: Min High+Low = 24 cycles → **200 MHz = 8.33 MHz** | **333 MHz = 13.88 MHz**

**Note**: Theoretical maximums assume ideal peripheral response. Practical values (d1=10, d2=7) are recommended for reliable operation and are validated against the open-pru SPI slave macros. Actual maximum frequency depends on peripheral device specifications, signal integrity, and PCB layout. Always verify with oscilloscope and increase pulse widths if data corruption occurs.

### Setup and Hold Times (Controller Mode Only)

- **CS Setup Time**: Time delay (in nanoseconds) after CS assertion before starting SPI transaction. This ensures the peripheral device is ready before data transfer begins.
- **CS Hold Time**: Time delay (in nanoseconds) after the last bit is transferred before CS deassertion. This ensures the peripheral device has latched the data properly.
- **Data Setup Time**: Minimum time (in nanoseconds) MISO data must be stable before the sampling clock edge. Nops are inserted before the sampling edge. Automatically converted to PRU cycles internally using Math.ceil.

**Note**: CS Setup Time, CS Hold Time, and Data Setup Time are all specified in **nanoseconds** and automatically converted to PRU cycles based on the PRU Clock Frequency configured in **Simulation Settings**. Ensure the PRU Clock Frequency matches your hardware configuration for accurate timing.

### Peripheral Mode Parameters
- **CS Filter Cycles**: Number of consecutive cycles CS must be stable to be considered valid. This provides glitch rejection for noisy CS signals.

### Technical Details (Additional Information)

**Performance**:
- Cycles per bit ≈ (high_width + low_width + data_setup_time + overhead)
- Total cycles ≈ CS_setup + (packet_size × cycles_per_bit) + CS_hold

### SPI Communication
**Typical SPI Transaction**:
1. Controller asserts CS (waits CS Setup Time)
2. Controller generates clock on SCLK
3. On each clock edge, peripheral outputs one bit on SDI
4. PRU samples SDI after Data Setup Time and stores the bit
5. Repeat for all bits in packet
6. Controller waits CS Hold Time, then deasserts CS

### Usage Notes
- No hardware SPI - uses GPIO bit-banging for flexibility
- Clock timing directly controls SPI speed
- Setup and hold times should match peripheral device datasheet requirements
- Ensure peripheral device supports the configured SPI mode and speed
- Physical pins must be configured via pin mux

### Simulating Input Data

To test SPI Read without hardware, use the **Simulation Settings** module to simulate the SDI (Serial Data In) signal:

1. **Open Simulation Settings**: Navigate to the Simulation Settings module
2. **Select GPI Pin**: In "Select R31 (Input) Signals", select the pin configured as SDI Signal
3. **Configure Input Mode**: Choose Timestamp Mode or Pattern Mode
4. **Define Data Pattern**: Enter the bit values the PRU should receive

**Example - Simulating 0xA5 (10100101) with MODE1:**
```
Input Mode: Timestamp
Input Cycles: [100, 107, 114, 121, 128, 135, 142, 149]
Input Values: [1, 0, 1, 0, 0, 1, 0, 1]
```

**Timing Calculation:**
- CS Setup Time determines when the first clock edge occurs
- For SCLK high=7, low=7: each bit period = 14 cycles
- MODE1 samples on falling edge: set data before the falling edge
- Align your input transitions with the expected sample points

**Viewing Results:**
- The simulation waveform shows both SCLK (output) and SDI (input)
- Verify that data transitions align with the correct clock edges
- Check the received data register value in the **PRU register allocation summary** view under **SIMULATION RESULTS**

---

### How to Verify Simulation Results

After running simulation:

1. Open the **PRU register allocation summary** view
2. Look for the **SIMULATION RESULTS** section at the bottom
3. Find your SPI Read block and verify the simulated value

---

### Tips for Creating Custom Patterns

1. **Always observe your actual waveform first**: Your actual SCLK timing depends on:
- Where the SPI Read block is placed in your flow
- Blocks executed before it (they consume cycles)
- Your specific timing configuration

2. **Start with all 1s or all 0s**: Set `Input Cycles: [1]`, `Input Values: [1]` or `[0]` with Repeat Last Bit enabled to verify you can receive constant data

3. **Identify exact sample points from waveform**:
- Run simulation with the above constant pattern
- Look at the SCLK waveform to see when clock edges occur
- Note the cycle numbers of the sampling edges for your mode:
	- MODE0: Rising edges
	- MODE1: Falling edges
	- MODE2: Falling edges
	- MODE3: Rising edges

4. **Set SDI transitions BEFORE sample points**: Once you know when sampling occurs (e.g., cycles 50, 60, 70...), set your SDI transitions a few cycles earlier (e.g., cycles 48, 58, 68...)

5. **Use the mode's sampling edge**:
- MODE0/MODE2: Sample on the first clock edge after the idle state changes
- MODE1/MODE3: Sample on the second clock edge

6. **Verify incrementally**: If the full byte isn't working, test one bit at a time to identify timing issues

### Terminology
- **SPI**: Serial Peripheral Interface - synchronous serial protocol
- **Bit-banging**: Software-controlled pin toggling to implement protocols
- **SCLK**: Serial Clock - timing signal for synchronization
- **SDI**: Serial Data In - data from peripheral to controller
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

This section describes how to programmatically configure the SPI Read block in a .syscfg file.

### Adding a SPI Read Instance

\`\`\`javascript
const pru_spi_read = scripting.addModule("/pru_blocks/pru_io_blocks/pru_spi_read", {}, false);
const spi_read1 = pru_spi_read.addInstance();
\`\`\`

### Configuration Parameters

| Parameter | Type | Valid Values | Default | Description |
|-----------|------|--------------|---------|-------------|
| Device Mode | String | "controller", "peripheral" | "controller" | SPI role selection |
| SPI Mode | String | "MODE0", "MODE1", "MODE2", "MODE3" | "MODE1" | Clock polarity and phase |
| packetSize | Integer | 8-32 | 8 | Number of bits to read |
| Endiness | String | "most significant bit first", "least significant bit first" | "least significant bit first" | Bit order |
| SCLK Signal | String | "0"-"19" | "0" | GPIO pin for clock |
| SDI Signal | String | "0"-"19" | "1" | GPIO pin for data input |
| CS Signal | String | "0"-"19" | "2" | GPIO pin for chip select |
| sclk high pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock high time (Controller only) |
| sclk low pulse width (in PRU cycles) | Integer | 1-0xFFFFFFFF | 7 | Clock low time (Controller only) |
| CS Setup Time | Integer | 0-10000 | 35 | CS setup time in nanoseconds (Controller only) |
| CS Hold Time | Integer | 0-10000 | 10 | CS hold time in nanoseconds (Controller only) |
| Data Setup Time | Integer | 0-10000 | 0 | Data setup time in nanoseconds, converted to PRU cycles internally (Controller only) |
| CS Filter Cycles | Integer | 1-0xFFFFFFFF | 2 | CS glitch filter cycles (Peripheral only) |

### Example Configurations

**SPI Controller Read, MODE1, 8-bit, LSB first:**
\`\`\`javascript
spi_read1.$name = "SPI_Read_0";
spi_read1["Device Mode"] = "controller";
spi_read1["SPI Mode"] = "MODE1";
spi_read1.packetSize = 8;
spi_read1["Endiness"] = "least significant bit first";
spi_read1["SCLK Signal"] = "0";
spi_read1["SDI Signal"] = "1";
spi_read1["CS Signal"] = "2";
spi_read1["sclk high pulse width (in PRU cycles)"] = 7;
spi_read1["sclk low pulse width (in PRU cycles)"] = 7;
spi_read1["CS Setup Time"] = 35;
spi_read1["CS Hold Time"] = 10;
\`\`\`

**SPI Peripheral Read, MODE3, 16-bit, MSB first:**
\`\`\`javascript
spi_read1.$name = "SPI_Peripheral_Read";
spi_read1["Device Mode"] = "peripheral";
spi_read1["SPI Mode"] = "MODE3";
spi_read1.packetSize = 16;
spi_read1["Endiness"] = "most significant bit first";
spi_read1["SCLK Signal"] = "4";         // Input pin for clock
spi_read1["SDI Signal"] = "5";
spi_read1["CS Signal"] = "6";           // Input pin for CS
spi_read1["CS Filter Cycles"] = 2;
\`\`\`

### Connecting to Other Blocks

\`\`\`javascript
// Connect SPI Read output to downstream processing block
scripting.connect(spi_read1, "output1", process_block, "input1");

// Connect control flow
scripting.connect(prev_block, "next", spi_read1, "prev");
scripting.connect(spi_read1, "next", next_block, "prev");
\`\`\`

### Important Notes

1. **Pin Assignment**: In Controller mode, SCLK and CS are outputs (GPO). In Peripheral mode, SCLK and CS are inputs (GPI). SDI is always input (GPI).

2. **Pin Uniqueness**: All three signals (CS, SCLK, SDI) must use different GPIO pins.

3. **Minimum Pulse Widths** (Controller mode, per SPI mode):
	- MODE0: Min High=4, Min Low=3
	- MODE1: Min High=1, Min Low=6
	- MODE2: Min High=3, Min Low=4
	- MODE3: Min High=6, Min Low=1

4. **Read-Only Operation**: This block only reads data from the SPI bus. Use SPI Write or SPI Transfer for sending data.