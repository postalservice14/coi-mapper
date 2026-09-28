import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCoiMap } from '../coimap/useCoiMap';
import { MapView } from '../map/MapView';
import type { TileHit } from '../map/scene';
import type { LayerName } from '../coimap/types';
import { DropZone } from './DropZone';
import { Sidebar } from './Sidebar';
import { Inspector } from './Inspector';
import { StatusBar } from './StatusBar';
import { VehiclesDialog } from './VehiclesDialog';

const DEFAULT_VISIBILITY: Record<LayerName, boolean> = {
  terrain: true,
  surfaces: true,
  deposits: false,
  designations: false,
  entities: true,
  transports: true,
  power: false,
  // Off by default: zones tint the terrain, so turning them on is a deliberate act.
  zones: false,
  grid: true,
};

export function App() {
  const { doc, error, progress, fileName, load, reset } = useCoiMap();
  const [visibility, setVisibility] = useState(DEFAULT_VISIBILITY);
  const [selected, setSelected] = useState(-1);
  // Where on the map the selection was clicked. A pipe under a belt shares that tile with
  // it, and the inspector lists the whole stack there; null for a search pick.
  const [selectedAt, setSelectedAt] = useState<{ tx: number; ty: number } | null>(null);
  const [hit, setHit] = useState<TileHit | null>(null);
  const [focus, setFocus] = useState<{ tx: number; ty: number } | null>(null);
  const [showFleet, setShowFleet] = useState(false);

  const toggle = useCallback((layer: LayerName) => {
    setVisibility((v) => ({ ...v, [layer]: !v[layer] }));
  }, []);

  const select = useCallback((index: number, at: { tx: number; ty: number } | null) => {
    setSelected(index);
    setSelectedAt(index >= 0 ? at : null);
  }, []);

  const pick = useCallback((index: number) => {
    setSelected(index);
    setSelectedAt(null);
    if (index >= 0 && doc) {
      const e = doc.entities[index]!;
      setFocus({ tx: e.x + e.w / 2, ty: e.y + e.h / 2 });
    }
  }, [doc]);

  // The thumbnail comes out of the save as raw JPEG bytes; wrap it in an object URL
  // and release it when the document changes.
  const thumbnailUrl = useMemo(() => {
    if (!doc?.thumbnail) return null;
    return URL.createObjectURL(new Blob([doc.thumbnail as BlobPart], { type: 'image/jpeg' }));
  }, [doc]);
  useEffect(() => () => { if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl); }, [thumbnailUrl]);

  useEffect(() => { setSelected(-1); setSelectedAt(null); setFocus(null); setShowFleet(false); }, [doc]);

  if (!doc) return <DropZone onFile={load} progress={progress} error={error} />;

  const { manifest } = doc;
  return (
    <div className="app">
      <header className="topbar">
        {thumbnailUrl && <img className="thumb" src={thumbnailUrl} alt="" />}
        <div className="grow">
          <h1>{manifest.game.mapName}</h1>
          <p className="muted">
            Captain of Industry {manifest.game.version}
            <span className="sep">·</span>
            {manifest.counts.entities.toLocaleString()} buildings
            <span className="sep">·</span>
            {manifest.counts.transports.toLocaleString()} transport runs
            {fileName && <><span className="sep">·</span><code>{fileName}</code></>}
          </p>
        </div>
        <button onClick={() => setShowFleet(true)}>Vehicles</button>
        <button onClick={reset}>Load another map</button>
      </header>

      <div className="body">
        <Sidebar doc={doc} visibility={visibility} onToggle={toggle} onPick={pick} />
        <main className="stage">
          <MapView
            doc={doc}
            visibility={visibility}
            selected={selected}
            onSelect={select}
            onHover={setHit}
            focus={focus}
          />
        </main>
        {selected >= 0 && (
          <Inspector doc={doc} selected={selected} at={selectedAt} onSelect={select} onClose={() => select(-1, null)} />
        )}
      </div>

      <StatusBar doc={doc} hit={hit} />
      <VehiclesDialog
        census={manifest.vehicles}
        zones={manifest.zones}
        open={showFleet}
        onClose={() => setShowFleet(false)}
      />
    </div>
  );
}
