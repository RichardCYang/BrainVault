(() => {
  const storageKey = "brainvault.theme";
  const supportedThemes = new Set(["light", "dark", "system"]);
  let preference = "system";

  try {
    const storedTheme = window.localStorage.getItem(storageKey);
    if (supportedThemes.has(storedTheme)) preference = storedTheme;
  } catch {
    // Storage can be unavailable in hardened browser contexts. Following the
    // operating system is the default until the account preference loads.
  }

  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  const theme = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#15161a" : "#f6f4f1"
  );
})();
