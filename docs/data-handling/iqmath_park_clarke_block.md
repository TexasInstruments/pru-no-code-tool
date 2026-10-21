---

## IQMath Park/Clarke Transform Block

### Purpose

The IQMath Park/Clarke block performs reference frame transformations essential for Field-Oriented Control (FOC) of 3-phase AC motors. It translates physical stator frame current/voltage vectors to rotor rotating orthogonal vectors, and vice versa.

### Features

- Supports both Forward transform (Clarke and Park) and Inverse transform (Inverse Park and Clarke) modes
- High-performance, cycle-accurate implementation using PRU ALU bit-shifts and additions
- Employs a pre-calculated 256-entry sine lookup table (`sine_lut`) in PRU memory
- Emits optimized assemblies executing in exactly 25 cycles (Forward) or 30 cycles (Inverse)

### Configuration

| Parameter | Description | Options |
|-----------|-------------|---------|
| Transform Type | The direction of vector calculation | `Forward`, `Inverse` |
| Number of Cycles | The execution cycle constraint checked by the compiler | Default: `25` |

### How It Works

#### Forward Mode
1. **Clarke Transform**: Translates 3-phase phase currents ($I_a$, $I_b$) to orthogonal static current components ($I_\alpha$, $I_\beta$):
   $$I_\alpha = I_a$$
   $$I_\beta = \frac{I_a + 2I_b}{\sqrt{3}} \approx (I_a + 2I_b) \times 0.57735$$
2. **Park Transform**: Rotates the static frame components ($I_\alpha$, $I_\beta$) to the rotating d/q reference frame ($I_d$, $I_q$) using the rotor angle $\theta$:
   $$I_d = I_\alpha\cos(\theta) + I_\beta\sin(\theta)$$
   $$I_q = -I_\alpha\sin(\theta) + I_\beta\cos(\theta)$$

#### Inverse Mode
1. **Inverse Park Transform**: Translates rotating voltages ($V_d$, $V_q$) back to static orthogonal components ($V_\alpha$, $V_\beta$):
   $$V_\alpha = V_d\cos(\theta) - V_q\sin(\theta)$$
   $$V_\beta = V_d\sin(\theta) + V_q\cos(\theta)$$
2. **Inverse Clarke Transform**: Projects the static components to 3-phase outputs ($V_a$, $V_b$, $V_c$):
   $$V_a = V_\alpha$$
   $$V_b = -\frac{1}{2}V_\alpha + \frac{\sqrt{3}}{2}V_\beta$$
   $$V_c = -V_a - V_b$$

### Important Notes

- Truncating Q12 fixed-point math is used. Inputs and outputs are scaled by $2^{12}$ (e.g. $4096 = 1.0$).
- Trigonometric lookup utilizes a 256-entry table where the index represents angle $\theta \in [0, 255]$ mapping to $[0, 2\pi]$.

### Example Usage

Within an FOC control loop:
1. Feed current sensor measurements ($I_a$, $I_b$) to `input1` and `input2` of a Forward Park/Clarke block.
2. Connect rotor angle $\theta$ (e.g., from an encoder block) to `input4`.
3. Route the output $I_d$ and $I_q$ currents to D-axis and Q-axis PID controllers.

---
