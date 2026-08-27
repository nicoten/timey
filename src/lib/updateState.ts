/** The shape the UI renders from. Kept separate so components import no plugin code. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string; notes?: string }
  | { status: "downloading"; version: string; percent: number | null }
  | { status: "installing"; version: string }
  | { status: "upToDate" }
  | { status: "unsupported" }
  | { status: "error"; message: string };
