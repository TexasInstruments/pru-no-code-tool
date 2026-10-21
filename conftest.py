"""Repository-wide pytest hooks.

Tests that run firmware on TI pru-simulator need a checkout of it (PRU_SIMULATOR_PATH or tools/pru-simulator-upstream).
Without one they are reported as SKIPPED with the reason, not as failures, so a CI runner without the simulator stays
green and still shows what was not run. The same applies when the checkout is an older revision that does not yet
have a device model package a test imports (pru_io.<model>): the test is SKIPPED naming the missing module.
"""
import re

import pytest

_MISSING_MODEL = re.compile(r"No module named '(pru_io\.[A-Za-z0-9_]+)'")


def _missing_simulator(exc):
    return type(exc).__name__ == "SimulatorNotFound"


def _missing_device_model(exc):
    """The pru_io.<model> module the simulator checkout lacks, or None."""
    if isinstance(exc, ModuleNotFoundError) and (exc.name or "").startswith("pru_io."):
        return exc.name
    while exc is not None:
        m = _MISSING_MODEL.search(str(exc))
        if m:
            return m.group(1)
        exc = exc.__cause__ or exc.__context__
    return None


def _skip_if_missing_simulator(outcome):
    exc = outcome.excinfo[1] if outcome.excinfo else None
    if exc is not None and _missing_simulator(exc):
        outcome.force_exception(pytest.skip.Exception("TI pru-simulator not available: " + str(exc).split(";")[0],
                                                      _use_item_location=True))
        return
    model = _missing_device_model(exc) if exc is not None else None
    if model:
        outcome.force_exception(pytest.skip.Exception("TI pru-simulator checkout has no device model " + model,
                                                      _use_item_location=True))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    outcome = yield
    _skip_if_missing_simulator(outcome)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    outcome = yield
    _skip_if_missing_simulator(outcome)
