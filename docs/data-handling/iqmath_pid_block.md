---

## IQMath PID Block

### Purpose

The IQMath PID block implements a discrete Proportional-Integral-Derivative (PID) controller utilizing fixed-point math. It is designed to close feedback control loops (such as position, speed, or current) on the PRU at high frequencies.

### Features

- Q12 fixed-point gain configuration ($K_p$, $K_i$, $K_d$)
- Uses the PRU broadside hardware MAC multiplier for fast scaling execution
- Stores error history and running integral state in Data RAM (DMEM)
- The default generated macro has a counted 50-cycle latency, including the three MAC operand-latency NOPs.

### Configuration

| Parameter | Description | Default | Options |
|-----------|-------------|---------|---------|
| $K_p$ | Proportional feedback gain constant (Q12 fixed-point) | `1.0` (4096) | Range: 0 to 16.0 |
| $K_i$ | Integral feedback gain constant (Q12 fixed-point) | `0.1` (410) | Range: 0 to 16.0 |
| $K_d$ | Derivative feedback gain constant (Q12 fixed-point) | `0.05` (205) | Range: 0 to 16.0 |
| State Variable Base | Memory offset base address for integral accumulation and error history storage | `0` | Any valid DMEM address |

### How It Works

The block compares the Setpoint input against the Feedback input to calculate the tracking Error:
$$\text{Error}_k = \text{Setpoint}_k - \text{Feedback}_k$$
It then calculates the PID output terms using truncating Q12 fixed-point arithmetic:
$$\text{Proportional} = \text{Error}_k \times K_p$$
$$\text{Integral} = \text{Integral}_{k-1} + (\text{Error}_k \times K_i)$$
$$\text{Derivative} = (\text{Error}_k - \text{Error}_{k-1}) \times K_d$$
$$\text{Output}_k = \text{Proportional} + \text{Integral} + \text{Derivative}$$
All state variables ($\text{Integral}$ and $\text{Error}_{k-1}$) are stored in DMEM and loaded/stored at each execution step.

### Important Notes

- PID coefficients are specified as fixed-point integers scaled by $2^{12}$ ($4096 = 1.0$).
- Ensure the state variable memory space is allocated uniquely to avoid crosstalk between multiple PID controllers.

### Example Usage

To implement a motor velocity control loop:
1. Connect target velocity (Setpoint) to `input1`.
2. Connect measured velocity from an encoder block (Feedback) to `input2`.
3. Configure the $K_p$, $K_i$, and $K_d$ gains via the SysConfig interface.
4. Connect the block's output directly to the input of a PWM or motor drive block.

---
