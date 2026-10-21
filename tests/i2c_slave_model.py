"""Open-drain I2C slave for the real-ELF tests.

The i2c_block master now samples the address ACK and leaves on a NACK, so a
bus that never pulls SDA low is no longer a valid read-frame partner. This
slave ACKs (or NACKs) the address byte and, for a read, shifts ``data`` out.
"""


class I2cSlave:
    """SDA line = master drive AND slave drive. START = SDA fall with SCL high.

    The START's own SCL fall is fall 1; the 8th address clock falls at 9, where
    the slave ACKs (pulls SDA low) or, with ``ack`` false, leaves SDA released.
    A read then shifts ``data`` out MSB first after falls 10..17.
    """

    def __init__(self, ack, read, scl=0, sda=1, data=0xA5):
        self.ack, self.read, self.scl, self.sda, self.data = ack, read, scl, sda, data
        self.scl_prev, self.sda_prev = 1, 1
        self.falls = None          # SCL falls since START; None before START
        self.slave_low = False

    def tick(self, _cycle, pins):
        """Advance on the master's R30 word; returns True while the slave pulls SDA low."""
        scl = (pins >> self.scl) & 1
        sda = ((pins >> self.sda) & 1) & (0 if self.slave_low else 1)
        if self.scl_prev and self.sda_prev and not sda and scl:
            self.falls = 0
        elif self.falls is not None and self.scl_prev and not scl:
            self.falls += 1
            n = self.falls
            if n == 9:
                self.slave_low = self.ack
            elif self.read and self.ack and 10 <= n <= 17:
                self.slave_low = not ((self.data >> (17 - n)) & 1)
            else:
                self.slave_low = False
        self.scl_prev, self.sda_prev = scl, sda
        return self.slave_low

    def gpi(self, cycle, pins):
        """GPI word for a bus where only this slave and the pull-ups drive SDA."""
        low = self.tick(cycle, pins)
        return 0xFFFFF & ~((1 << self.sda) if (low or not (pins >> self.sda) & 1) else 0)
