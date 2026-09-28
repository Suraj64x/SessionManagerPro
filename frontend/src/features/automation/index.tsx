import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flame } from 'lucide-react';
import type { Contributions } from '../../contributions';
import { useApp, useEvent } from '../../app-context';
import { useStored } from '../../ui';
import { ScriptsView } from './ScriptsView';
import { SchedulesView } from './schedules';
import { RunsView } from './runs';
import { WarmupDialog, WarmupSetsSection } from './warmup';
import { openWarmup, useWarmupIds } from './store';
import { api } from './api';
import type { Schedule } from './types';
import './automation.css';

type AutoTab = 'library' | 'schedules' | 'runs';
const TABS: Array<[AutoTab, string]> = [
  ['library', 'Library'],
  ['schedules', 'Schedules'],
  ['runs', 'Runs'],
];

// Automation: the script library (ScriptsView.tsx), schedules, runs and the warm-up.
export const AutomationView: React.FC<{ active: boolean }> = ({ active }) => {
  const { scripts, sessions, selectedIds, runs, refresh, runScript, setTab: setAppTab } = useApp();
  const [stored, setTab] = useStored<AutoTab>('automation.tab', 'library');
  const tab: AutoTab = TABS.some(([id]) => id === stored) ? stored : 'library';
  const [openRun, setOpenRun] = useState<string | null>(null);
  const warmIds = useWarmupIds();

  // Loaded once: this view stays mounted, and the server pushes every change as `schedule`.
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.schedules().then(
        (list) => {
          setSchedules(list);
          setLoadError(null);
        },
        (err) => setLoadError(err.message)
      ),
    []
  );
  useEffect(() => {
    load();
  }, [load]);
  useEvent('schedule', (list: Schedule[]) => {
    setSchedules(list);
    setLoadError(null);
  });
  // A server restart can lose a change made while the socket was down.
  useEvent('hello', load);

  const running = runs.filter((r) => Object.values(r.results).some((x) => x.state === 'pending' || x.state === 'running')).length;
  const tabs = (
    <div className="seg" role="group" aria-label="Automation view">
      {TABS.map(([id, label]) => (
        <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
          {label}
          {id === 'schedules' && schedules && <span className="n">{schedules.length}</span>}
          {id === 'runs' && running > 0 && <span className="n">{running}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {/* Kept mounted so an unsaved script survives a trip to another tab. */}
      <div style={{ display: tab === 'library' ? 'contents' : 'none' }}>
        <ScriptsView
          tabs={tabs}
          scripts={scripts}
          sessions={sessions}
          selectedIds={selectedIds}
          runs={runs}
          onChanged={refresh.scripts}
          onRun={runScript}
          onWarmup={openWarmup}
        />
      </div>
      {active && tab === 'schedules' && (
        <SchedulesView tabs={tabs} schedules={schedules} loadError={loadError} onReload={load} onChange={setSchedules} />
      )}
      {active && tab === 'runs' && <RunsView tabs={tabs} schedules={schedules || []} openRun={openRun} setOpenRun={setOpenRun} />}
      {/* Portaled: the row menu and bulk bar open it while this view is hidden. */}
      {warmIds &&
        createPortal(
          <WarmupDialog
            ids={warmIds}
            onClose={() => openWarmup(null)}
            onStarted={(run) => {
              openWarmup(null);
              setOpenRun(run.id);
              setTab('runs');
              setAppTab('automation');
            }}
          />,
          document.body
        )}
    </>
  );
};

export const contributions: Contributions = {
  bulkBar: ({ ids }) => (
    <button className="btn xs" onClick={() => openWarmup(ids)} title="Visit sites to collect cookies; opens profiles that aren’t running">
      <Flame size={12} /> Warm up…
    </button>
  ),
  rowMenu: ({ session, close }) => (
    <button onClick={() => (close(), openWarmup([session.id]))}>
      <Flame size={12} /> Warm up…
    </button>
  ),
  settingsSections: [{ id: 'warmup-sets', title: 'Warm-up site sets', render: () => <WarmupSetsSection /> }],
};
