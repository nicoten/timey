/**
 * Light/dark selection.
 *
 * Three states, not two: "system" follows the OS and is the default, so the app
 * matches the rest of the desktop until someone deliberately overrides it. The
 * choice is written to the document root as `data-theme`, which the stylesheet
 * keys off, and remembered in localStorage.
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];

const STORAGE_KEY = "timey.theme";

function isChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** Reading storage can throw outright in some contexts, so never let it escape. */
export function loadThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    // Absent attribute means prefers-color-scheme decides.
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }

  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // A remembered preference is a convenience, not a requirement.
  }
}
