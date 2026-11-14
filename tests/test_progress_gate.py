import unittest

from media_workspace.job_runner import PROGRESS_WRITE_SECONDS, _ProgressGate


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class ProgressGateTest(unittest.TestCase):
    def test_writes_first_last_and_every_interval(self) -> None:
        clock = FakeClock()
        gate = _ProgressGate(clock=clock)
        self.assertTrue(gate.due({"processed": 0, "total": 300}))
        # Files indexed back to back inside one interval: no writes.
        self.assertFalse(any(gate.due({"processed": n, "total": 300}) for n in range(1, 50)))
        clock.now += PROGRESS_WRITE_SECONDS
        self.assertTrue(gate.due({"processed": 50, "total": 300}))
        self.assertFalse(gate.due({"processed": 51, "total": 300}))
        # The last update always lands, so a phase never ends short of 100%.
        self.assertTrue(gate.due({"processed": 300, "total": 300}))

    def test_without_a_total_still_writes_on_the_interval(self) -> None:
        clock = FakeClock()
        gate = _ProgressGate(clock=clock)
        self.assertTrue(gate.due({}))
        self.assertFalse(gate.due({"processed": 1}))
        clock.now += PROGRESS_WRITE_SECONDS + 0.01
        self.assertTrue(gate.due({"processed": 2}))


if __name__ == "__main__":
    unittest.main()
