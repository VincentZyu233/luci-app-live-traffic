#!/usr/bin/env python3
"""Run browser acceptance checks against LALT on a real OpenWrt router.

Configuration priority is: CLI arguments > process environment > .env file >
built-in defaults. The default .env file is scripts/test/.env and is ignored by
Git. Never put private router addresses, browser paths, or credentials in this
source file.

Typical uses:
  python scripts/test/webui_e2e.py
  python scripts/test/webui_e2e.py --headed --slow-mo-ms 250
  python scripts/test/webui_e2e.py --url https://192.168.5.1 --page overview
  python scripts/test/webui_e2e.py --quality ultra --viewport desktop
  python scripts/test/webui_e2e.py --password-file path/to/password.txt

Screenshots can contain private IP addresses, MAC addresses, and device names.
Keep the generated tmp/browser-debug directory private.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = Path(__file__).with_name(".env")
DEFAULT_URL = "https://192.168.5.1"
PAGES = ("overview", "devices", "settings")
QUALITIES = ("auto", "low", "medium", "high", "ultra")
VIEWPORTS = {
    "desktop": {"width": 1440, "height": 1000, "is_mobile": False},
    "mobile": {"width": 390, "height": 844, "is_mobile": True},
}


@dataclass(frozen=True)
class Config:
    url: str
    username: str
    password: str
    browser_path: Path | None
    output_dir: Path
    headless: bool
    pages: tuple[str, ...]
    qualities: tuple[str, ...]
    viewports: tuple[str, ...]
    settle_seconds: float
    slow_mo_ms: int
    hold_seconds: float
    timeout_ms: int


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Test LALT on a real OpenWrt LuCI instance with Playwright."
    )
    result.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    result.add_argument("--url", help="LuCI origin or any LALT page URL")
    result.add_argument("--username")
    result.add_argument(
        "--password-file",
        type=Path,
        help="Read the password from a private UTF-8 text file",
    )
    result.add_argument("--browser-path", type=Path)
    result.add_argument("--output-dir", type=Path)
    mode = result.add_mutually_exclusive_group()
    mode.add_argument("--headless", dest="headless", action="store_true")
    mode.add_argument("--headed", dest="headless", action="store_false")
    result.set_defaults(headless=None)
    result.add_argument("--page", action="append", choices=("all", *PAGES))
    result.add_argument("--quality", action="append", choices=("all", *QUALITIES))
    result.add_argument("--viewport", action="append", choices=("all", *VIEWPORTS))
    result.add_argument("--settle-seconds", type=float)
    result.add_argument("--slow-mo-ms", type=int)
    result.add_argument("--hold-seconds", type=float)
    result.add_argument("--timeout-ms", type=int)
    return result


def parse_bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def parse_number(value: str, name: str, cast: Callable[[str], Any]) -> Any:
    try:
        return cast(value)
    except ValueError as error:
        raise ValueError(f"{name} has an invalid numeric value") from error


def expand_values(
    cli_values: list[str] | None,
    env_value: str | None,
    allowed: tuple[str, ...],
) -> tuple[str, ...]:
    values = cli_values or [item.strip() for item in (env_value or "all").split(",")]
    if "all" in values:
        return allowed
    invalid = [value for value in values if value not in allowed]
    if invalid:
        raise ValueError(f"Unsupported value(s): {', '.join(invalid)}")
    return tuple(dict.fromkeys(values))


def first_value(
    cli_value: Any,
    environment: dict[str, str],
    dotenv: dict[str, str | None],
    key: str,
    default: Any,
) -> Any:
    if cli_value is not None:
        return cli_value
    if key in environment:
        return environment[key]
    if key in dotenv and dotenv[key] is not None:
        return dotenv[key]
    return default


def read_password(
    args: argparse.Namespace,
    environment: dict[str, str],
    dotenv: dict[str, str | None],
) -> str:
    if args.password_file is not None:
        return args.password_file.expanduser().read_text(encoding="utf-8").rstrip("\r\n")
    if "LALT_WEBUI_PASSWORD" in environment:
        return environment["LALT_WEBUI_PASSWORD"]
    if dotenv.get("LALT_WEBUI_PASSWORD") is not None:
        return dotenv["LALT_WEBUI_PASSWORD"] or ""
    if sys.stdin.isatty():
        return getpass.getpass("OpenWrt WebUI password (empty is allowed): ")
    return ""


def configured_path(value: str | Path | None) -> Path | None:
    if value is None or not str(value).strip():
        return None
    return Path(value).expanduser().resolve()


def resolve_output_dir(value: str | Path | None) -> Path:
    base = Path(value) if value else REPO_ROOT / "tmp" / "browser-debug"
    if not base.is_absolute():
        base = REPO_ROOT / base
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return base.resolve() / stamp


def build_config(args: argparse.Namespace) -> Config:
    try:
        from dotenv import dotenv_values
    except ImportError as error:
        raise RuntimeError(
            "python-dotenv is missing; install scripts/test/requirements.txt"
        ) from error

    dotenv = {
        key: value
        for key, value in dotenv_values(args.env_file.expanduser()).items()
        if isinstance(key, str)
    }
    environment = dict(os.environ)

    headless_raw = first_value(
        args.headless, environment, dotenv, "LALT_HEADLESS", "true"
    )
    headless = (
        headless_raw
        if isinstance(headless_raw, bool)
        else parse_bool(str(headless_raw), "LALT_HEADLESS")
    )
    pages_raw = first_value(None, environment, dotenv, "LALT_PAGES", "all")
    qualities_raw = first_value(None, environment, dotenv, "LALT_QUALITIES", "all")
    viewports_raw = first_value(None, environment, dotenv, "LALT_VIEWPORTS", "all")
    settle_raw = first_value(
        args.settle_seconds, environment, dotenv, "LALT_SETTLE_SECONDS", "3"
    )
    slow_raw = first_value(
        args.slow_mo_ms, environment, dotenv, "LALT_SLOW_MO_MS", "0"
    )
    hold_raw = first_value(
        args.hold_seconds, environment, dotenv, "LALT_HOLD_SECONDS", "0"
    )
    timeout_raw = first_value(
        args.timeout_ms, environment, dotenv, "LALT_TIMEOUT_MS", "15000"
    )
    output_raw = first_value(
        args.output_dir, environment, dotenv, "LALT_OUTPUT_DIR", None
    )
    browser_raw = first_value(
        args.browser_path, environment, dotenv, "LALT_BROWSER_PATH", None
    )

    config = Config(
        url=str(first_value(args.url, environment, dotenv, "LALT_WEBUI_URL", DEFAULT_URL)),
        username=str(
            first_value(args.username, environment, dotenv, "LALT_WEBUI_USERNAME", "root")
        ),
        password=read_password(args, environment, dotenv),
        browser_path=configured_path(browser_raw),
        output_dir=resolve_output_dir(output_raw),
        headless=headless,
        pages=expand_values(args.page, str(pages_raw), PAGES),
        qualities=expand_values(args.quality, str(qualities_raw), QUALITIES),
        viewports=expand_values(args.viewport, str(viewports_raw), tuple(VIEWPORTS)),
        settle_seconds=parse_number(str(settle_raw), "settle seconds", float),
        slow_mo_ms=parse_number(str(slow_raw), "slow motion", int),
        hold_seconds=parse_number(str(hold_raw), "hold seconds", float),
        timeout_ms=parse_number(str(timeout_raw), "timeout", int),
    )
    if config.settle_seconds < 0 or config.hold_seconds < 0:
        raise ValueError("Timing values cannot be negative")
    if config.slow_mo_ms < 0 or config.timeout_ms <= 0:
        raise ValueError("slow-mo must be non-negative and timeout must be positive")
    if config.browser_path is not None and not config.browser_path.is_file():
        raise FileNotFoundError("Configured browser executable does not exist")
    return config


def find_browser(configured: Path | None) -> Path | None:
    if configured is not None:
        return configured

    candidates: list[Path] = []
    if platform.system() == "Windows":
        for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.environ.get(variable)
            if root:
                candidates.extend(
                    [
                        Path(root) / "Google/Chrome/Application/chrome.exe",
                        Path(root) / "Microsoft/Edge/Application/msedge.exe",
                        Path(root) / "Chromium/Application/chrome.exe",
                    ]
                )
    else:
        candidates.extend(
            Path(path)
            for path in (
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/usr/bin/microsoft-edge",
            )
        )
    return next((path.resolve() for path in candidates if path.is_file()), None)


def route_urls(configured_url: str) -> tuple[str, dict[str, str], str]:
    raw = configured_url.strip()
    if "://" not in raw:
        raw = "https://" + raw
    parsed = urlsplit(raw)
    if not parsed.hostname:
        raise ValueError("The WebUI URL must include a hostname")
    origin = urlunsplit((parsed.scheme or "https", parsed.netloc, "", "", ""))
    luci_root = "/cgi-bin/luci"
    if "/cgi-bin/luci" in parsed.path:
        luci_root = parsed.path.split("/cgi-bin/luci", 1)[0] + "/cgi-bin/luci"
    routes = {
        page: origin + luci_root + "/admin/status/live-traffic/" + page
        for page in PAGES
    }
    return origin, routes, parsed.hostname


def redactor(config: Config, origin: str) -> Callable[[Any], str]:
    secrets = [
        (config.password if len(config.password) >= 4 else "", "<password>"),
        (str(config.browser_path or ""), "<browser>"),
        (origin, "<target>"),
    ]

    def redact(value: Any) -> str:
        text = str(value)
        for secret, replacement in secrets:
            if secret:
                text = text.replace(secret, replacement)
        return text

    return redact


CANVAS_METRICS = """
canvases => canvases.map((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, width, height).data;
    const pixelStep = Math.max(4, Math.floor(data.length / 16000 / 4) * 4);
    let visible = 0;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += pixelStep) {
        const alpha = data[index + 3];
        if (alpha > 0)
            visible++;
        hash ^= data[index] | (data[index + 1] << 8) | (data[index + 2] << 16) | (alpha << 24);
        hash = Math.imul(hash, 16777619);
    }
    return { width, height, visible, hash: hash >>> 0 };
})
"""


def canvas_metrics(page: Any) -> list[dict[str, int]]:
    return page.locator("canvas.lt-chart").evaluate_all(CANVAS_METRICS)


def login(page: Any, url: str, username: str, password: str, timeout_ms: int) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    username_input = page.locator('input[name="luci_username"]')
    if username_input.count():
        username_input.fill(username)
        password_input = page.locator('input[name="luci_password"]')
        password_input.fill(password)
        password_input.press("Enter")
    page.locator(".lt-app").wait_for(state="visible", timeout=timeout_ms)
    if page.locator('input[name="luci_password"]').count():
        raise RuntimeError("LuCI login did not complete")


def quality_control_value(page: Any, page_name: str) -> str | None:
    if page_name == "settings":
        active = page.locator(".lt-quality-option.active")
        return active.get_attribute("data-quality") if active.count() else None
    control = page.locator(".lt-quality-select")
    return control.input_value() if control.count() else None


def add_issue(report: dict[str, Any], case_id: str, kind: str, message: str) -> None:
    report["issues"].append({"case": case_id, "kind": kind, "message": message})


def run_matrix(config: Config) -> tuple[dict[str, Any], int]:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError(
            "Playwright is missing; install scripts/test/requirements.txt"
        ) from error

    origin, routes, _hostname = route_urls(config.url)
    redact = redactor(config, origin)
    config.output_dir.mkdir(parents=True, exist_ok=False)
    report: dict[str, Any] = {
        "started_at": datetime.now(UTC).isoformat(),
        "headless": config.headless,
        "matrix": {
            "pages": list(config.pages),
            "qualities": list(config.qualities),
            "viewports": list(config.viewports),
        },
        "browser": {},
        "cases": [],
        "issues": [],
    }
    browser_path = find_browser(config.browser_path)
    report["browser"]["executable"] = browser_path.name if browser_path else "bundled"
    current_case = {"id": ""}

    try:
        with sync_playwright() as playwright:
            launch: dict[str, Any] = {
                "headless": config.headless,
                "slow_mo": config.slow_mo_ms,
            }
            if browser_path is not None:
                launch["executable_path"] = str(browser_path)
            try:
                browser = playwright.chromium.launch(**launch)
            except PlaywrightError as error:
                raise RuntimeError(
                    "Unable to launch Chromium; configure LALT_BROWSER_PATH or run "
                    "'python -m playwright install chromium'"
                ) from error
            report["browser"]["version"] = browser.version

            for viewport_name in config.viewports:
                viewport = VIEWPORTS[viewport_name]
                context = browser.new_context(
                    ignore_https_errors=True,
                    viewport={"width": viewport["width"], "height": viewport["height"]},
                    screen={"width": viewport["width"], "height": viewport["height"]},
                    is_mobile=viewport["is_mobile"],
                    has_touch=viewport["is_mobile"],
                    locale="zh-CN",
                )
                page = context.new_page()
                page.set_default_timeout(config.timeout_ms)

                def console_message(message: Any) -> None:
                    if current_case["id"] and message.type == "error":
                        add_issue(
                            report,
                            current_case["id"],
                            "console.error",
                            redact(message.text),
                        )

                def page_error(error: Any) -> None:
                    if current_case["id"]:
                        add_issue(
                            report,
                            current_case["id"],
                            "pageerror",
                            redact(error),
                        )

                def failed_request(request: Any) -> None:
                    # LuCI polling requests can be intentionally cancelled when
                    # the matrix navigates to the next page or closes a context.
                    if request.failure == "net::ERR_ABORTED":
                        return
                    if current_case["id"] and request.url.startswith(origin):
                        add_issue(
                            report,
                            current_case["id"],
                            "requestfailed",
                            redact(f"{request.method} {request.url}: {request.failure}"),
                        )

                def bad_response(response: Any) -> None:
                    if (
                        current_case["id"]
                        and response.url.startswith(origin)
                        and response.status >= 400
                        and not response.url.endswith("/favicon.ico")
                    ):
                        add_issue(
                            report,
                            current_case["id"],
                            "http",
                            redact(f"HTTP {response.status}: {response.url}"),
                        )

                page.on("console", console_message)
                page.on("pageerror", page_error)
                page.on("requestfailed", failed_request)
                page.on("response", bad_response)

                # Some LuCI builds answer the first unauthenticated route request
                # with 403 before rendering or redirecting to the login form.
                current_case["id"] = ""
                try:
                    login(
                        page,
                        routes["overview"],
                        config.username,
                        config.password,
                        config.timeout_ms,
                    )
                except Exception as error:
                    add_issue(
                        report,
                        f"{viewport_name}/login",
                        "login",
                        redact(error),
                    )
                    context.close()
                    continue

                for quality in config.qualities:
                    current_case["id"] = f"{viewport_name}/{quality}/select"
                    try:
                        page.goto(
                            routes["overview"],
                            wait_until="domcontentloaded",
                            timeout=config.timeout_ms,
                        )
                        page.locator(".lt-app").wait_for(
                            state="visible", timeout=config.timeout_ms
                        )
                        selector = page.locator(".lt-quality-select")
                        selector.select_option(quality)
                        page.wait_for_function(
                            "value => localStorage.getItem('lalt.uiQuality') === value",
                            arg=quality,
                        )
                    except Exception as error:
                        add_issue(report, current_case["id"], "quality-select", redact(error))
                        continue

                    for page_name in config.pages:
                        case_id = f"{viewport_name}/{quality}/{page_name}"
                        current_case["id"] = case_id
                        case: dict[str, Any] = {
                            "id": case_id,
                            "screenshot": f"{viewport_name}__{quality}__{page_name}.png",
                        }
                        try:
                            page.goto(
                                routes[page_name],
                                wait_until="domcontentloaded",
                                timeout=config.timeout_ms,
                            )
                            root = page.locator(".lt-app")
                            root.wait_for(state="visible", timeout=config.timeout_ms)
                            page.wait_for_timeout(round(config.settle_seconds * 1000))

                            title = page.locator(".lt-app h2").first.inner_text()
                            if "LALT" not in title:
                                add_issue(report, case_id, "title", "LALT title is missing")

                            stored = page.evaluate(
                                "localStorage.getItem('lalt.uiQuality')"
                            )
                            control = quality_control_value(page, page_name)
                            resolved = root.get_attribute("data-lalt-quality")
                            motion = root.get_attribute("data-lalt-motion")
                            case.update(
                                {
                                    "stored_quality": stored,
                                    "control_quality": control,
                                    "resolved_quality": resolved,
                                    "motion": motion,
                                }
                            )
                            if stored != quality or control != quality:
                                add_issue(
                                    report,
                                    case_id,
                                    "quality-persistence",
                                    "Stored value and visible control do not match",
                                )
                            if quality == "auto" and resolved not in {"low", "medium"}:
                                add_issue(
                                    report,
                                    case_id,
                                    "quality-resolution",
                                    "Auto quality must resolve to low or medium",
                                )
                            if quality != "auto" and resolved != quality:
                                add_issue(
                                    report,
                                    case_id,
                                    "quality-resolution",
                                    "Manual quality did not resolve exactly",
                                )

                            overflow = page.evaluate(
                                "document.documentElement.scrollWidth - "
                                "document.documentElement.clientWidth"
                            )
                            case["horizontal_overflow"] = overflow
                            if overflow > 2:
                                add_issue(
                                    report,
                                    case_id,
                                    "layout",
                                    f"Horizontal overflow is {overflow}px",
                                )

                            canvases = canvas_metrics(page)
                            case["canvases"] = canvases
                            if page_name == "overview" and len(canvases) < 2:
                                add_issue(
                                    report,
                                    case_id,
                                    "canvas",
                                    "Overview must contain two charts",
                                )
                            if page_name == "devices":
                                cards = page.locator(".lt-device").count()
                                if cards and len(canvases) != cards:
                                    add_issue(
                                        report,
                                        case_id,
                                        "canvas",
                                        "Device card and chart counts differ",
                                    )
                            for index, canvas in enumerate(canvases):
                                if (
                                    canvas["width"] <= 0
                                    or canvas["height"] <= 0
                                    or canvas["visible"] < 8
                                ):
                                    add_issue(
                                        report,
                                        case_id,
                                        "canvas",
                                        f"Canvas {index} is blank or has invalid dimensions",
                                    )

                            if quality == "ultra" and motion == "on" and canvases:
                                first_hashes = [canvas["hash"] for canvas in canvases]
                                page.wait_for_timeout(550)
                                second_hashes = [
                                    canvas["hash"] for canvas in canvas_metrics(page)
                                ]
                                animated = first_hashes != second_hashes
                                case["continuous_animation"] = animated
                                if not animated:
                                    add_issue(
                                        report,
                                        case_id,
                                        "animation",
                                        "Ultra quality canvas did not change between frames",
                                    )

                            page.screenshot(
                                path=config.output_dir / case["screenshot"],
                                full_page=True,
                            )
                        except Exception as error:
                            add_issue(report, case_id, "case", redact(error))
                            case["error"] = redact(error)
                        report["cases"].append(case)
                        print(f"[{len(report['cases']):02d}] {case_id}")

                if not config.headless and config.hold_seconds:
                    page.wait_for_timeout(round(config.hold_seconds * 1000))
                current_case["id"] = ""
                context.close()
            browser.close()
    except Exception as error:
        add_issue(report, "global", "fatal", redact(error))
    finally:
        report["finished_at"] = datetime.now(UTC).isoformat()
        report["success"] = not report["issues"]
        (config.output_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    return report, 0 if report["success"] else 1


def main() -> int:
    args = parser().parse_args()
    try:
        config = build_config(args)
        report, exit_code = run_matrix(config)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(f"Report: {config.output_dir / 'report.json'}")
    print(f"Cases: {len(report['cases'])}; issues: {len(report['issues'])}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
