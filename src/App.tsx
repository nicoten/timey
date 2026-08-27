import { useCallback, useEffect, useMemo, useState } from "react";

import {
  clientsList,
  entriesList,
  errorMessage,
  projectsList,
  type Client,
  type EntryDetail,
  type Project,
} from "./lib/api";
import { currentMonth, monthEndExclusive, monthStart, type MonthCursor } from "./lib/dates";
import { useUpdates } from "./lib/useUpdates";
import { DayPanel } from "./components/DayPanel";
import { MonthView } from "./components/MonthView";
import { SettingsView } from "./components/SettingsView";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button } from "./components/ui";
import "./styles.css";

type View = "month" | "settings";

export default function App() {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState<MonthCursor>(currentMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const [entries, setEntries] = useState<EntryDetail[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingMonth, setLoadingMonth] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const updates = useUpdates();

  const loadMonth = useCallback(async (target: MonthCursor) => {
    setLoadingMonth(true);
    try {
      setEntries(await entriesList(monthStart(target), monthEndExclusive(target)));
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    } finally {
      setLoadingMonth(false);
    }
  }, []);

  // Archived rows are loaded too: settings needs to show and restore them, while
  // the entry form offers only live projects.
  const loadCatalog = useCallback(async () => {
    try {
      const [loadedClients, loadedProjects] = await Promise.all([
        clientsList(true),
        projectsList(null, true),
      ]);
      setClients(loadedClients);
      setProjects(loadedProjects);
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void loadMonth(cursor);
  }, [cursor, loadMonth]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Escape closes the day panel.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedDay(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function changeMonth(next: MonthCursor) {
    setCursor(next);
    // The open day belongs to the month being left.
    setSelectedDay(null);
  }

  const liveProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === null),
    [projects],
  );

  return (
    <div className="app">
      {/*
        With the native title bar hidden, this rail is the only chrome and doubles
        as the window's drag handle. Tauri starts a drag only when the mousedown
        target itself carries the attribute, so the Settings button still clicks.
        The left cell is left empty for the traffic lights to sit over.
      */}
      <div className="rail" data-tauri-drag-region>
        <span />
        <span className="wordmark" data-tauri-drag-region>
          timey
        </span>
        <span className="rail-actions">
          {view === "month" ? (
            <Button variant="quiet" onClick={() => setView("settings")}>
              Settings
            </Button>
          ) : (
            <Button variant="quiet" onClick={() => setView("month")}>
              Calendar
            </Button>
          )}
        </span>
      </div>

      <UpdateBanner state={updates.state} onInstall={updates.install} onDismiss={updates.dismiss} />

      <div className="workspace">
        <main className="sheet">
          {loadError !== null && (
            <p className="error" role="alert">
              {loadError}
            </p>
          )}

          {view === "month" ? (
            <MonthView
              cursor={cursor}
              onCursorChange={changeMonth}
              entries={entries}
              loading={loadingMonth}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
            />
          ) : (
            <SettingsView
              clients={clients}
              projects={projects}
              onChanged={() => {
                void loadCatalog();
                void loadMonth(cursor);
              }}
              onBack={() => setView("month")}
              updates={updates}
            />
          )}
        </main>

        {view === "month" && selectedDay !== null && (
          <DayPanel
            date={selectedDay}
            entries={entries}
            projects={liveProjects}
            clients={clients}
            onClose={() => setSelectedDay(null)}
            onChanged={() => void loadMonth(cursor)}
            onOpenSettings={() => {
              setSelectedDay(null);
              setView("settings");
            }}
          />
        )}
      </div>
    </div>
  );
}
