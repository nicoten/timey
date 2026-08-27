import { useEffect, useState } from "react";

import {
  clientCreate,
  clientDelete,
  clientRename,
  clientSetArchived,
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
} from "../lib/api";
import { centsToRateInput, formatMoney, parseRateToCents } from "../lib/money";
import type { Updates } from "../lib/useUpdates";
import { Button, Empty, ErrorNote, Field, Select, TextInput } from "./ui";

/** A constrained palette, so projects stay legible against the ledger. */
const PROJECT_COLORS = [
  { label: "No color", value: "" },
  { label: "Moss", value: "#4f7440" },
  { label: "Ochre", value: "#8a6a1f" },
  { label: "Clay", value: "#ad3f28" },
  { label: "Slate", value: "#3f5666" },
  { label: "Plum", value: "#6b3f5e" },
  { label: "Sand", value: "#9a8a5f" },
] as const;

interface Props {
  clients: Client[];
  projects: Project[];
  onChanged: () => void;
  onBack: () => void;
  updates: Updates;
}

export function SettingsView({ clients, projects, onChanged, onBack, updates }: Props) {
  return (
    <div className="settings">
      <header className="settings-head">
        <Button variant="quiet" onClick={onBack}>
          ‹ Back to calendar
        </Button>
        <h1>Settings</h1>
      </header>

      <ClientSection clients={clients} onChanged={onChanged} />
      <ProjectSection clients={clients} projects={projects} onChanged={onChanged} />
      <UpdateSection updates={updates} />
    </div>
  );
}

// --- clients and their contacts --------------------------------------------

function ClientSection({ clients, onChanged }: { clients: Client[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await clientCreate(name);
      setName("");
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2>Clients</h2>
        <span className="eyebrow">{clients.length} total</span>
      </div>
      <p className="section-note">
        Everything hangs off a client: projects belong to one, and entries belong to a project.
        Archiving keeps the history and frees the name for reuse.
      </p>

      <form
        className="form-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <TextInput
          value={name}
          placeholder="Client name"
          onChange={(event) => setName(event.currentTarget.value)}
          style={{ flex: 1, padding: "7px 8px" }}
        />
        <Button type="submit" variant="primary" disabled={name.trim() === "" || busy}>
          Add client
        </Button>
      </form>
      <ErrorNote error={error} />

      {clients.length === 0 ? (
        <Empty title="No clients yet">
          <p>Add the first one above.</p>
        </Empty>
      ) : (
        <div className="ledger">
          {clients.map((client) => (
            <ClientRow key={client.id} client={client} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClientRow({ client, onChanged }: { client: Client; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(client.name);
  const [error, setError] = useState<unknown>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <>
      <div className="ledger-row">
        <div className="ledger-main">
          {renaming ? (
            <TextInput
              value={name}
              autoFocus
              onChange={(event) => setName(event.currentTarget.value)}
              style={{ padding: "5px 7px" }}
            />
          ) : (
            <span className="ledger-name">{client.name}</span>
          )}
          {client.archivedAt !== null && <span className="tag">Archived</span>}
        </div>
        <div className="ledger-actions">
          {renaming ? (
            <>
              <Button
                variant="primary"
                onClick={() =>
                  void run(async () => {
                    await clientRename(client.id, name);
                    setRenaming(false);
                  })
                }
              >
                Save
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setName(client.name);
                  setRenaming(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="quiet" onClick={() => setExpanded(!expanded)}>
                {expanded ? "Hide contacts" : "Contacts"}
              </Button>
              <Button variant="quiet" onClick={() => setRenaming(true)}>
                Rename
              </Button>
              <Button
                variant="quiet"
                onClick={() =>
                  void run(() => clientSetArchived(client.id, client.archivedAt === null))
                }
              >
                {client.archivedAt === null ? "Archive" : "Restore"}
              </Button>
              <Button variant="danger" onClick={() => void run(() => clientDelete(client.id))}>
                Delete
              </Button>
            </>
          )}
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

function ContactList({ clientId }: { clientId: number }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", email: "" });

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

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setDraft({ name: "", email: "" });
      setEditingId(null);
      await reload();
    } catch (caught) {
      setError(caught);
    }
  }

  const canSubmit = draft.name.trim() !== "" && draft.email.trim() !== "";

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
              <Button
                variant="quiet"
                onClick={() => {
                  setEditingId(contact.id);
                  setDraft({ name: contact.name, email: contact.email });
                }}
              >
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
        <form
          className="form"
          style={{ width: "100%" }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              editingId === null
                ? contactCreate(clientId, draft.name, draft.email)
                : contactUpdate(editingId, draft.name, draft.email),
            );
          }}
        >
          <span className="eyebrow">{editingId === null ? "Add contact" : "Edit contact"}</span>
          <div className="field-pair">
            <Field label="Name">
              <TextInput
                value={draft.name}
                placeholder="Ann Reyes"
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
            </Field>
            <Field label="Email">
              <TextInput
                value={draft.email}
                placeholder="ann@example.com"
                onChange={(event) => setDraft({ ...draft, email: event.currentTarget.value })}
              />
            </Field>
          </div>
          <ErrorNote error={error} />
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {editingId === null ? "Add contact" : "Save contact"}
            </Button>
            {editingId !== null && (
              <Button
                variant="quiet"
                onClick={() => {
                  setEditingId(null);
                  setDraft({ name: "", email: "" });
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}

// --- projects --------------------------------------------------------------

interface ProjectDraft {
  clientId: string;
  code: string;
  name: string;
  color: string;
  rate: string;
}

function emptyProjectDraft(clients: Client[]): ProjectDraft {
  return {
    clientId: clients[0] ? String(clients[0].id) : "",
    code: "",
    name: "",
    color: "",
    rate: "",
  };
}

function ProjectSection({
  clients,
  projects,
  onChanged,
}: {
  clients: Client[];
  projects: Project[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(() => emptyProjectDraft(clients));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const clientsById = new Map(clients.map((client) => [client.id, client]));

  // Once clients load, the form needs a valid default selection.
  useEffect(() => {
    setDraft((current) =>
      current.clientId === "" && clients[0] ? { ...current, clientId: String(clients[0].id) } : current,
    );
  }, [clients]);

  async function submit() {
    setError(null);
    try {
      const rateCents = parseRateToCents(draft.rate);
      const shared = {
        code: draft.code,
        name: draft.name,
        color: draft.color === "" ? null : draft.color,
        hourlyRateCents: rateCents,
      };
      if (editingId === null) {
        await projectCreate({ clientId: Number(draft.clientId), ...shared });
      } else {
        await projectUpdate({ id: editingId, ...shared });
      }
      setDraft(emptyProjectDraft(clients));
      setEditingId(null);
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught);
    }
  }

  const canSubmit =
    draft.clientId !== "" && draft.code.trim() !== "" && draft.name.trim() !== "";

  return (
    <section className="section">
      <div className="section-head">
        <h2>Projects</h2>
        <span className="eyebrow">{projects.length} total</span>
      </div>
      <p className="section-note">
        The code is the short handle you pick when logging time, so it has to be unique. The rate
        is what turns tracked hours into the month's earnings — leave it blank for work you do not
        bill.
      </p>

      {clients.length === 0 ? (
        <Empty title="Add a client first">
          <p>A project belongs to a client.</p>
        </Empty>
      ) : (
        <>
          <div className="inset-form">
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <span className="eyebrow">{editingId === null ? "Add project" : "Edit project"}</span>

              {editingId === null && (
                <Field label="Client">
                  <Select
                    value={draft.clientId}
                    onChange={(event) => setDraft({ ...draft, clientId: event.currentTarget.value })}
                  >
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              <div className="field-pair">
                <Field label="Code">
                  <TextInput
                    className="num"
                    value={draft.code}
                    placeholder="ACME-001"
                    onChange={(event) => setDraft({ ...draft, code: event.currentTarget.value })}
                  />
                </Field>
                <Field label="Name">
                  <TextInput
                    value={draft.name}
                    placeholder="Website redesign"
                    onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                  />
                </Field>
              </div>

              <div className="field-pair">
                <Field label="Hourly rate (USD)">
                  <TextInput
                    className="num"
                    value={draft.rate}
                    placeholder="150.00"
                    onChange={(event) => setDraft({ ...draft, rate: event.currentTarget.value })}
                  />
                </Field>
                <Field label="Color">
                  <Select
                    value={draft.color}
                    onChange={(event) => setDraft({ ...draft, color: event.currentTarget.value })}
                  >
                    {PROJECT_COLORS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <ErrorNote error={error} />

              <div className="form-actions">
                <Button type="submit" variant="primary" disabled={!canSubmit}>
                  {editingId === null ? "Add project" : "Save project"}
                </Button>
                {editingId !== null && (
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setEditingId(null);
                      setDraft(emptyProjectDraft(clients));
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </div>

          {projects.length === 0 ? (
            <Empty title="No projects yet">
              <p>Add one above, then you can log time against it.</p>
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
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setEditingId(project.id);
                        setError(null);
                        setDraft({
                          clientId: String(project.clientId),
                          code: project.code,
                          name: project.name,
                          color: project.color ?? "",
                          rate: centsToRateInput(project.hourlyRateCents),
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() =>
                        void run(() =>
                          projectSetArchived(project.id, project.archivedAt === null),
                        )
                      }
                    >
                      {project.archivedAt === null ? "Archive" : "Restore"}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => void run(() => projectDelete(project.id))}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
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
    state.status === "checking" ||
    state.status === "downloading" ||
    state.status === "installing";

  return (
    <section className="section">
      <div className="section-head">
        <h2>Updates</h2>
        <span className="eyebrow num">{version === null ? "" : `v${version}`}</span>
      </div>
      <p className="section-note">
        timey checks once per launch and never installs anything without being asked.
      </p>

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
