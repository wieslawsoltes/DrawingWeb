"""Synchronous document/page transitions must leave the view and editor coherent."""


def run_replacement_checks(page, check, require):
    def probe(script):
        return page.evaluate("""() => {
            const D = studio.Drawing;
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px';
            document.body.append(host);
            const old = D.createDocument('Before replacement');
            old.pages[0].id = 'old-page';
            old.pages[0].shapes = [D.createShape('rectangle', {
                id: 'shared-shape', text: 'Before replacement', x: 80, y: 80
            })];
            const engine = new D.DiagramEngine(old);
            const control = new D.DrawingControl(host, {engine});
            const next = D.createDocument('After replacement');
            next.pages[0].id = 'new-page';
            next.pages[0].shapes = [D.createShape('rectangle', {
                id: 'shared-shape', text: 'After replacement', x: 120, y: 100
            })];
            try {
        """ + script + """
            } finally {
                control.dispose(); engine.dispose(); host.remove();
            }
        }""")

    def selected_page_replacement():
        require(probe("""
            engine.select(['shared-shape']);
            let observed = false;
            const unsubscribe = engine.selectionChanged.subscribe(() => {
                observed = control.pageId === 'new-page'
                    && host.querySelector('[role="option"]')?.textContent === 'After replacement'
                    && !control.canvas.hasAttribute('aria-activedescendant');
            });
            engine.replaceDocument(next);
            unsubscribe();
            control.render();
            return observed && control.pageId === 'new-page'
                && engine.selection.length === 0 && !engine.canUndo;
        """), 'Selection observers must see the replacement page and its accessible shapes immediately.')

    check('selected-page replacement reconciles accessibility before selection observers', selected_page_replacement)

    def cancel_stale_text():
        require(probe("""
            next.pages[0].id = 'old-page';
            for (const rich of [false, true]) {
                engine.replaceDocument(old);
                engine.select(['shared-shape']);
                if (rich) control.editRichText('shared-shape');
                else control.editText('shared-shape');
                const input = host.querySelector('textarea,[contenteditable="true"]');
                if (!input) return false;
                if (rich) input.textContent = 'Uncommitted old text';
                else input.value = 'Uncommitted old text';
                engine.replaceDocument(next);
                control.flush();
                if (host.querySelector('textarea,[contenteditable="true"]')
                    || engine.getShape('shared-shape').text !== 'After replacement'
                    || engine.canUndo) return false;
            }
            return control.pageId === 'old-page';
        """), 'Replacement must cancel old text even when the replacement reuses page and shape IDs.')

    check('replacement cancels plain and rich editors without committing into reused identities', cancel_stale_text)

    def page_removal_history():
        require(probe("""
            const added = engine.addPage('Second page');
            engine.add(added, D.createShape('rectangle', {id: 'second-shape', text: 'Second page shape'}));
            control.pageId = added;
            engine.select(['second-shape']);
            engine.removePage(added);
            control.render();
            if (control.pageId !== 'old-page' || engine.selection.length !== 0) return false;
            engine.undo();
            control.pageId = added;
            engine.select(['second-shape']);
            engine.redo();
            control.render();
            return control.pageId === 'old-page'
                && host.querySelector('[role="option"]')?.textContent === 'Before replacement';
        """), 'Removing or redoing removal of the selected page must synchronously select a valid fallback.')

    check('page removal and redo reconcile the selected page without observer errors', page_removal_history)
