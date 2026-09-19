"""Package-restored Blazor Server/WASM integration. Requires dotnet publish outputs.
CI runs against the same /DrawingWeb/blazor/ base path deployed to GitHub Pages."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/blazor-browser"
OUT.mkdir(parents=True, exist_ok=True)
server_log = open(OUT / "server.log", "w")
server = subprocess.Popen(["dotnet", "DrawingWeb.ServerSample.dll", "--urls", "http://127.0.0.1:5099"], cwd=ROOT / "artifacts/server", stdout=server_log, stderr=subprocess.STDOUT, env={**os.environ, "ASPNETCORE_ENVIRONMENT": "Production"})
static = subprocess.Popen(["node", "scripts/serve.mjs", "artifacts/pages-root"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PORT": "4191"})
results = []

def wait_server(url):
    for _ in range(120):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("Host did not start: " + url)

try:
    wait_server("http://127.0.0.1:5099/")
    wait_server("http://127.0.0.1:4191/DrawingWeb/blazor/")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        for name, url in [("server", "http://127.0.0.1:5099/"), ("wasm", "http://127.0.0.1:4191/DrawingWeb/blazor/")]:
            context = browser.new_context(viewport={"width": 1360, "height": 1100})
            page = context.new_page()
            errors, external = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: external.append(request.url) if request.url.startswith("http") and "127.0.0.1" not in request.url else None)
            page.goto(url)
            page.wait_for_function("document.getElementById('ready-state')?.textContent==='Ready'", timeout=120000)
            page.locator("#run-tests").click()
            page.wait_for_function("/^(PASS|FAIL)/.test(document.getElementById('self-test').textContent)", timeout=60000)
            outcome = page.locator("#self-test").inner_text()
            if not outcome.startswith("PASS"):
                raise AssertionError(name + ": " + outcome + "\n" + page.locator("#error").inner_text())
            # Actual one-MiB outbound .NET stream and returned typed model.
            page.locator("#large-document").click()
            page.wait_for_function("document.getElementById('json-preview').textContent.length>1024*1024", timeout=60000)
            page.locator("#add-shape").click()
            page.wait_for_function("document.getElementById('json-preview').textContent.includes('C# command')", timeout=60000)
            # Form control must be able to flush and validate; the stream is not capped to a diagnostic sample.
            page.locator("#save-form").click()
            page.wait_for_function("document.getElementById('form-status').textContent.startsWith('Valid')", timeout=30000)
            count = page.locator('canvas[role="application"]').count()
            page.locator("#toggle-editor").click()
            page.wait_for_function("document.querySelectorAll('canvas[role=application]').length===" + str(count - 1))
            page.locator("#toggle-editor").click()
            page.wait_for_function("document.getElementById('ready-state')?.textContent==='Ready'", timeout=60000)
            if page.locator('canvas[role="application"]').count() != count:
                raise AssertionError("Native control was not recreated")
            if page.locator("#error").inner_text().strip():
                raise AssertionError(name + ": " + page.locator("#error").inner_text())
            if errors or external:
                raise AssertionError(json.dumps({"errors": errors, "externalRequests": external}))
            page.screenshot(path=str(OUT / (name + ".png")), full_page=True)
            results.append({"host": name, "integration": outcome, "largeStream": True, "editForm": True, "remount": True, "externalRequests": external})
            print("PASS package-restored " + name + " integration, large stream, EditForm and remount", flush=True)
            context.close()
        page = browser.new_page()
        page.goto("http://127.0.0.1:4191/DrawingWeb/")
        page.wait_for_function("!!window.studio", timeout=30000)
        if page.locator(".stencil").count() != 11:
            raise AssertionError("Pages studio base-path smoke failed")
        results.append({"host": "pages-studio", "basePath": "/DrawingWeb/", "success": True})
        browser.close()
finally:
    server.terminate(); static.terminate()
    server.wait(timeout=15); static.wait(timeout=15); server_log.close()
    (OUT / "results.json").write_text(json.dumps(results, indent=2))
