import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "radix-ui";

import {
  clientsList,
  entriesList,
  errorMessage,
  projectsList,
  settingsAll,
  type Client,
  type EntryDetail,
  type Project,
  type Settings,
} from "./lib/api";
import { currentMonth, monthEndExclusive, monthStart, type MonthCursor } from "./lib/dates";
import { applyThemeChoice, loadThemeChoice, type ThemeChoice } from "./lib/theme";
import { useUpdates } from "./lib/useUpdates";
import { DayPanel } from "./components/DayPanel";
import { InvoiceDialog } from "./components/InvoiceDialog";
import { MonthView } from "./components/MonthView";
import { SettingsView } from "./components/SettingsView";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button, InvoiceIcon, SettingsIcon } from "./components/ui";
import "./styles.css";

type View = "month" | "settings";

export default function App() {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState<MonthCursor>(currentMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const [entries, setEntries] = useState<EntryDetail[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [invoicing, setInvoicing] = useState(false);
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
      const [loadedClients, loadedProjects, loadedSettings] = await Promise.all([
        clientsList(true),
        projectsList(null, true),
        settingsAll(),
      ]);
      setClients(loadedClients);
      setProjects(loadedProjects);
      setSettings(loadedSettings);
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

  // Escape steps back out one layer at a time, dismissing the popover last.
  // Radix stops the event inside its own dialogs, so those close first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      if (selectedDay !== null) {
        setSelectedDay(null);
      } else if (view === "settings") {
        setView("month");
      } else {
        // A popover dismisses rather than closing: the tray icon reopens it.
        void getCurrentWindow().hide();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedDay, view]);

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
          The popover's own header. There is no drag region: a popover is
          anchored to the menu bar icon rather than moved. Settings lives here
          because an accessory app shows no menu bar, which would otherwise
          leave the tray's right-click menu as the only way in.
        */}
        <div className="titlebar">
          <span />
          <span className="titlebar-name">timey</span>
          <span className="titlebar-actions">
            <Button
              variant="quiet"
              onClick={() => setInvoicing(true)}
              aria-label="New invoice"
              title="New invoice"
            >
              <InvoiceIcon />
            </Button>
            <Button
              variant="quiet"
              onClick={() => setView(view === "settings" ? "month" : "settings")}
              aria-label={view === "settings" ? "Back to calendar" : "Settings"}
              title={view === "settings" ? "Back to calendar" : "Settings"}
            >
              <SettingsIcon />
            </Button>
            {/* The popover no longer dismisses itself, so it needs a way out
                that does not depend on knowing about Escape or the tray icon. */}
            <Button
              variant="quiet"
              onClick={() => void getCurrentWindow().hide()}
              aria-label="Close timey"
              title="Close"
            >
              ✕
            </Button>
          </span>
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
                settings={settings}
                onChanged={() => {
                  void loadCatalog();
                  void loadMonth(cursor);
                }}
                onSettingsChanged={() => void loadCatalog()}
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

        {invoicing && (
          <InvoiceDialog
            clients={clients}
            settings={settings}
            onClose={() => setInvoicing(false)}
            onOpenSettings={() => {
              setInvoicing(false);
              setView("settings");
            }}
          />
        )}
      </div>
    </Tooltip.Provider>
  );
}
