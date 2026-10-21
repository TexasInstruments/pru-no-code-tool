from abc import ABC, abstractmethod
from typing import List, Dict, Any

class DeviceModel(ABC):
    @abstractmethod
    def tick(self, cycle: int, pins_out: int) -> int:
        pass

    @abstractmethod
    def events(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def faults(self) -> List[str]:
        pass
