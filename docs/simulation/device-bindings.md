# Device bindings: two ways to attach a simulated device

A *device binding* tells TI pru-simulator which behavioural model to attach to the PRU's pins when it runs your firmware (`gmake sim`, or **Run on TI pru-simulator** in the GUI). The binding travels in `pru_device_bindings.json`, which `make` extracts from the generated `pru_syscfg.asm`. One consumer, `scripts/sim/device_bindings.py`, reads it, whichever way the binding was written.

There are two sources. **Both are supported; neither replaces the other; nothing is migrated** (decision on, option 1).

| | GPI device fields | Device Model block |
| --- | --- | --- |
| Where | Simulation Settings, per pin: *GPIn Input Mode = Device*, *Device*, *Clock/B Pin*, *Index/Z Pin*, *Parameters* | A block in the graph: `/pru_blocks/utils/device_model_block` (UTILS) |
| Visible in the design | A row of fields inside Simulation Settings | A named block with its kind, its pins and what reads it |
| Parameters | A JSON string, checked when the model is built | Typed fields, range-checked in the GUI |
| Pins | The selected GPI pin is the device's primary pin; companions in two fields | Every pin is its own labelled field, marked *device drives* or *PRU drives* |
| In-tool JavaScript preview | Attached (kinds that are ported) | Not attached; TI pru-simulator is the evidence |

## A pin claimed by both sources is an error

If a Device Model block and a GPI device claim the same pin - the primary pin or any companion - SysConfig reports an ERROR on the block that names both:

```text
Pin 1 is claimed by Device Model 'Encoder_Model' (ssi, DATA pin) and by the Simulation Settings GPI1 device (ssi, primary pin). A pin cannot have two device sources: remove one of them.
```

Two Device Model blocks on one pin are refused the same way, naming both blocks. Two models on one net is a short, not a configuration.

### Shared clock between two Device Model blocks

Any pin counts, companion pins included: two blocks whose CLK (or other companion) pins coincide, or one block's clock against another's data pin, are refused. Two SSI/BiSS devices on one PRU-driven clock can be legal wiring on a real board (one CLK fanned out to two encoders), but the simulator cannot represent it: `pru_device_bindings.json` and `run_bound_devices` attach **one model per pin**, and the firmware would need to read two data lines on one clock. So it stays an ERROR for now - the conservative choice, since nothing here can prove the fan-out case - and the message says so:

```
Pin 0 is claimed by Device Model 'First_Model' (ssi, CLK pin) and by Device Model 'Second_Model' (ssi, CLK pin). Two models on one net is a short, not a configuration; shared clock between device models is not supported by the simulator yet.
```

Fan-out is not implemented. `tests/test_device_model_companion_conflicts.py` pins the behaviour, including a mutant (limit the other block's claim to its primary pin) that turns it red.

## The same design either way gives the same manifest

A design written with the GPI fields and the same design written with a Device Model block produce a byte-identical manifest, with one documented difference: the block states **every** parameter of its kind (the model's own defaults included), while the GPI JSON lists only what you typed. The extra keys are the model's defaults, so the attached model is the same. A design with no Device Model block produces exactly the manifest it always did.

`tests/test_device_model.py` proves this against the real SysConfig CLI for `ssi`, `bissc` and `uart`.

## Kinds, pins and parameters

Every kind `scripts/sim/device_bindings.py` can build is available: `quadrature`, `ssi`, `bissc`, `bissline`, `endat`, `tca9538`, `uart`, `sigma_delta`, `spi_adc`, `step_dir`, `ws2812`, `mdio_phy`. For each, the block shows which pins the device drives (the PRU reads them) and which the PRU drives (the device only listens). `step_dir` and `ws2812` are PRU-output-only and drive nothing.

Parameters are typed fields named `<kind>_<parameter>` (for example `ssi_bits`, `ssi_position`, `bissc_positionBits`). A parameter the block does not expose keeps the model's own default: the BiSS-C encoder keywords, the SSI and EnDat initial clock level, the MDIO register map, the BiSS Line sensor data. Use the GPI Parameters JSON when you need one of those.

A UART payload is entered as comma-separated bytes (`65, 0x42, 67`); an empty payload keeps the model's default.

## Which block reads the device

For `ssi` and `bissc`, the block's **Read by** field names the initiator block whose DATA pin is the device's data pin. The manifest records the same blocks, with the register the allocator gave their result, so `gmake sim` compares the right register. Other kinds report *NOT CHECKED*; no block in this tool decodes them.

## Example

`examples/ssi_device_model_sim` attaches its SSI encoder only through the block (Simulation Settings carries no device fields): `gmake all`, then `gmake sim`, ends in `Firmware decoded R0: 4321; model position: 4321` and `RESULT: PASS`.
