"""Fail packaging when framework assemblies, native assets or aligned versions are missing."""
import json, pathlib, zipfile, xml.etree.ElementTree as ET
root=pathlib.Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
packages=list((root/'artifacts/nuget').glob('*.nupkg'))
assert len(packages)==1, f'Expected one NuGet package, found {packages}'
with zipfile.ZipFile(packages[0]) as archive:
    names=archive.namelist()
    for required in ['lib/net8.0/DrawingWeb.Blazor.dll','lib/net10.0/DrawingWeb.Blazor.dll','staticwebassets/engine/bridge.js','staticwebassets/engine/web.js','staticwebassets/engine/io.js','README.md']:
        assert required in names, f'Missing {required}'
    nuspec=ET.fromstring(archive.read(next(n for n in names if n.endswith('.nuspec'))))
    actual=next(e.text for e in nuspec.iter() if e.tag.endswith('}version'))
    assert actual==version, f'Version mismatch {actual} != {version}'
    assert not any('/node_modules/' in n for n in names)
print('NuGet contents verified: net8/net10 assemblies, native engine and bridge, README and aligned version.')
