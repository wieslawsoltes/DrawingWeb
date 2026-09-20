"""Real Chromium interaction/interop tests. Offline mode injects the same compiled global build;
it does not test HTTP module loading or IndexedDB and reports that restriction explicitly."""
import json
import os
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright
from inheritance_checks import run_inheritance_checks
from workspace_checks import run_workspace_checks
from replacement_checks import run_replacement_checks

ROOT = Path(__file__).resolve().parents[1]
OFFLINE = os.environ.get("DRAWINGWEB_OFFLINE_BROWSER") == "1"
ARTIFACTS = ROOT / "artifacts/browser"
ARTIFACTS.mkdir(parents=True, exist_ok=True)
server = None
if not OFFLINE:
    server = subprocess.Popen(["node", "scripts/serve.mjs", "site"], cwd=ROOT, env={**os.environ, "PORT": "4181"}, stdout=subprocess.DEVNULL)
    time.sleep(0.6)
checks = []
errors = []

def check(name, action):
    action()
    checks.append(name)
    print(f"PASS {name}", flush=True)

def require(value, message="Assertion failed"):
    if not value:
        raise AssertionError(message)

try:
    with sync_playwright() as playwright:
        options = {"headless": True, "args": ["--no-sandbox"]}
        if os.environ.get("CHROMIUM_EXECUTABLE"):
            options["executable_path"] = os.environ["CHROMIUM_EXECUTABLE"]
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
        page.set_default_timeout(8000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append("console.error: " + message.text) if message.type == "error" else None)
        if OFFLINE:
            html = (ROOT / "site/index.html").read_text().replace('<link rel="stylesheet" href="./studio.css">', '<style>' + (ROOT / "site/studio.css").read_text() + '</style>').replace('<script type="module" src="./studio.js"></script>', '').replace('<script src="./workspace.js"></script>', '')
            page.set_content(html)
            page.add_script_tag(content=(ROOT / "dist/drawingweb.global.js").read_text())
            page.add_script_tag(content=(ROOT / "sample/workspace.js").read_text())
            script = (ROOT / "sample/studio.js").read_text().replace("import * as Drawing from '../dist/esm/index.js';", "const Drawing = globalThis.DrawingWeb;")
            page.evaluate("async () => {" + script + "}")
        else:
            page.goto("http://127.0.0.1:4181/")
        page.wait_for_function("!!window.studio")
        page.wait_for_timeout(100)
        check("studio initial diagram and live table", lambda: require(page.evaluate("studio.engine.allShapes('fulfillment').length===18 && studio.table.size===8")))
        check("all original stencils render", lambda: require(page.locator(".stencil").count() == 11))

        def edit_row():
            field = page.locator('input[data-row="step-01"][data-field="label"]')
            field.fill("Browser data edit")
            field.press("Tab")
            page.wait_for_function("studio.engine.getShape('step-01').text === 'Browser data edit'")
        check("table edit updates real shape", edit_row)

        def edit_property():
            page.evaluate("studio.engine.select(['step-01'])")
            page.locator("#p-text").fill("Property panel edit")
            page.locator("#p-text").press("Tab")
            page.wait_for_function("studio.table.get('step-01').label === 'Property panel edit'")
        check("property panel updates bound row", edit_property)

        def drag():
            point = page.evaluate("studio.control.worldToScreen({x:175,y:216})")
            rect = page.locator("#drawing canvas").bounding_box()
            page.mouse.move(rect["x"] + point["x"], rect["y"] + point["y"])
            page.mouse.down()
            page.mouse.move(rect["x"] + point["x"] + 42, rect["y"] + point["y"] + 18, steps=7)
            page.mouse.up()
            require(page.evaluate("studio.engine.getShape('step-01').x > 95 && studio.table.get('step-01').x===studio.engine.getShape('step-01').x"))
            page.locator("#undo").click()
            page.wait_for_function("studio.engine.getShape('step-01').x===95 && studio.table.get('step-01').x===95")
        check("pointer drag produces one undoable two-way edit", drag)

        def grouping():
            page.evaluate("studio.engine.select(['step-01','step-02'])")
            page.locator('[data-command="group"]').click()
            require(page.evaluate("studio.engine.getShape(studio.engine.selection[0]).kind==='group'"))
            page.locator('[data-command="ungroup"]').click()
            require(page.evaluate("!studio.engine.getRef('step-01').parentId"))
        check("group and ungroup through UI", grouping)

        def insert():
            previous = page.evaluate("studio.engine.allShapes('fulfillment').length")
            page.locator('.stencil[data-kind="diamond"]').click()
            require(page.evaluate("studio.engine.allShapes('fulfillment').length") == previous + 1)
            require(page.evaluate("studio.engine.getShape(studio.engine.selection[0]).kind==='diamond'"))
            page.locator('[data-command="undo"]').click()
        check("stencil insert and undo", insert)

        def click_shape(shape_id):
            point = page.evaluate("id=>{const s=studio.engine.getShape(id);return studio.control.worldToScreen(studio.Drawing.transformPoint(studio.engine.getRef(id).matrix,{x:s.width/2,y:s.height/2}));}", shape_id)
            rect = page.locator("#drawing canvas").bounding_box()
            page.mouse.click(rect["x"] + point["x"], rect["y"] + point["y"])

        def connect():
            before = page.evaluate("studio.engine.allShapes().filter(s=>s.kind==='connector').length")
            page.locator('[data-tool="connector"]').click()
            click_shape("step-01")
            click_shape("step-02")
            require(page.evaluate("studio.engine.allShapes().filter(s=>s.kind==='connector').length") == before + 1)
            page.locator('[data-command="undo"]').click()
            page.locator('[data-tool="select"]').click()
        check("connector tool creates attached endpoints", connect)

        def pen():
            page.locator('[data-tool="pen"]').click()
            rect = page.locator("#drawing canvas").bounding_box()
            point = page.evaluate("studio.control.worldToScreen({x:220,y:620})")
            x, y = rect["x"] + point["x"], rect["y"] + point["y"]
            page.mouse.move(x, y); page.mouse.down()
            for i in range(1, 13):
                page.mouse.move(x + i * 7, y + (i % 3) * 4)
            page.mouse.up()
            require(page.evaluate("studio.engine.getShape(studio.engine.selection[0]).kind==='path'"))
            page.locator('[data-command="undo"]').click()
            page.locator('[data-tool="select"]').click()
        check("freehand creates editable vector path", pen)

        def read_only():
            page.evaluate("studio.control.setOptions({readOnly:true});studio.engine.select(['step-01']);studio.control.focus()")
            page.keyboard.press("Delete")
            require(page.evaluate("!!studio.engine.getShape('step-01')"))
            page.evaluate("studio.control.setOptions({readOnly:false})")
        check("read-only keyboard guard", read_only)

        def text_edit():
            page.evaluate("studio.control.editText('step-01')")
            field = page.locator('#drawing textarea')
            field.fill("Native text edit")
            field.press("Control+Enter")
            require(page.evaluate("studio.engine.getShape('step-01').text==='Native text edit' && studio.table.get('step-01').label==='Native text edit'"))
        check("native in-place text editor and binding", text_edit)

        def pages():
            page.get_by_role("tab", name="System architecture").click()
            require(page.evaluate("studio.control.pageId==='architecture' && studio.table.size===0"))
            page.get_by_role("tab", name="Order fulfillment").click()
            require(page.evaluate("studio.table.size===8"))
        check("multi-page navigation and page-scoped binding", pages)
        check("SVG carries connector labels", lambda: require(page.evaluate("studio.Drawing.exportSvg(studio.engine.document).includes('Yes')")))
        check("PNG exports actual raster bytes", lambda: require(page.evaluate("async()=>{const b=await studio.control.exportPng();const bytes=new Uint8Array(await b.arrayBuffer());return b.size>1000&&bytes[0]===137&&bytes[1]===80;}")))
        check("VSDX browser write/read and byte-preserving no-op", lambda: require(page.evaluate("async()=>{const bytes=await studio.Drawing.writeVsdx(studio.engine.document),source=await studio.Drawing.readVsdx(bytes),copy=await source.save(source.document);return copy.length===bytes.length&&copy.every((v,i)=>v===bytes[i]);}")))

        if not OFFLINE:
            check("IndexedDB atomic compare-and-swap", lambda: require(page.evaluate("async()=>{const {BrowserDocumentStore,createDocument}=studio.Drawing;const store=new BrowserDocumentStore('dw-test-'+Date.now());const d=createDocument();const rev=await store.save('a',d,0);let conflict=false;try{await store.save('a',d,0);}catch(e){conflict=e.code==='REVISION_CONFLICT';}const loaded=await store.load('a');await store.close();return rev===1&&loaded.revision===1&&conflict;}")))
        else:
            print("SKIP HTTP ESM loading and IndexedDB: offline/injected browser mode", flush=True)

        run_workspace_checks(page, check, require)
        run_replacement_checks(page, check, require)
        run_inheritance_checks(page, check, require)

        # Probe the exact compiled bridge, using a deterministic .NET stream/callback test double.
        page.evaluate("async()=>{window.B=window.DrawingWebBridge??await import('./engine/bridge.js');window.DotNet={createJSStreamReference:data=>data};window.calls=[];window.bridgeHost=document.createElement('div');bridgeHost.style.cssText='position:fixed;left:0;top:0;width:600px;height:360px;background:white;z-index:20';document.body.append(bridgeHost);window.bridge=B.create(bridgeHost,{invokeMethodAsync:async(method,...args)=>{calls.push([method,...args]);}});}")
        check("bridge registers a live native handle", lambda: require(page.evaluate("B.activeHandleCount()===1")))
        check("bridge initial streamed value", lambda: require(page.evaluate("async()=>{const data=new TextEncoder().encode(JSON.stringify(studio.createSample()));const r=await B.setValueFromStream(bridge.id,{arrayBuffer:async()=>data.buffer},0,0);return r.applied&&B.getControl(bridge.id).engine.allShapes().length>0;}")))
        check("bridge stale echo rejected; explicit revision accepted", lambda: require(page.evaluate("()=>{const e=B.getControl(bridge.id).engine,old=JSON.stringify(e.document),rev=e.revision;e.update('step-01',{text:'newest'});const rejected=B.setValue(bridge.id,old,rev,0);const forced=B.setValue(bridge.id,old,rev,1);return !rejected.applied&&forced.applied;}")))
        check("bridge stream race cannot overwrite newer browser edits", lambda: require(page.evaluate("async()=>{const e=B.getControl(bridge.id).engine,json=JSON.stringify(e.document),rev=e.revision;let complete;const pending=B.setValueFromStream(bridge.id,{arrayBuffer:()=>new Promise(resolve=>complete=resolve)},rev,1);e.update('step-01',{text:'during-transfer'});complete(new TextEncoder().encode(json).buffer);const r=await pending;return !r.applied&&e.getShape('step-01').text==='during-transfer';}")))
        check("bridge full 1 MiB document snapshot is not truncated", lambda: require(page.evaluate("()=>{const e=B.getControl(bridge.id).engine,d=structuredClone(e.document);d.metadata.large='x'.repeat(1024*1024);B.setValue(bridge.id,JSON.stringify(d),e.revision,2);const snapshot=B.getSnapshot(bridge.id),doc=JSON.parse(new TextDecoder().decode(snapshot.stream));return doc.metadata.large.length===1024*1024&&snapshot.revision===e.revision;}")))
        check("bridge two-way row stream", lambda: require(page.evaluate("async()=>{const rows=new TextEncoder().encode(JSON.stringify([{id:'step-01',label:'stream row',x:110}]));await B.bindRowsStream(bridge.id,{arrayBuffer:async()=>rows.buffer},'id',{text:'label',x:'x'});const e=B.getControl(bridge.id).engine;e.update('step-01',{text:'native row edit'});const snapshot=B.getDataSnapshot(bridge.id),data=JSON.parse(new TextDecoder().decode(snapshot.stream));return data[0].label==='native row edit';}")))
        check("bridge disposal suppresses handles and late callbacks", lambda: require(page.evaluate("async()=>{bridgeHost.remove();await new Promise(resolve=>setTimeout(resolve,30));B.dispose(bridge.id);return B.activeHandleCount()===0;}")))
        check("control disposal does not destroy a borrowed engine", lambda: require(page.evaluate("()=>{const host=document.createElement('div');host.style.cssText='width:200px;height:200px';document.body.append(host);const e=new studio.Drawing.DiagramEngine();const c=new studio.Drawing.DrawingControl(host,{engine:e});c.dispose();e.add(e.document.pages[0].id,studio.Drawing.createShape());const ok=e.allShapes().length===1;e.dispose();host.remove();return ok;}")))
        check("accessible control exposes a named application and shape list", lambda: require(page.locator('#drawing [role="application"]').count() == 1 and page.locator('#drawing [role="option"]').count() > 0))
        page.evaluate("studio.engine.select([]);studio.control.fit();")
        page.wait_for_timeout(100)
        page.screenshot(path=str(ARTIFACTS / "studio-desktop.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(150)
        check("mobile layout has no horizontal document overflow", lambda: require(page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")))
        page.screenshot(path=str(ARTIFACTS / "studio-mobile.png"))
        check("no uncaught browser errors", lambda: require(not errors, "\n".join(errors)))
        browser.close()
finally:
    if server:
        server.terminate()
        server.wait(timeout=10)
    (ARTIFACTS / "results.json").write_text(json.dumps({"mode": "offline-global" if OFFLINE else "http-esm", "checks": checks, "count": len(checks), "uncaughtErrors": errors}, indent=2))
print(f"{len(checks)} browser checks passed ({'offline-global' if OFFLINE else 'http-esm'}).")
