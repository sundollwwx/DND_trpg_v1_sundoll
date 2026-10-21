"""Compose real module files for legacy integration/source-contract tests."""
from pathlib import Path

def read_client_source(file):
    file=Path(file)
    source=file.read_text(encoding='utf-8')
    if file.name=='玩家.html':
        source+='\n'+(file.parent/'player/player.css').read_text(encoding='utf-8')+'\n'+(file.parent/'player/player.js').read_text(encoding='utf-8')
    elif file.name=='app.js':
        directory=file.parent.parent
        encounter_ui=(directory/'host/encounter-ui.js').read_text(encoding='utf-8')
        # Expand the production rendering modules at their actual source markers.
        # Missing markers deliberately fail rather than supplying an empty stub.
        source=source.replace(
            '// Initiative ribbon rendering is implemented in host/encounter-ui.js.',
            encounter_ui.split('// BEGIN RIBBON IMPLEMENTATION')[1].split('// END RIBBON IMPLEMENTATION')[0],
        ).replace(
            '// Encounter rendering is implemented in host/encounter-ui.js.',
            encounter_ui.split('// BEGIN ENCOUNTER IMPLEMENTATION')[1].split('// END ENCOUNTER IMPLEMENTATION')[0],
        )
        source+='\n'+encounter_ui.split('// END ENCOUNTER IMPLEMENTATION')[1]
        storage=(directory/'host/storage.js').read_text(encoding='utf-8')
        split=storage.index('const SAVE_ROOT_DIR =')
        source=source.replace('// Persistence is implemented in host/storage.js.',storage[:split]).replace('// Folder bridge and campaign catalog are implemented in host/storage.js.',storage[split:]).replace('// Campaign documents UI is implemented in host/documents.js.',(directory/'host/documents.js').read_text(encoding='utf-8'))
        source=source.replace('// Page initialization is implemented in host/bootstrap.js.',(directory/'host/bootstrap.js').read_text(encoding='utf-8'))
        source+='\n'+(directory/'host/music.js').read_text(encoding='utf-8')
    return source
