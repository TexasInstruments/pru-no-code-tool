# MDIO Clause 22 master block (`mdio_master_block`). Bit-banged IEEE 802.3 Clause 22 (MII) PHY-management master on
two PRU pins: MDC (R30 clock, ≤ 2.5 MHz) and MDIO (R30 drive / R31
sample). For designs that must manage an Ethernet PHY on pins the MAC
does not own.

## Wire contract (the only behaviour the block implements)

| Field | Bits | Value |
|---|---|---|
| Preamble | 32 | all 1s (IEEE 802.3 22.2.4.5.1) |
| ST | 2 | `01` |
| OP | 2 | `01` write, `10` read (`00`/`11` illegal) |
| PHYAD | 5 | target PHY address, MSB first |
| REGAD | 5 | register address, MSB first |
| TA | 2 | write: master drives `10`; read: master releases, PHY drives `0` on the second bit |
| DATA | 16 | MSB first; read result lands in the data register |

MDC half period is `HALF_TRIPS` delay-loop trips (2 PRU cycles each plus a
fixed per-phase cost); validation refuses trip counts whose MDC high or low
phase is under 160 ns or whose period is under 400 ns (IEEE 802.3 22.2.2.11,
the 2.5 MHz ceiling) at the configured PRU clock. Slower is always legal.

## Configuration

| Parameter | Description |
|---|---|
| MDC R30 bit | clock pin |
| MDIO R30/R31 bit | data pin |
| PHY address | 0–31 (5-bit PHYAD) |
| Register address | 0–31 (5-bit REGAD) |
| Direction | read or write |
| MDC half-period delay trips | bounded by the 2.5 MHz ceiling |
| RX/TX data register | read result / write source |

In read mode the result is also exposed on `output1`, so it can be
wired to a downstream block.

## Verification

- Observed-line PHY model: `pru_device_models/mdio_phy_model.py` decodes the
  (MDC, MDIO) pins actually toggling — never a transmit buffer.
- Suite: `tests/test_mdio.py`: write/read control cases plus
  independent negative mutations for bit order, start/opcode, PHY and
  register addresses, turn-around, edge count, MDC speed and wire-level
  data corruption.
- Firmware arm: the emitted `m_mdio_xfer` macro is built with clpru and
  run closed-loop against the model where the toolchain is present
  (skips cleanly otherwise).

Vendor-specific MDIO behaviour (TI ICSS MDIO doorbell registers, driver
sequencing) is deliberately outside this block.
