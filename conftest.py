"""Repository-wide pytest hooks.

Tests that run firmware on TI pru-simulator need a checkout of it (PRU_SIMULATOR_PATH or tools/pru-simulator-upstream).
Without one they are reported as SKIPPED with the reason, not as failures, so a CI runner without the simulator stays
green and still shows what was not run.
"""
import pytest


def _missing_simulator(exc):
    return type(exc).__name__ == "SimulatorNotFound"


def _skip_if_missing_simulator(outcome):
    exc = outcome.excinfo[1] if outcome.excinfo else None
    if exc is not None and _missing_simulator(exc):
        outcome.force_exception(pytest.skip.Exception("TI pru-simulator not available: " + str(exc).split(";")[0],
                                                      _use_item_location=True))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    outcome = yield
    _skip_if_missing_simulator(outcome)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    outcome = yield
    _skip_if_missing_simulator(outcome)
