"""Exercise packed-NuGet Server/WASM hosts and the exact GitHub Pages base path.
Keep console, network and DOM diagnostics even when application startup fails.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/blazor-browser"
OUT.mkdir(parents=True, exist_ok=True)
results = []
processes = []
logs = []


def start(command, cwd, name, env):
    log = open(OUT / (name + ".log"), "w", encoding="utf-8")
    logs.append(log)
    process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, **env})
    processes.append(process)
    return process


def wait_server(url, process):
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError(f"Host exited ({process.returncode}): {url}")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("Host did not start: " + url)


def exercise(browser, name, url):
    context = browser.new_context(viewport={"width": 1360, "height": 1100})
    page = context.new_page()
    diagnostic = {"host": name, "url": url, "errors": [], "console": [], "failedRequests": [], "httpErrors": [], "externalRequests": []}
    page.on("pageerror", lambda error: diagnostic["errors"].append(str(error)))
    page.on("console", lambda message: diagnostic["console"].append({"type": message.type, "text": message.text[:8000]}) if len(diagnostic["console"]) < 40 else None)
    page.on("requestfailed", lambda request: diagnostic["failedRequests"].append({"url": request.url, "failure": request.failure}))
    page.on("response", lambda response: diagnostic["httpErrors"].append({"url": response.url, "status": response.status}) if response.status >= 400 else None)
    page.on("request", lambda request: diagnostic["externalRequests"].append(request.url) if request.url.startswith("http") and urlsplit(request.url).hostname != "127.0.0.1" else None)
    try:
        page.goto(url)
        page.wait_for_function("""() => {
            const state = document.getElementById('ready-state')?.textContent;
            const error = document.getElementById('error')?.textContent?.trim();
            const banner = document.getElementById('blazor-error-ui');
            return state === 'Ready' || !!error || (banner && getComputedStyle(banner).display !== 'none');
        }""", timeout=120000)
        if page.locator("#ready-state").count() != 1 or page.locator("#ready-state").inner_text() != "Ready":
            raise AssertionError("Application failed before DrawingEditor.Ready")
        page.locator("#run-tests").click()
        page.wait_for_function("/^(PASS|FAIL)/.test(document.getElementById('self-test').textContent)", timeout=60000)
        outcome = page.locator("#self-test").inner_text()
        if not outcome.startswith("PASS"):
            raise AssertionError(outcome + "\n" + page.locator("#error").inner_text())
        page.locator("#large-document").click()
        page.wait_for_function("document.getElementById('json-preview').textContent.length>1024*1024", timeout=60000)
        page.locator("#add-shape").click()
        page.wait_for_function("document.getElementById('json-preview').textContent.includes('C# command')", timeout=60000)
        # Exercise a real InputBase edit, not just validation of its initial value.
        page.locator("form").get_by_role("button", name="Process", exact=False).click()
        page.locator("#save-form").click()
        page.wait_for_function("document.getElementById('form-status').textContent.startsWith('Valid')", timeout=30000)
        if "modified=True" not in page.locator("#form-status").inner_text():
            raise AssertionError("EditForm was not notified of the native edit")
        count = page.locator('canvas[role="application"]').count()
        page.locator("#toggle-editor").click()
        page.wait_for_function("document.querySelectorAll('canvas[role=application]').length===" + str(count - 1))
        page.locator("#toggle-editor").click()
        page.wait_for_function("document.getElementById('ready-state')?.textContent==='Ready'", timeout=60000)
        if page.locator('canvas[role="application"]').count() != count:
            raise AssertionError("Native control was not recreated")
        # A synchronous create failure must notify once and never recurse on render.
        page.get_by_text("Initialization failure and recovery test", exact=True).click()
        page.locator("#probe-start").click()
        page.wait_for_function("document.getElementById('probe-count').textContent==='1'", timeout=30000)
        for _ in range(4):
            page.locator("#probe-render").click()
        if page.locator("#probe-count").inner_text() != "1" or page.evaluate("globalThis.drawingwebFailureProbeAttempts") != 1:
            raise AssertionError("Failed initialization was retried during parent renders")
        if page.locator("#probe-ready").inner_text() != "False":
            raise AssertionError("A failed control signalled Ready")
        if "INITIALIZATION: Intentional lifecycle probe failure" not in page.locator("#probe-message").inner_text():
            raise AssertionError("Initialization failure was not reported accurately")
        page.locator("#probe-remove").click()
        page.wait_for_function("document.getElementById('probe-start').disabled===false")
        page.locator("#add-shape").click()
        if page.locator("#error").inner_text().strip():
            raise AssertionError(page.locator("#error").inner_text())
        if diagnostic["errors"] or diagnostic["externalRequests"] or any(item["type"] == "error" for item in diagnostic["console"]):
            raise AssertionError("Uncaught browser error, console error or unexpected external dependency")
        page.screenshot(path=str(OUT / (name + ".png")), full_page=True)
        results.append({"host": name, "integration": outcome, "largeStream": True, "editFormModified": True, "remount": True, "failureLifecycle": True, "externalRequests": diagnostic["externalRequests"]})
        print("PASS package-restored " + name + " integration, large stream, EditForm, remount and failure lifecycle", flush=True)
    except Exception as error:
        diagnostic["failure"] = str(error)
        try:
            diagnostic["dom"] = page.evaluate("""() => ({
                baseURI: document.baseURI,
                state: document.getElementById('ready-state')?.textContent,
                error: document.getElementById('error')?.textContent,
                body: document.body.innerText.slice(0, 8000),
                scripts: [...document.scripts].map(s => s.src)
            })""")
            page.screenshot(path=str(OUT / (name + "-failure.png")), full_page=True)
        except Exception as capture_error:
            diagnostic["captureError"] = str(capture_error)
        results.append({"host": name, "success": False, "failure": str(error)})
        print("HOST FAILURE DIAGNOSTICS\n" + json.dumps(diagnostic, indent=2), flush=True)
        raise
    finally:
        (OUT / (name + "-diagnostics.json")).write_text(json.dumps(diagnostic, indent=2), encoding="utf-8")
        context.close()


try:
    server = start(["dotnet", "DrawingWeb.ServerSample.dll", "--urls", "http://127.0.0.1:5099"], ROOT / "artifacts/server", "server", {"ASPNETCORE_ENVIRONMENT": "Production"})
    static = start(["node", "scripts/serve.mjs", "artifacts/pages-root"], ROOT, "static", {"PORT": "4191"})
    wait_server("http://127.0.0.1:5099/", server)
    wait_server("http://127.0.0.1:4191/DrawingWeb/blazor/", static)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            exercise(browser, "server", "http://127.0.0.1:5099/")
            exercise(browser, "wasm", "http://127.0.0.1:4191/DrawingWeb/blazor/")
            page = browser.new_page()
            page.goto("http://127.0.0.1:4191/DrawingWeb/")
            page.wait_for_function("!!window.studio", timeout=30000)
            if page.locator(".stencil").count() != 11:
                raise AssertionError("Pages studio base-path smoke failed")
            results.append({"host": "pages-studio", "basePath": "/DrawingWeb/", "success": True})
        finally:
            browser.close()
finally:
    for process in processes:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    for log in logs:
        log.close()
    (OUT / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
