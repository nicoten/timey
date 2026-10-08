import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { ToggleGroup, Tooltip } from "radix-ui";

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
import { isSameMonth, monthEndExclusive, monthOf, monthStart, type MonthCursor } from "./lib/dates";
import { loadMonthMode, MONTH_MODES, saveMonthMode, type MonthMode } from "./lib/monthMode";
import { applyThemeChoice, loadThemeChoice, type ThemeChoice } from "./lib/theme";
import { useToday } from "./lib/useToday";
import { useUpdates } from "./lib/useUpdates";
import { DayPanel, type EntryFocus } from "./components/DayPanel";
import { ImportDialog } from "./components/ImportDialog";
import { InvoiceDialog } from "./components/InvoiceDialog";
import { MonthView } from "./components/MonthView";
import { SettingsView } from "./components/SettingsView";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button, CloseDot, ImportIcon, InvoiceIcon, SettingsIcon } from "./components/ui";
import "./styles.css";

type View = "month" | "settings";

export default function App() {
  const [view, setView] = useState<View>("month");
  const today = useToday();
  const [cursor, setCursor] = useState<MonthCursor>(() => monthOf(today));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [entryFocus, setEntryFocus] = useState<EntryFocus | null>(null);
  const [monthMode, setMonthMode] = useState<MonthMode>(loadMonthMode);

  const [entries, setEntries] = useState<EntryDetail[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [invoicing, setInvoicing] = useState(false);
  /** The spreadsheet being imported, while the import dialog is open. */
  const [importPath, setImportPath] = useState<string | null>(null);
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

  // When the calendar was left on the current month and a new month has since
  // begun, follow it: reopening the popover in October should not show
  // September just because that was "this month" at launch.
  const previousToday = useRef(today);
  useEffect(() => {
    const before = monthOf(previousToday.current);
    previousToday.current = today;
    const now = monthOf(today);
    if (!isSameMonth(before, now) && isSameMonth(cursor, before)) {
      setCursor(now);
      setSelectedDay(null);
    }
  }, [today, cursor]);

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

  async function pickImport() {
    try {
      const picked = await open({
        multiple: false,
        title: "Import payments",
        filters: [{ name: "Spreadsheet", extensions: ["xlsx"] }],
      });
      // The picker returns null when dismissed, which is not an error.
      if (typeof picked === "string") setImportPath(picked);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
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
          {/* Close sits top-left where a macOS window puts it, and looks the
              part: the glyph only appears on hover, as it does in a title bar. */}
          <CloseDot onClick={() => void getCurrentWindow().hide()} />
          <span className="titlebar-name">Timey</span>
          {view === "month" && (
            <ToggleGroup.Root
              className="segmented is-compact"
              type="single"
              value={monthMode}
              aria-label="Show the month as"
              onValueChange={(next) => {
                // Radix reports "" when the active item is pressed again; ignore
                // it so there is always exactly one selection.
                if (next === "") return;
                setMonthMode(next as MonthMode);
                saveMonthMode(next as MonthMode);
              }}
            >
              {MONTH_MODES.map((mode) => (
                <ToggleGroup.Item key={mode.value} className="segmented-item" value={mode.value}>
                  {mode.label}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          )}
          <span className="titlebar-actions">
            <Button
              variant="quiet"
              onClick={() => void pickImport()}
              aria-label="Import payments from a spreadsheet"
              title="Import payments from a spreadsheet"
            >
              <ImportIcon />
            </Button>
            <Button
              variant="quiet"
              onClick={() => setInvoicing(true)}
              aria-label="New invoice"
              title="New invoice"
            >
              <InvoiceIcon />
              Invoices
            </Button>
            <Button
              variant="quiet"
              onClick={() => setView(view === "settings" ? "month" : "settings")}
              aria-label={view === "settings" ? "Back to calendar" : "Settings"}
              title={view === "settings" ? "Back to calendar" : "Settings"}
            >
              <SettingsIcon />
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
                mode={monthMode}
                today={today}
                cursor={cursor}
                onCursorChange={changeMonth}
                entries={entries}
                loading={loadingMonth}
                selectedDay={selectedDay}
                onSelectDay={(day) => {
                  setEntryFocus(null);
                  setSelectedDay(day);
                }}
                onSelectEntry={(entry) => {
                  setSelectedDay(entry.startedAt.slice(0, 10));
                  setEntryFocus({ entryId: entry.id });
                }}
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
              focus={entryFocus}
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

        {importPath !== null && (
          <ImportDialog
            path={importPath}
            clients={clients}
            projects={liveProjects}
            onClose={() => setImportPath(null)}
            onImported={() => {
              setImportPath(null);
              void loadMonth(cursor);
            }}
          />
        )}

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
