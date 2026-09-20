"""Actual ribbon controls and native interop regression for live inheritance and fields."""
def run_inheritance_checks(page, check, require):
    page.evaluate('window.savedNext=structuredClone(studio.engine.document)')
    page.evaluate("""async()=>{const D=studio.Drawing,d=D.createDocument('Live features');d.pages[0].id='live-page';d.pages[0].name='Live page';d.pages[0].shapes=[D.createShape('rectangle',{id:'live-source',text:'Master text',x:100,y:100,style:{fill:'#ffffff'}})];await studio.replace(d);studio.engine.select(['live-source']);studio.workspace.setTab('insert');}""")
    def master():
        page.locator('[data-action="new-master"]').click()
        page.get_by_label('Master name',exact=True).fill('Live component')
        page.locator('#workspace-dialog').get_by_role('button',name='Apply',exact=True).click()
        page.wait_for_function('studio.engine.document.masters.length===1')
        page.evaluate("window.instanceId=studio.engine.instantiateMaster(studio.engine.document.masters[0].id,'live-page',420,140);studio.engine.select([instanceId]);studio.workspace.setTab('developer')")
        page.locator('[data-action="edit-master"]').click()
        page.get_by_label('Master text',exact=True).fill('Updated definition')
        page.get_by_label('Master fill',exact=True).fill('#2255aa')
        page.locator('#workspace-dialog').get_by_role('button',name='Apply',exact=True).click()
        page.wait_for_function("studio.engine.getShape(instanceId).text==='Updated definition'")
        require(page.evaluate("studio.engine.getShape(instanceId).style.fill==='#2255aa'"))
        page.evaluate("studio.engine.update(instanceId,{text:'Local override'})")
        page.locator('[data-action="restore-master"]').click()
        page.wait_for_function("studio.engine.getShape(instanceId).text==='Updated definition'")
        page.locator('[data-action="detach-master"]').click()
        page.wait_for_function('!studio.engine.getShape(instanceId).masterBinding')
    check('ribbon edits master definitions, restores local overrides and detaches live instances',master)
    def field():
        page.evaluate("studio.engine.update(instanceId,{text:''})")
        page.locator('[data-action="insert-field"]').click()
        page.get_by_label('Formula',exact=True).fill('PAGENAME()')
        page.locator('#workspace-dialog').get_by_role('button',name='Apply',exact=True).click()
        page.wait_for_function("studio.engine.getShape(instanceId).text==='Live page'")
        page.evaluate("studio.engine.updatePage('live-page',{name:'Renamed'})")
        require(page.evaluate("studio.engine.getShape(instanceId).text==='Renamed'&&studio.engine.getShape(instanceId).richText.paragraphs[0].runs.at(-1).field.formula==='PAGENAME()'"))
        page.locator('[data-action="freeze-fields"]').click()
        page.evaluate("studio.engine.updatePage('live-page',{name:'Frozen'})")
        require(page.evaluate("studio.engine.getShape(instanceId).text==='Renamed'"))
        page.locator('[data-action="activate-fields"]').click()
        page.wait_for_function("studio.engine.getShape(instanceId).text==='Frozen'")
    check('ribbon inserts formula-preserving live fields with explicit freeze and reactivation',field)
    def bridge_commands():
        require(page.evaluate("""async()=>{
          const B=globalThis.DrawingWebBridge||await import('./engine/bridge.js'),D=studio.Drawing,host=document.createElement('div');host.style.cssText='width:200px;height:200px';document.body.append(host);
          const b=B.create(host),e=B.getControl(b.id).engine;
          try {
            const master=B.command(b.id,'registerMaster',['Host','Tests',D.createShape('rectangle',{text:'Host text'})]);
            const sid=B.command(b.id,'insertMaster',[master,0,0]);
            B.command(b.id,'updateMaster',[master,{shape:{...structuredClone(e.document.masters[0].shape),text:'Changed'}}]);
            if(e.getShape(sid).text!=='Changed')return false;
            B.command(b.id,'richText',[sid,{paragraphs:[{runs:[{text:'cached',field:{formula:'PAGENAME()'}}]}]}]);
            B.command(b.id,'activateFields',[null]);if(e.getShape(sid).text!==e.document.pages[0].name)return false;
            B.command(b.id,'sheetCell',[sid,'User.Width',2]);B.command(b.id,'sheetCell',[sid,'Width',2,'SETATREF(User.Width)']);
            B.command(b.id,'sheetUserValue',[sid,'Width',3]);return e.getShape(sid).width===288;
          } finally{B.dispose(b.id);host.remove();}
        }"""))
    check('native interop exposes live master and field commands and disposes owned services',bridge_commands)
    page.evaluate('async()=>{await studio.replace(savedNext);studio.workspace.setTab("home");studio.workspace.setPane("format");}')
