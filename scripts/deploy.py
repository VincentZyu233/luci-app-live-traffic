from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def run(command: list[str], dry_run: bool = False) -> None:
    print("+", subprocess.list2cmdline(command))
    if not dry_run:
        subprocess.run(command, check=True)


def ssh_base(args: argparse.Namespace) -> list[str]:
    command = [
        "ssh", "-p", str(args.port), "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
    ]
    if args.identity:
        command.extend(["-i", str(args.identity)])
    return command


def target(args: argparse.Namespace) -> str:
    return f"{args.user}@{args.host}"


def remote(args: argparse.Namespace, command: str) -> None:
    run([*ssh_base(args), target(args), command], args.dry_run)


def copy_tree(args: argparse.Namespace, source: Path, destination: str) -> None:
    sources = [str(source)] if source.is_file() else [str(path) for path in source.iterdir()]
    command = [
        "scp", "-P", str(args.port), "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes", "-r",
    ]
    if args.identity:
        command.extend(["-i", str(args.identity)])
    run([*command, *sources, f"{target(args)}:{destination}"], args.dry_run)


def deploy(args: argparse.Namespace) -> None:
    prefix = "proxychains4 " if args.proxychains else ""
    install = (
        "opkg list-installed | grep -q '^nlbwmon ' || "
        f"(({prefix}opkg update || true) && {prefix}opkg install nlbwmon rpcd-mod-ucode); "
        "/etc/init.d/nlbwmon enable; /etc/init.d/nlbwmon start"
    )
    remote(args, install)
    copy_tree(args, REPO_ROOT / "root" / "usr", "/usr/")
    copy_tree(
        args,
        REPO_ROOT / "root" / "etc" / "config" / "live_traffic",
        "/tmp/live_traffic.default",
    )
    remote(
        args,
        "mkdir -p /etc/config; "
        "[ -e /etc/config/live_traffic ] || cp /tmp/live_traffic.default /etc/config/live_traffic; "
        "rm -f /tmp/live_traffic.default",
    )
    copy_tree(args, REPO_ROOT / "htdocs", "/www/")
    remote(
        args,
        "chmod 755 /usr/share/rpcd/ucode/luci.live_traffic.uc; "
        "rm -f /tmp/luci-indexcache; rm -rf /tmp/luci-modulecache; "
        "/etc/init.d/rpcd restart; sleep 1; ubus -S call luci.live_traffic settings",
    )


def uninstall(args: argparse.Namespace) -> None:
    purge = " /etc/config/live_traffic" if args.purge else ""
    remote(
        args,
        "ubus -S call luci.live_traffic restore '{}' >/dev/null 2>&1 || true; "
        "rm -f /usr/share/luci/menu.d/luci-app-live-traffic.json "
        "/usr/share/rpcd/acl.d/luci-app-live-traffic.json "
        f"/usr/share/rpcd/ucode/luci.live_traffic.uc{purge}; "
        "rm -rf /www/luci-static/resources/live-traffic "
        "/www/luci-static/resources/view/live-traffic; "
        "rm -f /tmp/luci-indexcache; rm -rf /tmp/luci-modulecache; "
        "/etc/init.d/rpcd restart",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deploy the LuCI application over SSH.")
    parser.add_argument("action", choices=("deploy", "uninstall"))
    parser.add_argument("--host", required=True, help="OpenWrt hostname or IP address")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", default="root")
    parser.add_argument("--identity", type=Path, help="SSH private key")
    parser.add_argument("--proxychains", action="store_true")
    parser.add_argument("--purge", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    if args.action == "deploy":
        deploy(args)
    else:
        uninstall(args)


if __name__ == "__main__":
    main()
