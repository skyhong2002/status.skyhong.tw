import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import nas_capacity_agent as agent

GIB = agent.GIB


def about(free_gib, total_gib=1983):
    return {"total": total_gib * GIB, "used": (total_gib - free_gib) * GIB, "free": free_gib * GIB}


class CapacityItemTest(unittest.TestCase):
    def test_up_above_threshold_and_down_below_it(self):
        minimum = 150 * GIB
        self.assertTrue(agent.capacity_item(about(575.6), minimum)["up"])
        self.assertTrue(agent.capacity_item(about(150), minimum)["up"])
        low = agent.capacity_item(about(149.9), minimum)
        self.assertFalse(low["up"])
        self.assertEqual(low["id"], "nas-free-space")
        self.assertIn("149.9 GiB free of 1983 GiB", low["detail"])
        self.assertIn("alert below 150 GiB", low["detail"])

    def test_threshold_comes_from_environment(self):
        with patch.dict("os.environ", {"NAS_FREE_MIN_GIB": "600"}):
            self.assertEqual(agent.free_min_bytes(), 600 * GIB)


class MeasureTest(unittest.TestCase):
    def test_parses_rclone_about_and_rejects_failures(self):
        ok = lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps(about(500)))
        self.assertEqual(agent.measure(run=ok)["free"], 500 * GIB)
        failed = lambda *a, **k: SimpleNamespace(returncode=5, stdout="")
        with self.assertRaisesRegex(RuntimeError, "exited 5"):
            agent.measure(run=failed)
        empty = lambda *a, **k: SimpleNamespace(returncode=0, stdout="{}")
        with self.assertRaisesRegex(RuntimeError, "no free/total"):
            agent.measure(run=empty)

    def test_reuses_recent_measurement_and_never_caches_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "about.json"
            calls = []

            def measure():
                calls.append(1)
                return about(400)

            agent.cached_measure(1000, path, measure)
            agent.cached_measure(1000 + agent.MEASURE_INTERVAL_SECONDS - 1, path, measure)
            self.assertEqual(len(calls), 1)
            agent.cached_measure(1000 + agent.MEASURE_INTERVAL_SECONDS, path, measure)
            self.assertEqual(len(calls), 2)

            def broken():
                raise RuntimeError("rclone about exited 1")

            path.unlink()
            with self.assertRaises(RuntimeError):
                agent.cached_measure(5000, path, broken)
            self.assertFalse(path.exists())


class CollectItemsTest(unittest.TestCase):
    def test_unmeasurable_nas_is_reported_down(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(agent, "STATE_PATH", Path(tmp) / "about.json"):
            def broken():
                raise RuntimeError("rclone about exited 1")

            with patch.object(agent, "cached_measure", side_effect=lambda now, measure: (measure(), now)):
                (item,) = agent.collect_items(now=0, measure_fn=broken)
        self.assertFalse(item["up"])
        self.assertIn("NAS capacity unavailable", item["detail"])


if __name__ == "__main__":
    unittest.main()
