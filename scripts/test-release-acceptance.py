"""Synthetic acceptance records; no device, vault, or user credentials touched.

Run with --receipt-checker PATH to the existing O1 checker. Each rejection
mutates a complete passing fixture, so no unrelated missing field hides it.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--receipt-checker", required=True)
options, rest = parser.parse_known_args()
script = Path(__file__).with_name("check-release-acceptance.py")
spec = importlib.util.spec_from_file_location("acceptance", script)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)
checker = acceptance.load_checker(options.receipt_checker)


class AcceptanceChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="release-acceptance-fixture-")
        cls.root = Path(cls.scratch.name)
        cls.repo = cls.root / "repo"
        cls.repo.mkdir()
        for args in [("init", "--quiet"), ("config", "user.name", "Alan"),
                     ("config", "user.email", "178781252+ellimist-afk@users.noreply.github.com"),
                     ("config", "commit.gpgsign", "false")]:
            checker.git(cls.repo, *args)
        (cls.repo / "fixture.txt").write_text("synthetic source")
        checker.git(cls.repo, "add", "fixture.txt")
        checker.git(cls.repo, "commit", "--quiet", "-m", "fixture")
        cls.source = checker.git(cls.repo, "rev-parse", "HEAD")[1]
        cls.tree = checker.git(cls.repo, "rev-parse", "HEAD^{tree}")[1]

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def record(self, name, content):
        path = self.base / name
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
        return {"path": name, "sha256": checker.sha256(path)}

    def setUp(self):
        self.base = self.root / self.id().split(".")[-1]
        self.base.mkdir()
        self.record("main.js", "fixture")
        self.record("styles.css", "body{}")
        self.record("manifest.json", {"version": "1.0.0"})
        review = self.record("review.txt", "PASS synthetic fixture only")
        observation = self.record("observation.txt", "Synthetic device evidence for checker tests; never actual acceptance")
        self.assets = {name: checker.sha256(self.base / name) for name in checker.ASSETS}
        self.receipt = {"source": self.source, "tree": self.tree,
                        "identity": checker.ALAN + "|" + checker.ALAN,
                        "assets": self.assets, "review": {**review, "disposition": "PASS"},
                        "gate": [{"name": "unit", "exit": 0}, {"name": "render", "exit": 0}]}
        self.data = acceptance.template()
        self.data["candidate"]["receipt"] = self.record("RECEIPT.json", self.receipt)
        for row in self.data["scenarios"]:
            row.update(status="pass", evidenceLevel="measured", observedAt="2026-01-02T12:00:00Z")
            row["observations"] = {key: "pass" for key in row["observations"]}
            row["evidence"] = [observation]
            for device in row["devices"]:
                name = f"{row['id']}-{device['role']}.json"
                device["identity"] = self.record(name, {
                    "kind": "device-identity", "evidenceLevel": "measured", "device": device["role"],
                    "vault": "Synthetic acceptance fixture", "source": self.source, "assets": self.assets,
                    "runtimeReloaded": True, "observedAt": "2026-01-02T11:00:00Z", "evidence": [observation]})

    def run_check(self):
        path = self.base / "acceptance.json"
        path.write_text(json.dumps(self.data), encoding="utf-8")
        p = subprocess.run([sys.executable, str(script), str(path), "--receipt-checker", options.receipt_checker,
                            "--repo", str(self.repo), "--require-gate", "unit", "--require-gate", "render"],
                           capture_output=True, text=True, timeout=30)
        self.assertIn(p.returncode, (0, 1), p.stderr)
        result = json.loads(p.stdout)
        self.assertEqual(result["ok"], p.returncode == 0)
        return result

    def rejects(self, fragment):
        result = self.run_check()
        self.assertFalse(result["ok"], result)
        self.assertIn(fragment, " ".join(result["errors"]) + json.dumps(result.get("integrity", {})))

    def change_identity(self, **fields):
        device = self.data["scenarios"][0]["devices"][0]
        name = device["identity"]["path"]
        identity = checker.read_json(self.base / name)
        identity.update(fields)
        device["identity"] = self.record(name, identity)

    def test_complete_fixture_passes(self):
        self.assertTrue(self.run_check()["ok"])

    def test_missing_required_fields(self):
        original = copy.deepcopy(self.data)
        for field in ("observedAt", "settings", "observations", "devices", "evidence"):
            with self.subTest(field=field):
                self.data = copy.deepcopy(original)
                del self.data["scenarios"][0][field]
                self.assertFalse(self.run_check()["ok"])

    def test_unknown_and_duplicate_scenario(self):
        self.data["scenarios"].append(copy.deepcopy(self.data["scenarios"][0]))
        self.rejects("duplicate scenario")
        self.data["scenarios"][-1]["id"] = "unknown-workflow"
        self.rejects("unknown scenario")

    def test_missing_scenario(self):
        self.data["scenarios"].pop()
        self.rejects("missing scenario")

    def test_unknown_pending_failed_not_pass(self):
        for value in ("unknown", "pending", "fail"):
            with self.subTest(status=value):
                self.data["scenarios"][0]["status"] = value
                self.rejects("scenario not PASS")

    def test_relayed_is_not_measured(self):
        self.data["scenarios"][0]["evidenceLevel"] = "relayed"
        self.rejects("actual device observation required")

    def test_identity_source_and_asset_mismatch(self):
        self.change_identity(source="0" * 40)
        self.rejects("identity mismatch")
        self.change_identity(source=self.source, assets={**self.assets, "main.js": "0" * 64})
        self.rejects("identity mismatch")

    def test_installed_without_runtime_reload(self):
        self.change_identity(runtimeReloaded=False)
        self.rejects("loaded runtime")

    def test_wrong_settings_and_missing_observation(self):
        self.data["scenarios"][0]["settings"]["readableLineLength"] = True
        self.rejects("setting/scenario mismatch")
        self.data["scenarios"][0]["settings"]["readableLineLength"] = False
        self.data["scenarios"][0]["observations"]["intermediateFrameAlignment"] = "unknown"
        self.rejects("failed observation")

    def test_tampered_evidence(self):
        (self.base / "observation.txt").write_text("tampered")
        self.rejects("evidence hash mismatch")

    def test_identity_after_scenario(self):
        self.change_identity(observedAt="2026-01-03T12:00:00Z")
        self.rejects("must precede scenario")

    def test_second_device_is_required(self):
        row = self.data["scenarios"][-1]
        name = row["devices"][1]["identity"]["path"]
        identity = checker.read_json(self.base / name)
        identity["device"] = "source"
        row["devices"][1]["identity"] = self.record(name, identity)
        self.rejects("distinct devices")

    def test_real_receipt_checker_rejects_tampered_asset(self):
        (self.base / "main.js").write_text("tampered")
        self.rejects("SHA256 mismatch")

    def test_real_receipt_checker_rejects_failed_gate(self):
        self.receipt["gate"][0]["exit"] = 1
        self.data["candidate"]["receipt"] = self.record("RECEIPT.json", self.receipt)
        self.rejects("candidate integrity did not pass")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *rest])
