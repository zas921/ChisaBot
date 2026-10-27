"""Transactional updater tests: Linux, standard library only; no real Docker or network."""
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("magpie_update", pathlib.Path(__file__).with_name("magpie-update.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
OLD = "sha256:" + "1" * 64
NEW = "sha256:" + "2" * 64
MANIFEST = "sha256:" + "3" * 64


class FakeDocker:
    def __init__(self, data):
        self.data = data
        self.calls = []
        self.fail = None
        self.target = NEW
        self.old = {
            "Id": "old", "Name": "/magpie", "Image": OLD, "State": {"Running": True},
            "Config": {"Image": OLD, "Cmd": ["web", "--addr", "0.0.0.0:3430", "--no-open"],
                       "User": "nonroot", "Env": ["MAGPIE_WEB_KEY=dummy-private-key-123", "HTTPS_PROXY=http://user:dummy-secret@proxy:7897", "XDG_CONFIG_HOME=/config"],
                       "Healthcheck": {"Test": ["CMD", "/magpie", "healthcheck"]}, "Labels": {}},
            "HostConfig": {"Binds": [str(data) + ":/config:rw"], "PortBindings": {"3430/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3430"}]},
                           "Memory": 805306368, "SecurityOpt": ["no-new-privileges:true"], "CapDrop": ["ALL"], "RestartPolicy": {"Name": "unless-stopped"}},
            "Mounts": [{"Type": "bind", "Source": str(data), "Destination": "/config", "RW": True}],
            "NetworkSettings": {"Networks": {"test-network": {"Aliases": ["magpie"], "IPAMConfig": {"IPv4Address": "172.28.0.5"}}}},
        }
        self.items = {"old": copy.deepcopy(self.old)}

    def inspect(self, name):
        result = self.items.get(name) or next((c for c in self.items.values() if c["Name"] == "/" + name), None)
        return copy.deepcopy(result)

    def image(self, name):
        return {"Id": name, "Os": "linux", "Architecture": "amd64"}

    def pull(self, name):
        self.calls.append("pull")
        if self.fail == "pull":
            raise m.Failure("registry unavailable")
        return self.target

    def stop(self, ident):
        self.calls.append("stop:" + ident)
        self.items[ident]["State"]["Running"] = False

    def start(self, ident):
        self.calls.append("start:" + ident)
        self.items[ident]["State"]["Running"] = True
        if ident == "new":
            (self.data / "providers.json").write_text("migrated")
            (self.data / "new-file").write_text("new-version-data")
            if self.fail == "start":
                raise m.Failure("start failed")
            if self.fail == "interrupt":
                raise KeyboardInterrupt()

    def rename(self, ident, name):
        self.calls.append("rename:" + ident)
        self.items[ident]["Name"] = "/" + name

    def disconnect(self, network, ident):
        self.items[ident]["NetworkSettings"]["Networks"].pop(network)

    def connect(self, network, ident, endpoint):
        self.items[ident]["NetworkSettings"]["Networks"][network] = copy.deepcopy(endpoint)

    def create(self, name, config):
        self.calls.append("create")
        self.created_config = copy.deepcopy(config)
        if self.fail == "create":
            raise m.Failure("create failed")
        self.items["new"] = {"Id": "new", "Name": "/" + name, "Image": NEW, "State": {"Running": False},
                             "Config": config, "HostConfig": config["HostConfig"], "Mounts": self.old["Mounts"],
                             "NetworkSettings": {"Networks": config["NetworkingConfig"]["EndpointsConfig"]}}
        return "new"

    def remove(self, ident):
        self.calls.append("remove:" + ident)
        del self.items[ident]


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.data = self.root / "persistent-config"
        self.data.mkdir()
        (self.data / "providers.json").write_text("original")
        (self.data / "nested").mkdir()
        (self.data / "nested/token").write_text("original-token")
        self.docker = FakeDocker(self.data)
        self.updater = m.Updater({"CHISABOT_UPDATER_DIR": str(self.root / "updater")}, self.docker)
        self.updater.healthy = lambda old: self.docker.inspect("magpie")["Image"] == OLD or self.docker.fail != "health"
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.output)
        self.redirect.__enter__()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.tmp.cleanup()

    def assert_original(self):
        old = self.docker.inspect("magpie")
        self.assertEqual(old["Id"], "old")
        self.assertTrue(old["State"]["Running"])
        self.assertEqual(old["NetworkSettings"], self.docker.old["NetworkSettings"])
        self.assertEqual((self.data / "providers.json").read_text(), "original")
        self.assertFalse((self.data / "new-file").exists())

    def test_success_preserves_actual_configuration_and_private_backup(self):
        self.assertEqual(self.updater.update("job-success"), 0)
        new = self.docker.created_config
        self.assertEqual(new["Env"], self.docker.old["Config"]["Env"])
        self.assertEqual(new["Cmd"], self.docker.old["Config"]["Cmd"])
        self.assertEqual(new["HostConfig"], self.docker.old["HostConfig"])
        self.assertEqual(new["NetworkingConfig"]["EndpointsConfig"], self.docker.old["NetworkSettings"]["Networks"])
        self.assertFalse(self.updater.journal.exists())
        backup = next((self.updater.home / "magpie-backups").iterdir())
        self.assertEqual((backup / "container.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / "config.tar.gz").stat().st_mode & 0o777, 0o600)
        state = self.updater.state.read_text()
        self.assertNotIn("dummy-private", state + self.output.getvalue())
        self.assertNotIn("dummy-secret", state + self.output.getvalue())
        self.assertEqual(json.loads(state)["currentDigest"], NEW)

    def test_pull_failure_keeps_running_container(self):
        self.docker.fail = "pull"
        with self.assertRaises(m.Failure):
            self.updater.update("job-pull")
        self.assertEqual(self.docker.calls, ["pull"])
        self.assert_original()

    def test_same_image_is_noop_even_with_mutable_tag(self):
        self.docker.target = OLD
        self.assertEqual(self.updater.update("job-current"), 0)
        self.assertEqual(self.docker.calls, ["pull"])
        self.assert_original()

    def test_failed_health_restores_data_and_original_network(self):
        self.docker.fail = "health"
        self.assertEqual(self.updater.update("job-health"), 3)
        self.assert_original()
        self.assertIn("::result:: rolled_back", self.output.getvalue())

    def test_partial_start_failure_restores_data(self):
        self.docker.fail = "start"
        self.assertEqual(self.updater.update("job-start"), 3)
        self.assert_original()

    def test_create_failure_restores_original_name_and_network(self):
        self.docker.fail = "create"
        self.assertEqual(self.updater.update("job-create"), 3)
        self.assert_original()

    def test_backup_failure_restarts_old_without_restoring_partial_archive(self):
        with patch.object(m.tarfile, "open", side_effect=OSError("disk full")):
            self.assertEqual(self.updater.update("job-disk"), 3)
        self.assert_original()

    def test_interrupt_after_start_rolls_back(self):
        self.docker.fail = "interrupt"
        self.assertEqual(self.updater.update("job-interrupt"), 3)
        self.assert_original()

    def test_existing_update_lock_blocks_mutation(self):
        self.updater.home.mkdir()
        with open(str(self.updater.home / "update.lock"), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(m.Failure):
                self.updater.update("job-locked")
        self.assertEqual(self.docker.calls, [])

    def test_named_volume_is_reused_instead_of_new_anonymous_volume(self):
        old = copy.deepcopy(self.docker.old)
        old["HostConfig"]["Binds"] = None
        old["Mounts"][0].update({"Type": "volume", "Name": "persistent-magpie-data"})
        config = m.replacement_config(old, NEW, "job-volume")
        self.assertEqual(config["HostConfig"]["Binds"], ["persistent-magpie-data:/config:rw"])

    def test_missing_persistent_mount_refuses_before_pull(self):
        self.docker.items["old"]["Mounts"] = []
        with self.assertRaises(m.Failure):
            self.updater.update("job-unsafe")
        self.assertEqual(self.docker.calls, [])

    def test_registry_failure_is_unknown_and_never_leaks_raw_output(self):
        with patch.object(m, "remote_image_id", side_effect=m.Failure("registry unavailable")):
            state = self.updater.check()
        self.assertIsNone(state["latestDigest"])
        self.assertFalse(state["updateAvailable"])
        self.assertEqual(self.docker.calls, [])

    def test_check_compares_running_image_not_local_tag(self):
        with patch.object(m, "remote_image_id", return_value=NEW):
            state = self.updater.check()
        self.assertEqual(state["currentDigest"], OLD)
        self.assertTrue(state["updateAvailable"])

    def test_multiarch_manifest_resolves_matching_platform_config(self):
        index = {"manifests": [{"platform": {"os": "unknown", "architecture": "unknown"}, "digest": OLD},
                               {"platform": {"os": "linux", "architecture": "arm64"}, "digest": OLD},
                               {"platform": {"os": "linux", "architecture": "amd64"}, "digest": MANIFEST}]}
        with patch.object(m, "command", side_effect=[json.dumps(index).encode(), json.dumps({"config": {"digest": NEW}}).encode()]) as run:
            self.assertEqual(m.remote_image_id("ghcr.io/yetone/magpie:latest", ("linux", "amd64", None)), NEW)
        self.assertIn(MANIFEST, run.call_args[0][0][-1])

    def test_human_manifest_output_is_not_accepted_as_digest(self):
        with patch.object(m, "command", return_value=b"Name: magpie\nDigest: sha256:bad"):
            with self.assertRaises(m.Failure):
                m.remote_image_id("ghcr.io/yetone/magpie:latest", ("linux", "amd64", None))

    def test_interrupted_before_stop_is_recovered_on_next_update(self):
        backup = self.root / "previous-backup"
        backup.mkdir()
        m.write_json(backup / "container.json", self.docker.old)
        m.write_json(self.updater.journal, {"job": "old-job", "backup": str(backup), "newStarted": False})
        self.docker.target = OLD
        self.assertEqual(self.updater.update("job-recover"), 0)
        self.assert_original()
        self.assertFalse(self.updater.journal.exists())

    def test_recovery_does_not_remove_unrelated_replacement(self):
        backup = self.root / "previous-backup"
        backup.mkdir()
        m.write_json(backup / "container.json", self.docker.old)
        self.docker.items["old"]["Name"] = "/old-backup"
        self.docker.create("magpie", m.replacement_config(self.docker.old, NEW, "someone-else"))
        with self.assertRaises(m.Failure):
            self.updater.rollback({"job": "our-job", "backup": str(backup), "newStarted": False})
        self.assertIsNotNone(self.docker.inspect("new"))
        self.assertNotIn("remove:new", self.docker.calls)

    def test_corrupt_backup_is_detected_before_deleting_data(self):
        backup = self.root / "previous-backup"
        backup.mkdir()
        m.write_json(backup / "container.json", self.docker.old)
        (backup / "config.tar.gz").write_bytes(b"corrupt")
        with self.assertRaises(m.Failure):
            self.updater.rollback({"job": "job-corrupt", "backup": str(backup), "newStarted": True, "archiveDigest": "incorrect"})
        self.assertEqual((self.data / "providers.json").read_text(), "original")

    def test_unauthorized_management_response_is_not_healthy(self):
        opener = unittest.mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError("http://localhost", 401, "Unauthorized", {}, None)
        with patch.object(m.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(urllib.error.HTTPError):
                self.updater.probe(self.docker.old)


if __name__ == "__main__":
    unittest.main(verbosity=2)
