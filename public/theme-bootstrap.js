(() => {
  const storageKey = "brainvault.theme";
  const supportedThemes = new Set(["light", "dark"]);
  let theme = "light";

  try {
    const storedTheme = window.localStorage.getItem(storageKey);
    if (supportedThemes.has(storedTheme)) theme = storedTheme;
  } catch {
    // Storage can be unavailable in hardened browser contexts. The light theme
    // remains a safe default until the authenticated account preference loads.
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#17191d" : "#e7eef3"
  );
})();
