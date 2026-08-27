import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Tooltip } from "radix-ui";

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
import { applyThemeChoice, loadThemeChoice, type ThemeChoice } from "./lib/theme";
import { useUpdates } from "./lib/useUpdates";
import { DayPanel } from "./components/DayPanel";
import { MonthView } from "./components/MonthView";
import { SettingsView } from "./components/SettingsView";
import { UpdateBanner } from "./components/UpdateBanner";
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

  const [theme, setTheme] = useState<ThemeChoice>(loadThemeChoice);

  // Applied as an attribute on the document root, which the stylesheet keys off.
  useEffect(() => {
    applyThemeChoice(theme);
  }, [theme]);

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

  // Settings is reached from the application menu (Cmd+,) rather than a button
  // in the window; SettingsView's own back link returns to the calendar.
  useEffect(() => {
    const pending = listen("open-settings", () => setView("settings"));
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

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
    <Tooltip.Provider delayDuration={120} skipDelayDuration={300}>
      <div className="app">
        {/*
          macOS draws its own title bar left-aligned and offers no way to centre
          it, so the native title is empty and this strip is the title bar: the
          traffic lights float over its left end. "deep" is load-bearing — a bare
          data-tauri-drag-region only drags on a direct hit, which the centred
          span would swallow.
        */}
        <div className="titlebar" data-tauri-drag-region="deep">
          <span className="titlebar-name">timey</span>
        </div>

        <UpdateBanner
          state={updates.state}
          onInstall={updates.install}
          onDismiss={updates.dismiss}
        />

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
                onClose={() => setView("month")}
                updates={updates}
                theme={theme}
                onThemeChange={setTheme}
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
    </Tooltip.Provider>
  );
}
