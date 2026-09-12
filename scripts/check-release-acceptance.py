"""Scenario evidence gate layered on the existing O1 receipt checker.

Does not run devices, infer visual success, install, or publish. PASS validates
recorded evidence completeness/consistency, not the truth of a human observation.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def scenarios():
    result = {}
    for readable in (False, True):
        result[f"scroll-readable-{'on' if readable else 'off'}"] = {
            "settings": {"surface": "note", "readableLineLength": readable},
            "checks": ["intermediateFrameAlignment", "settledAlignment", "storedInkUnchanged"],
            "roles": ["primary"],
        }
    for zoom in (10, 100, 400):
        result[f"zoom-draw-{zoom}"] = {
            "settings": {"surface": "note", "zoomPercent": zoom, "minimumCycles": 3},
            "checks": ["captureAlignment", "intermediateFrameAlignment", "oldInkUnchanged", "coldReopenAlignment", "undoRedo"],
            "roles": ["primary"],
        }
    result["insert-space"] = {
        "settings": {"surface": "note"},
        "checks": ["guideMatchesSplit", "inkMembership", "textMembership", "undoRedo", "cancelRestoresContent"],
        "roles": ["primary"],
    }
    for surface in ("note", "pdf"):
        for phase in ("enable-existing", "late-arrival"):
            result[f"compatibility-{surface}-{phase}"] = {
                "settings": {"surface": surface, "compatibility": True, "phase": phase},
                "checks": ["existingInkPreserved", "secondDeviceVisible", "coldReopen", "noDivergentLiveSidecar"],
                "roles": ["source", "target"],
            }
    return result


def template():
    return {"schemaVersion": 1, "candidate": {"receipt": {"path": None, "sha256": None}},
            "scenarios": [{"id": name, "status": "pending", "evidenceLevel": "unknown",
                           "observedAt": None, "settings": spec["settings"],
                           "devices": [{"role": role, "identity": {"path": None, "sha256": None}}
                                       for role in spec["roles"]],
                           "observations": {check: "pending" for check in spec["checks"]},
                           "evidence": []} for name, spec in scenarios().items()]}


def check_scenarios(data, base, integrity, receipt_checker):
    """Consume only freshly verified receipt output; reusable in fixture tests."""
    errors = []

    def require(condition, message):
        if not condition:
            raise ValueError(message)

    def text(value):
        return isinstance(value, str) and value.strip().lower() not in ("", "unknown", "pending", "todo")

    def timestamp(value):
        require(text(value), "missing observation timestamp")
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(dt.tzinfo is not None and dt <= datetime.now(timezone.utc), "timestamp must have timezone and not be future")
        return dt

    def evidence(record):
        require(isinstance(record, dict), "missing hashed evidence record")
        path = receipt_checker.safe_file(base, record.get("path"))
        require(receipt_checker.sha256(path) == receipt_checker.normalized_hash(record.get("sha256"), "evidence"), "evidence hash mismatch")
        require(path.stat().st_size > 0, "empty evidence")
        return path

    require(data.get("schemaVersion") == 1, "unsupported schemaVersion")
    require(integrity.get("ok") is True, "candidate integrity did not pass")
    source = integrity["checks"]["source"]["source"]
    assets = {name: value["sha256"] for name, value in integrity["checks"]["assets"]["files"].items()}
    rows = data.get("scenarios")
    require(isinstance(rows, list), "scenarios must be an array")
    seen = set()
    for row in rows:
        label = row.get("id") if isinstance(row, dict) else None
        try:
            require(isinstance(label, str) and label in scenarios(), f"unknown scenario: {label}")
            require(label not in seen, f"duplicate scenario: {label}")
            seen.add(label)
            spec = scenarios()[label]
            require(row.get("status") == "pass", "scenario not PASS")
            require(row.get("evidenceLevel") == "measured", "actual device observation required; relayed/unknown is not PASS")
            observed = timestamp(row.get("observedAt"))
            require(json.dumps(row.get("settings"), sort_keys=True) == json.dumps(spec["settings"], sort_keys=True), "required setting/scenario mismatch")
            require(row.get("observations") == {name: "pass" for name in spec["checks"]}, "missing, unknown, or failed observation")
            require(isinstance(row.get("evidence"), list) and row["evidence"], "scenario evidence required")
            for record in row["evidence"]:
                evidence(record)
            devices = row.get("devices")
            require(isinstance(devices, list), "devices required")
            require(sorted(d.get("role", "") for d in devices) == sorted(spec["roles"]), "device roles missing or duplicated")
            device_names = []
            for device in devices:
                identity = receipt_checker.read_json(evidence(device.get("identity")))
                require(identity.get("kind") == "device-identity" and identity.get("evidenceLevel") == "measured", "measured device identity required")
                require(text(identity.get("device")) and text(identity.get("vault")), "device and vault required")
                require(identity.get("source") == source and identity.get("assets") == assets, "device identity mismatch with candidate source/assets")
                require(identity.get("runtimeReloaded") is True, "installed files alone do not prove loaded runtime")
                require(timestamp(identity.get("observedAt")) <= observed, "device identity must precede scenario")
                require(isinstance(identity.get("evidence"), list) and identity["evidence"], "device identity evidence required")
                for record in identity["evidence"]:
                    evidence(record)
                device_names.append(identity["device"])
            require(len(set(device_names)) == len(device_names), "second-device scenario requires distinct devices")
        except (ValueError, TypeError, KeyError, AttributeError, OSError) as exc:
            errors.append(f"{label}: {exc}")
    errors.extend(f"missing scenario: {name}" for name in scenarios() if name not in seen)
    return errors


def load_checker(path):
    spec = importlib.util.spec_from_file_location("release_receipt_checker", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("acceptance", nargs="?")
    parser.add_argument("--template", action="store_true", help="print pending template; no acceptance performed")
    parser.add_argument("--receipt-checker", help="path to O1-owned check_receipt.py")
    parser.add_argument("--repo")
    parser.add_argument("--require-gate", action="append", help="exact combined receipt gate names, same as check_receipt.py")
    args = parser.parse_args()
    if args.template:
        print(json.dumps(template(), indent=2))
        return 0
    if not (args.acceptance and args.receipt_checker and args.repo and args.require_gate):
        parser.error("acceptance, --receipt-checker, --repo, and --require-gate required")
    result = {"ok": False, "errors": [], "limits": [
        "Recorded measured device evidence only; no device action or visual interpretation performed.",
        "No installation or publication authorization; ordinary release gate remains required."]}
    try:
        checker = load_checker(args.receipt_checker)
        base = Path(args.acceptance).resolve().parent
        data = checker.read_json(Path(args.acceptance))
        record = data["candidate"]["receipt"]
        # Delegate all package/source/hash/review/gate integrity to existing tooling.
        receipt = checker.safe_file(base, record["path"])
        expected = checker.normalized_hash(record["sha256"], "candidate receipt")
        integrity = checker.verify(argparse.Namespace(
            receipt=str(receipt), repo=args.repo, expect_receipt_sha256=expected,
            expect_identity=checker.ALAN, mode="combined", require_gate=args.require_gate,
            require_evidence=[]))
        result["integrity"] = integrity
        result["errors"] = check_scenarios(data, base, integrity, checker)
        result["ok"] = not result["errors"]
    except Exception as exc:
        result["errors"].append(str(exc))
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
