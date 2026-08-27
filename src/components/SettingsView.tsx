import { useEffect, useState } from "react";
import { ToggleGroup } from "radix-ui";

import { open } from "@tauri-apps/plugin-dialog";

import {
  SETTING_INVOICE_FOLDER,
  SETTING_SENDER_NAME,
  clientCreate,
  clientDelete,
  clientSetArchived,
  clientUpdate,
  settingsSet,
  contactCreate,
  contactDelete,
  contactUpdate,
  contactsList,
  projectCreate,
  projectDelete,
  projectSetArchived,
  projectUpdate,
  type Client,
  type Contact,
  type Project,
  type Settings,
} from "../lib/api";
import { centsToRateInput, formatMoney, parseRateToCents } from "../lib/money";
import { THEME_CHOICES, type ThemeChoice } from "../lib/theme";
import type { Updates } from "../lib/useUpdates";
import {
  Button,
  DropdownField,
  Empty,
  ErrorNote,
  Field,
  Modal,
  TextArea,
  TextInput,
  type DropdownOption,
} from "./ui";

/**
 * A constrained palette, so projects stay legible against the ledger.
 *
 * "none" rather than an empty string: Radix Select refuses empty values, so the
 * absence of a colour needs a name of its own, mapped back to null on save.
 */
const NO_COLOR = "none";

const COLOR_OPTIONS: DropdownOption[] = [
  { label: "No color", value: NO_COLOR },
  { label: "Moss", value: "#4f7440" },
  { label: "Ochre", value: "#8a6a1f" },
  { label: "Clay", value: "#ad3f28" },
  { label: "Slate", value: "#3f5666" },
  { label: "Plum", value: "#6b3f5e" },
  { label: "Sand", value: "#9a8a5f" },
];

const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

interface Props {
  clients: Client[];
  projects: Project[];
  settings: Settings;
  onChanged: () => void;
  onSettingsChanged: () => void;
  onClose: () => void;
  updates: Updates;
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
}

export function SettingsView({
  clients,
  projects,
  settings,
  onChanged,
  onSettingsChanged,
  onClose,
  updates,
  theme,
  onThemeChange,
}: Props) {
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Settings</h1>
        <Button variant="quiet" onClick={onClose} aria-label="Close settings" title="Close settings">
          ✕
        </Button>
      </header>

      <ClientSection clients={clients} onChanged={onChanged} />
      <ProjectSection clients={clients} projects={projects} onChanged={onChanged} />
      <InvoicingSection settings={settings} onChanged={onSettingsChanged} />
      <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
      <UpdateSection updates={updates} />
    </div>
  );
}

// --- invoicing -------------------------------------------------------------

function InvoicingSection({
  settings,
  onChanged,
}: {
  settings: Settings;
  onChanged: () => void;
}) {
  const folder = settings[SETTING_INVOICE_FOLDER] ?? "";
  const [senderName, setSenderName] = useState(settings[SETTING_SENDER_NAME] ?? "");
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  async function save(key: string, value: string) {
    setError(null);
    try {
      await settingsSet(key, value);
      setSaved(true);
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  async function chooseFolder() {
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: false, title: "Invoice folder" });
      // The picker returns null when dismissed, which is not an error.
      if (typeof picked === "string") await save(SETTING_INVOICE_FOLDER, picked);
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2>Invoicing</h2>
      </div>

      <div className="form">
        <Field label="Your name (appears after “From”)">
          <TextInput
            value={senderName}
            placeholder="Your full name"
            onChange={(event) => {
              setSenderName(event.currentTarget.value);
              setSaved(false);
            }}
            onBlur={() => void save(SETTING_SENDER_NAME, senderName)}
          />
        </Field>

        <div className="field">
          <span>Save invoices to</span>
          <div className="form-actions">
            <span className="ledger-sub" style={{ wordBreak: "break-all" }}>
              {folder === "" ? "No folder chosen" : folder}
            </span>
            <Button onClick={() => void chooseFolder()}>Choose…</Button>
          </div>
        </div>

        {saved && <span className="ledger-sub">Saved.</span>}
        <ErrorNote error={error} />
      </div>
    </section>
  );
}

// --- appearance ------------------------------------------------------------

function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>Appearance</h2>
      </div>

      {/* Three options rather than a two-way switch: "System" follows the OS,
          which is the right default until it is deliberately overridden. */}
      <ToggleGroup.Root
        className="segmented"
        type="single"
        value={theme}
        aria-label="Appearance"
        onValueChange={(next) => {
          // Radix reports "" when the active item is pressed again; ignore it so
          // there is always exactly one selection.
          if (next !== "") onThemeChange(next as ThemeChoice);
        }}
      >
        {THEME_CHOICES.map((choice) => (
          <ToggleGroup.Item key={choice} className="segmented-item" value={choice}>
            {THEME_LABELS[choice]}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </section>
  );
}

function SectionHead({
  title,
  count,
  addLabel,
  onAdd,
}: {
  title: string;
  count: number;
  addLabel: string;
  onAdd?: () => void;
}) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <div className="section-head-actions">
        <span className="eyebrow num">{count}</span>
        {onAdd && (
          <Button variant="add" onClick={onAdd} aria-label={addLabel} title={addLabel}>
            +
          </Button>
        )}
      </div>
    </div>
  );
}

/** Runs an action, surfacing failure locally instead of throwing it away. */
function useRowAction(onDone: () => void) {
  const [error, setError] = useState<unknown>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onDone();
    } catch (caught) {
      setError(caught);
    }
  }

  return { error, run, clearError: () => setError(null) };
}

// --- clients and their contacts --------------------------------------------

type ClientDialogState = { mode: "create" } | { mode: "edit"; client: Client } | null;

function ClientSection({ clients, onChanged }: { clients: Client[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<ClientDialogState>(null);

  return (
    <section className="section">
      <SectionHead
        title="Clients"
        count={clients.length}
        addLabel="Add client"
        onAdd={() => setDialog({ mode: "create" })}
      />

      {clients.length === 0 ? (
        <Empty title="No clients yet">
          <p>Use + to add the first one.</p>
        </Empty>
      ) : (
        <div className="ledger">
          {clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              onChanged={onChanged}
              onEdit={() => setDialog({ mode: "edit", client })}
            />
          ))}
        </div>
      )}

      {dialog !== null && (
        <ClientDialog
          client={dialog.mode === "edit" ? dialog.client : null}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ClientDialog({
  client,
  onClose,
  onSaved,
}: {
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(client?.name ?? "");
  const [ein, setEin] = useState(client?.ein ?? "");
  const [address, setAddress] = useState(client?.address ?? "");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (client === null) {
        await clientCreate({ name, ein, address });
      } else {
        await clientUpdate({ id: client.id, name, ein, address });
      }
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={client === null ? "New client" : "Edit client"}
      submitLabel={client === null ? "Add client" : "Save"}
      onSubmit={() => void submit()}
      onClose={onClose}
      canSubmit={name.trim() !== ""}
      busy={busy}
    >
      <Field label="Name">
        <TextInput
          value={name}
          placeholder="Acme Industries"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <Field label="EIN">
        <TextInput
          className="num"
          value={ein}
          placeholder="12-3456789"
          onChange={(event) => setEin(event.currentTarget.value)}
        />
      </Field>
      {/* Freeform: an invoice reproduces these lines exactly as typed. */}
      <Field label="Address">
        <TextArea
          value={address}
          placeholder={"Street address\nCity, State ZIP"}
          onChange={(event) => setAddress(event.currentTarget.value)}
        />
      </Field>
      <ErrorNote error={error} />
    </Modal>
  );
}

function ClientRow({
  client,
  onChanged,
  onEdit,
}: {
  client: Client;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { error, run } = useRowAction(onChanged);

  return (
    <>
      <div className="ledger-row">
        <div className="ledger-main">
          <span className="ledger-name">{client.name}</span>
          {client.archivedAt !== null && <span className="tag">Archived</span>}
        </div>
        <div className="ledger-actions">
          <Button variant="quiet" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide contacts" : "Contacts"}
          </Button>
          <Button variant="quiet" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="quiet"
            onClick={() => void run(() => clientSetArchived(client.id, client.archivedAt === null))}
          >
            {client.archivedAt === null ? "Archive" : "Restore"}
          </Button>
          <Button variant="danger" onClick={() => void run(() => clientDelete(client.id))}>
            Delete
          </Button>
        </div>
      </div>

      {error !== null && (
        <div className="ledger-row">
          <ErrorNote error={error} />
        </div>
      )}

      {expanded && <ContactList clientId={client.id} />}
    </>
  );
}

type ContactDialogState = { mode: "create" } | { mode: "edit"; contact: Contact } | null;

function ContactList({ clientId }: { clientId: number }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<ContactDialogState>(null);

  async function reload() {
    setLoading(true);
    try {
      setContacts(await contactsList(clientId));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const { error: rowError, run } = useRowAction(() => void reload());

  return (
    <>
      {loading ? (
        <div className="ledger-row is-nested">
          <span className="loading">Loading contacts…</span>
        </div>
      ) : (
        contacts.map((contact) => (
          <div key={contact.id} className="ledger-row is-nested">
            <div className="ledger-main">
              <span className="ledger-name">{contact.name}</span>
              <span className="ledger-sub">{contact.email}</span>
            </div>
            <div className="ledger-actions">
              <Button variant="quiet" onClick={() => setDialog({ mode: "edit", contact })}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => void run(() => contactDelete(contact.id))}>
                Delete
              </Button>
            </div>
          </div>
        ))
      )}

      <div className="ledger-row is-nested">
        <Button variant="quiet" onClick={() => setDialog({ mode: "create" })}>
          + Add contact
        </Button>
        <ErrorNote error={error ?? rowError} />
      </div>

      {dialog !== null && (
        <ContactDialog
          clientId={clientId}
          contact={dialog.mode === "edit" ? dialog.contact : null}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function ContactDialog({
  clientId,
  contact,
  onClose,
  onSaved,
}: {
  clientId: number;
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (contact === null) {
        await contactCreate(clientId, name, email);
      } else {
        await contactUpdate(contact.id, name, email);
      }
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={contact === null ? "New contact" : "Edit contact"}
      submitLabel={contact === null ? "Add contact" : "Save"}
      onSubmit={() => void submit()}
      onClose={onClose}
      canSubmit={name.trim() !== "" && email.trim() !== ""}
      busy={busy}
    >
      <Field label="Name">
        <TextInput
          value={name}
          placeholder="Ann Reyes"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <Field label="Email">
        <TextInput
          value={email}
          placeholder="ann@example.com"
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </Field>
      <ErrorNote error={error} />
    </Modal>
  );
}

// --- projects --------------------------------------------------------------

type ProjectDialogState = { mode: "create" } | { mode: "edit"; project: Project } | null;

function ProjectSection({
  clients,
  projects,
  onChanged,
}: {
  clients: Client[];
  projects: Project[];
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<ProjectDialogState>(null);
  const { error, run } = useRowAction(onChanged);
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  return (
    <section className="section">
      <SectionHead
        title="Projects"
        count={projects.length}
        addLabel="Add project"
        onAdd={clients.length === 0 ? undefined : () => setDialog({ mode: "create" })}
      />

      {clients.length === 0 ? (
        <Empty title="Add a client first">
          <p>A project belongs to a client.</p>
        </Empty>
      ) : projects.length === 0 ? (
        <Empty title="No projects yet">
          <p>Use + to add one, then you can log time against it.</p>
        </Empty>
      ) : (
        <div className="ledger">
          {projects.map((project) => (
            <div key={project.id} className="ledger-row">
              <div className="ledger-main">
                <span
                  className="swatch"
                  style={project.color ? { background: project.color } : undefined}
                  aria-hidden="true"
                />
                <span className="ledger-code">{project.code}</span>
                <span className="ledger-name">{project.name}</span>
                <span className="ledger-sub">
                  {clientsById.get(project.clientId)?.name ?? "—"}
                  {project.hourlyRateCents !== null &&
                    ` · ${formatMoney(project.hourlyRateCents)}/h`}
                </span>
                {project.archivedAt !== null && <span className="tag">Archived</span>}
              </div>
              <div className="ledger-actions">
                <Button variant="quiet" onClick={() => setDialog({ mode: "edit", project })}>
                  Edit
                </Button>
                <Button
                  variant="quiet"
                  onClick={() =>
                    void run(() => projectSetArchived(project.id, project.archivedAt === null))
                  }
                >
                  {project.archivedAt === null ? "Archive" : "Restore"}
                </Button>
                <Button variant="danger" onClick={() => void run(() => projectDelete(project.id))}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ErrorNote error={error} />

      {dialog !== null && (
        <ProjectDialog
          clients={clients}
          project={dialog.mode === "edit" ? dialog.project : null}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ProjectDialog({
  clients,
  project,
  onClose,
  onSaved,
}: {
  clients: Client[];
  project: Project | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(
    String(project?.clientId ?? clients[0]?.id ?? ""),
  );
  const [code, setCode] = useState(project?.code ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState(project?.color ?? NO_COLOR);
  const [rate, setRate] = useState(centsToRateInput(project?.hourlyRateCents ?? null));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const shared = {
        code,
        name,
        color: color === NO_COLOR ? null : color,
        // Throws a readable message on a malformed rate before anything is sent.
        hourlyRateCents: parseRateToCents(rate),
      };
      if (project === null) {
        await projectCreate({ clientId: Number(clientId), ...shared });
      } else {
        await projectUpdate({ id: project.id, ...shared });
      }
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={project === null ? "New project" : "Edit project"}
      submitLabel={project === null ? "Add project" : "Save"}
      onSubmit={() => void submit()}
      onClose={onClose}
      canSubmit={clientId !== "" && code.trim() !== "" && name.trim() !== ""}
      busy={busy}
    >
      {/* A project cannot change hands: entries already point at it. */}
      {project === null && (
        <DropdownField
          label="Client"
          value={clientId}
          onChange={setClientId}
          options={clients.map((client) => ({
            value: String(client.id),
            label: client.name,
          }))}
        />
      )}

      <div className="field-pair">
        <Field label="Code">
          <TextInput
            className="num"
            value={code}
            placeholder="ACME-001"
            onChange={(event) => setCode(event.currentTarget.value)}
          />
        </Field>
        <Field label="Name">
          <TextInput
            value={name}
            placeholder="Website redesign"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </Field>
      </div>

      <div className="field-pair">
        <Field label="Hourly rate (USD)">
          <TextInput
            className="num"
            value={rate}
            placeholder="150.00"
            onChange={(event) => setRate(event.currentTarget.value)}
          />
        </Field>
        <DropdownField label="Color" value={color} onChange={setColor} options={COLOR_OPTIONS} />
      </div>

      <ErrorNote error={error} />
    </Modal>
  );
}

// --- updates ---------------------------------------------------------------

function UpdateSection({ updates }: { updates: Updates }) {
  const { state, version } = updates;

  const message = (() => {
    switch (state.status) {
      case "checking":
        return "Checking…";
      case "available":
        return `Version ${state.version} is ready to install.`;
      case "downloading":
        return "Downloading the update…";
      case "installing":
        return "Installing — the app will restart on its own.";
      case "upToDate":
        return "This is the latest version.";
      case "unsupported":
        return "Updates only work in the installed app, not in a browser.";
      case "error":
        return state.message;
      default:
        return null;
    }
  })();

  const busy =
    state.status === "checking" || state.status === "downloading" || state.status === "installing";

  return (
    <section className="section">
      <div className="section-head">
        <h2>Updates</h2>
        <span className="eyebrow num">{version === null ? "" : `v${version}`}</span>
      </div>

      <div className="form-actions">
        <Button onClick={updates.check} disabled={busy}>
          Check for updates
        </Button>
        {state.status === "available" && (
          <Button variant="primary" onClick={updates.install}>
            Update and restart
          </Button>
        )}
        {message !== null && (
          <span className={state.status === "error" ? "error" : "ledger-sub"}>{message}</span>
        )}
      </div>
    </section>
  );
}
