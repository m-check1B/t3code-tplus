#!/usr/bin/env python3
"""Check final macOS payloads, including decoded ASAR entries. Never emit matches."""
import argparse
import collections
import hashlib
import json
import pathlib
import plistlib
import re
import struct
import subprocess
import tempfile


def audit(app, args):
    findings = []
    inventories = {key: collections.Counter() for key in ("email", "tailnet", "upstream_home_path", "upstream_network_url")}
    patterns = {
        "private_builder_home": re.compile(b"|".join(re.escape(prefix.encode()) for prefix in args.private_prefix)),
        "github_token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b"),
        "private_key_body": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{40,}"),
    }
    if args.deny_patterns:
        for category, pattern in json.loads(args.deny_patterns.read_text()).items():
            patterns[category] = re.compile(pattern.encode(), re.I)
    inventory_patterns = {
        "email": re.compile(rb"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b"),
        "tailnet": re.compile(rb"\b[a-zA-Z0-9_-]{1,63}(?:\.[a-zA-Z0-9_-]{1,63}){0,8}\.ts\.net\b"),
        "upstream_home_path": re.compile(rb"/Users/[^\x00\s\"'<>]{1,512}"),
        "upstream_network_url": re.compile(rb"https?://192\.168\.[0-9.]+(?::[0-9]+)?"),
    }
    entries = total_bytes = 0
    package = None
    resources = app / "Contents/Resources"

    def scan(name, data):
        nonlocal entries, total_bytes, package
        entries += 1
        total_bytes += len(data)
        for category, pattern in patterns.items():
            count = sum(1 for _ in pattern.finditer(data))
            if count:
                findings.append({"category": category, "path": name, "count": count})
        for category, pattern in inventory_patterns.items():
            for match in pattern.finditer(data):
                inventories[category][hashlib.sha256(match.group().lower()).hexdigest()] += 1
        base = pathlib.PurePosixPath(name).name
        if base in ("app-update.yml", "dev-app-update.yml", ".env", ".npmrc", ".netrc", "credentials.json", "id_rsa", "id_ed25519") or base.startswith(".env."):
            findings.append({"category": "unexpected_runtime_file", "path": name})
        if name.endswith("app.asar/package.json"):
            package = json.loads(data)

    def scan_asar(file, label):
        with file.open("rb") as source:
            header = source.read(16)
            header_size = struct.unpack_from("<I", header, 4)[0]
            json_size = struct.unpack_from("<I", header, 12)[0]
            tree = json.loads(source.read(json_size))
            data_offset = 8 + header_size

            def walk(node, prefix=""):
                for name, child in node.get("files", {}).items():
                    relative = prefix + name
                    if "files" in child:
                        walk(child, relative + "/")
                    elif "size" in child:
                        if child.get("unpacked"):
                            data = pathlib.Path(str(file) + ".unpacked", relative).read_bytes()
                        else:
                            source.seek(data_offset + int(child.get("offset", 0)))
                            data = source.read(child["size"])
                        if len(data) != child["size"]:
                            raise ValueError("Truncated ASAR entry")
                        scan(label + "/" + relative, data)
            walk(tree)

    for file in sorted(app.rglob("*")):
        if file.is_symlink() or not file.is_file():
            continue
        # ASAR loose entries are read according to the header, then also checked
        # here to catch orphaned files absent from the header.
        name = str(file.relative_to(app))
        if file.suffix == ".asar":
            scan_asar(file, name)
        else:
            scan(name, file.read_bytes())

    for name in ("LICENSE", "NOTICE"):
        expected = (args.repo / name).read_bytes() if (args.repo / name).exists() else None
        actual = resources / name
        if expected is None or not actual.is_file() or actual.read_bytes() != expected:
            findings.append({"category": "missing_or_changed_notice", "path": name})
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    expected_info = {
        "CFBundleIdentifier": "com.verduona.t3code-tplus",
        "CFBundleShortVersionString": args.version,
        "CFBundleVersion": args.version,
        "CFBundleName": "T3 Code TPLUS",
    }
    for key, value in expected_info.items():
        if info.get(key) != value:
            findings.append({"category": "bundle_identity", "field": key})
    if package is None or package.get("version") != args.version or package.get("t3codeCommitHash") != args.commit[:12] or package.get("publish") or package.get("build", {}).get("publish"):
        findings.append({"category": "asar_identity_or_update_feed"})
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    architecture = subprocess.check_output(["lipo", "-archs", str(executable)], text=True).strip()
    if architecture != {"arm64": "arm64", "x64": "x86_64"}[args.arch]:
        findings.append({"category": "executable_architecture"})
    inventory = {key: dict(sorted(value.items())) for key, value in inventories.items()}
    if args.baseline:
        baseline = json.loads(args.baseline.read_text())["inventories"]
        for category, values in inventory.items():
            added = sorted(set(values) - set(baseline[category]))
            if added:
                findings.append({"category": "new_" + category, "fingerprints": added})
    elif inventories["upstream_home_path"]:
        findings.append({"category": "unclassified_absolute_home_paths", "count": sum(inventories["upstream_home_path"].values())})
    return {"status": "FAIL" if findings else "PASS", "architecture": architecture,
            "version": info["CFBundleShortVersionString"], "commit": (package or {}).get("t3codeCommitHash"),
            "entries": entries, "bytes": total_bytes, "findings": findings, "inventories": inventory}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=pathlib.Path)
    parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--arch", required=True, choices=("arm64", "x64"))
    parser.add_argument("--deny-patterns", type=pathlib.Path)
    parser.add_argument("--private-prefix", action="append", default=[str(pathlib.Path.home())],
                        help="Always reject this builder prefix, even when present in the baseline. Repeat for other build hosts.")
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.artifact.suffix == ".dmg":
        with tempfile.TemporaryDirectory(prefix="tplus-audit-") as mount:
            subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, str(args.artifact)], check=True, stdout=subprocess.DEVNULL)
            try:
                apps = list(pathlib.Path(mount).glob("*.app"))
                if len(apps) != 1:
                    raise ValueError("Expected exactly one app")
                report = audit(apps[0], args)
            finally:
                subprocess.run(["hdiutil", "detach", mount], check=True, stdout=subprocess.DEVNULL)
    else:
        report = audit(args.artifact, args)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "inventories"}, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
