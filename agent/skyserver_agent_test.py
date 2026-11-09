import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from skyserver_agent import (
    CONTAINERS,
    TIMERS,
    chumei_pipeline_freshness,
    collect_items,
    container_status,
    load_job_state,
    parse_docker_states,
    parse_systemctl_show,
    save_job_state,
    scheduled_job_status,
    timer_job_status,
)


def docker_line(name, **state):
    return f"/{name}\t{json.dumps(state)}"


def systemd_block(unit, **properties):
    return "\n".join([f"Id={unit}", *(f"{key}={value}" for key, value in properties.items())])


def units(service=None, timer=None):
    timer = {"LoadState": "loaded", "ActiveState": "active", **(timer or {})}
    service = {"LoadState": "loaded", "ActiveState": "inactive", "Result": "success",
               "ExecMainStatus": "0", "ExecMainExitTimestampMonotonic": "123", **(service or {})}
    return {"job.timer": timer, "job.service": service}


class ContainerStatusTest(unittest.TestCase):
    def test_running_without_healthcheck_is_up(self):
        states = parse_docker_states(docker_line("api", Status="running"))
        self.assertEqual(container_status("api", states), (True, "Running"))

    def test_healthcheck_must_be_healthy(self):
        for health, up in (("healthy", True), ("starting", False), ("unhealthy", False)):
            with self.subTest(health=health):
                states = parse_docker_states(docker_line("api", Status="running", Health={"Status": health}))
                self.assertEqual(container_status("api", states)[0], up)

    def test_stopped_or_missing_containers_are_down(self):
        states = parse_docker_states("\n".join([
            docker_line("exited", Status="exited", ExitCode=137),
            docker_line("restarting", Status="restarting"),
            "garbage line",
            "/bad\t{",
        ]))
        self.assertEqual(container_status("exited", states), (False, "Container exited 137"))
        self.assertEqual(container_status("restarting", states), (False, "Container restarting"))
        self.assertEqual(container_status("bad", states), (False, "Container not found"))
        self.assertEqual(container_status("missing", states), (False, "Container not found"))


class TimerJobStatusTest(unittest.TestCase):
    def test_parses_systemctl_show_blocks(self):
        output = "\n\n".join([
            systemd_block("job.timer", LoadState="loaded", ActiveState="active"),
            systemd_block("job.service", LoadState="loaded", ActiveState="inactive", Result="success"),
        ]) + "\n"
        parsed = parse_systemctl_show(output)
        self.assertEqual(parsed["job.timer"]["ActiveState"], "active")
        self.assertEqual(parsed["job.service"]["Result"], "success")

    def test_last_successful_run_is_up(self):
        self.assertEqual(timer_job_status("job", units()), (True, "Scheduled · last run ok"))

    def test_never_run_job_is_up_until_its_first_trigger(self):
        self.assertEqual(timer_job_status("job", units({"ExecMainExitTimestampMonotonic": "0"})),
                         (True, "Scheduled · not run yet"))

    def test_failed_run_is_down(self):
        up, detail = timer_job_status("job", units({"ActiveState": "failed", "Result": "exit-code",
                                                    "ExecMainStatus": "1"}))
        self.assertFalse(up)
        self.assertIn("exit-code, exit 1", detail)

    def test_missing_or_stopped_timer_is_down(self):
        self.assertEqual(timer_job_status("job", {}), (False, "Timer not installed"))
        self.assertEqual(timer_job_status("job", units(timer={"LoadState": "not-found"})),
                         (False, "Timer not installed"))
        self.assertEqual(timer_job_status("job", units(timer={"ActiveState": "inactive"})),
                         (False, "Timer inactive"))

    def test_failed_job_stays_down_while_retry_runs(self):
        running = units({"ActiveState": "activating", "Result": "success"})
        self.assertEqual(timer_job_status("job", running), (True, "Running"))
        up, detail = timer_job_status("job", running, previous_result="exit-code")
        self.assertFalse(up)
        self.assertIn("previous result exit-code", detail)


class ChumeiPipelineFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "pipeline.json"
        self.now = datetime(2026, 10, 18, 0, 0, tzinfo=timezone.utc)

    def write(self, age_minutes=10, results=None, completed=None):
        self.path.write_text(json.dumps({
            "last_run": completed or (self.now - timedelta(minutes=age_minutes)).isoformat(),
            "last_results": results if results is not None else {"extract": True, "build": True},
        }), encoding="utf-8")

    def check(self):
        return chumei_pipeline_freshness(self.path, now=self.now)

    def test_successful_publish_is_fresh_until_deadline(self):
        self.write(age_minutes=240)
        self.assertTrue(self.check()[0])

    def test_stale_success_is_down_even_when_file_was_just_written(self):
        self.write(age_minutes=241)
        up, detail = self.check()
        self.assertFalse(up)
        self.assertIn("Pipeline stale", detail)

    def test_failed_publish_is_not_a_success_heartbeat(self):
        for results in ({"build": False}, {"build": True, "telegram": False}, {}):
            with self.subTest(results=results):
                self.write(results=results)
                self.assertFalse(self.check()[0])

    def test_optional_fetch_failure_does_not_override_producer_success(self):
        self.write(results={"facebook": False, "extract": True, "build": True})
        self.assertTrue(self.check()[0])

    def test_missing_or_malformed_evidence_is_not_healthy(self):
        self.assertFalse(self.check()[0])
        for content in ("{", "null", "[]", '{"last_results": true}',
                        '{"last_results": {"build": true}, "last_run": 42}'):
            with self.subTest(content=content):
                self.path.write_text(content, encoding="utf-8")
                self.assertFalse(self.check()[0])

    def test_timezone_required_and_future_timestamp_rejected(self):
        self.write(completed="2026-10-18T00:00:00")
        self.assertFalse(self.check()[0])
        self.write(age_minutes=-5)
        self.assertFalse(self.check()[0])

    def test_utc_z_and_small_clock_skew_are_supported(self):
        self.write(completed="2026-10-18T00:00:30Z")
        self.assertTrue(self.check()[0])


class ScheduledJobStatusTest(unittest.TestCase):
    def test_idle_success_requires_fresh_chumei_publish(self):
        with patch("skyserver_agent.chumei_pipeline_freshness", return_value=(False, "Pipeline stale")):
            up, detail = scheduled_job_status("chumei-pipeline", "job", units())
        self.assertFalse(up)
        self.assertIn("Pipeline stale", detail)

    def test_running_job_does_not_hide_stale_publish(self):
        with patch("skyserver_agent.chumei_pipeline_freshness", return_value=(False, "Pipeline stale")):
            self.assertFalse(scheduled_job_status("chumei-pipeline", "job", units({"ActiveState": "activating"}))[0])

    def test_fresh_artifact_cannot_hide_systemd_failure(self):
        with patch("skyserver_agent.chumei_pipeline_freshness") as freshness:
            self.assertFalse(scheduled_job_status("chumei-pipeline", "job", units({"Result": "exit-code"}))[0])
            freshness.assert_not_called()

    def test_other_jobs_use_systemd_status_only(self):
        with patch("skyserver_agent.chumei_pipeline_freshness") as freshness:
            self.assertEqual(scheduled_job_status("harmonica-social-fast", "job", units()),
                             (True, "Scheduled · last run ok"))
            freshness.assert_not_called()


class CollectItemsTest(unittest.TestCase):
    def test_reports_every_monitor_with_wire_shape_and_records_results(self):
        docker = "\n".join(docker_line(container, Status="running") for _, _, container in CONTAINERS)
        blocks = []
        for _, _, unit in TIMERS:
            blocks.append(systemd_block(f"{unit}.timer", LoadState="loaded", ActiveState="active"))
            blocks.append(systemd_block(f"{unit}.service", LoadState="loaded", ActiveState="inactive",
                                        Result="success", ExecMainExitTimestampMonotonic="5"))
        job_state = {}
        with patch("skyserver_agent.chumei_pipeline_freshness", return_value=(True, "Fresh")):
            items = collect_items(docker, "\n\n".join(blocks), job_state)
        self.assertEqual([item["id"] for item in items],
                         [identifier for identifier, _, _ in CONTAINERS + TIMERS])
        self.assertNotIn("chumei-promo-files", [item["id"] for item in items])
        for item in items:
            self.assertEqual(set(item), {"id", "name", "kind", "up", "detail"})
            self.assertTrue(item["up"], item)
        self.assertEqual(set(job_state.values()), {"success"})

    def test_job_state_round_trips_and_ignores_invalid_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.json"
            save_job_state({"job": "exit-code"}, path)
            self.assertEqual(load_job_state(path), {"job": "exit-code"})
            path.write_text('{"job": 1, "other": "success"}', encoding="utf-8")
            self.assertEqual(load_job_state(path), {"other": "success"})
            path.write_text("[]", encoding="utf-8")
            self.assertEqual(load_job_state(path), {})


if __name__ == "__main__":
    unittest.main()

class MigrationCoverageTest(unittest.TestCase):
    def test_missing_targets_fail_closed(self):
        from skyserver_agent import extra_items
        items = extra_items('', '', '', {})
        self.assertTrue(items)
        self.assertTrue(all(not item['up'] for item in items))
        self.assertEqual(len(items), len({item['id'] for item in items}))

    def test_generated_names_and_unhealthy_members(self):
        from skyserver_agent import extra_items
        docker = docker_line('dokploy.1.new-task', Status='running', Health={'Status': 'healthy'})
        items = {item['id']: item for item in extra_items(docker, '', '', {})}
        self.assertTrue(items['dokploy']['up'])
        docker += '\n' + docker_line('dokploy.1.failed-task', Status='exited', ExitCode=1)
        items = {item['id']: item for item in extra_items(docker, '', '', {})}
        self.assertTrue(items['dokploy']['up'])
        self.assertIn('historical stopped task', items['dokploy']['detail'])

    def test_only_stopped_matches_remain_down(self):
        from skyserver_agent import extra_items
        docker = docker_line('dokploy.1.failed-task', Status='exited', ExitCode=1)
        items = {item['id']: item for item in extra_items(docker, '', '', {})}
        self.assertFalse(items['dokploy']['up'])
        self.assertIn('Container exited 1', items['dokploy']['detail'])

    def test_system_and_user_units_do_not_mix(self):
        from skyserver_agent import extra_items
        block = 'Id=host-observer.service\nLoadState=loaded\nActiveState=active'
        wrong = {item['id']: item for item in extra_items('', block, '', {})}
        right = {item['id']: item for item in extra_items('', '', block, {})}
        self.assertFalse(wrong['host-observer.service']['up'])
        self.assertTrue(right['host-observer.service']['up'])

    def test_http_503_remains_down_and_expected_redirect_is_up(self):
        import skyserver_agent as agent
        from unittest.mock import MagicMock, patch
        opener = MagicMock()
        response = MagicMock()
        response.__enter__.return_value.status = 308
        with patch.object(agent, 'HTTP_CHECKS', [('traffic', 'http://127.0.0.1/', 'traffic.observe.tw', (308,))]), patch.object(agent.urllib.request, 'build_opener', return_value=opener):
            opener.open.return_value = response
            self.assertTrue(agent.http_items()[0]['up'])
        with patch.object(agent, 'HTTP_CHECKS', [('observer', 'http://127.0.0.1/health', None, (200,))]), patch.object(agent.urllib.request, 'build_opener', return_value=opener):
            opener.open.side_effect = agent.urllib.error.HTTPError('http://127.0.0.1/health', 503, 'Unavailable', {}, None)
            self.assertFalse(agent.http_items()[0]['up'])
