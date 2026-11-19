// Interface icons for block and editor controls. They follow the app's two-tone
// set (24 × 24 stroke outline; closed shapes get the translucent accent fill via
// .icon-duo-shape) so controls render identically on every OS instead of relying
// on whichever font happens to supply a Unicode glyph or emoji.

const svgNamespace = "http://www.w3.org/2000/svg";

const dot = (cx, cy) => ["circle", { cx, cy, r: "1", fill: "currentColor", stroke: "none" }];

const uiIconShapes = Object.freeze({
  grip: [dot("9", "6"), dot("15", "6"), dot("9", "12"), dot("15", "12"), dot("9", "18"), dot("15", "18")],
  "more-vertical": [dot("12", "5"), dot("12", "12"), dot("12", "19")],
  "arrow-up": [["path", { d: "M12 19V5" }], ["path", { d: "m5 12 7-7 7 7" }]],
  "arrow-down": [["path", { d: "M12 5v14" }], ["path", { d: "m19 12-7 7-7-7" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  close: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  plus: [["path", { d: "M12 5v14" }], ["path", { d: "M5 12h14" }]],
  trash: [
    ["path", { d: "M6 7h12l-1 13H7Z", class: "icon-duo-shape" }],
    ["path", { d: "M4 7h16" }],
    ["path", { d: "M9 7V4h6v3" }],
    ["path", { d: "M10 11v5" }],
    ["path", { d: "M14 11v5" }]
  ],
  grid: [
    ["rect", { x: "4", y: "4", width: "7", height: "7", rx: "1.5", class: "icon-duo-shape" }],
    ["rect", { x: "13", y: "4", width: "7", height: "7", rx: "1.5", class: "icon-duo-shape" }],
    ["rect", { x: "4", y: "13", width: "7", height: "7", rx: "1.5", class: "icon-duo-shape" }],
    ["rect", { x: "13", y: "13", width: "7", height: "7", rx: "1.5", class: "icon-duo-shape" }]
  ],
  paperclip: [
    ["path", { d: "m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.4 9.4a2 2 0 0 1-2.8-2.8l8.8-8.8" }]
  ],
  bookmark: [["path", { d: "M6 3h12v18l-6-4-6 4Z", class: "icon-duo-shape" }]]
});

/**
 * Returns a decorative SVG icon. The control that holds it must carry its own
 * accessible name (aria-label), because the icon is hidden from assistive tech.
 */
export function createUiIcon(name, className = "") {
  const shapes = uiIconShapes[name];
  if (!shapes) throw new Error(`Unknown UI icon: ${name}`);
  if (typeof document.createElementNS !== "function") {
    // DOM implementations without SVG support (headless harnesses) get an empty placeholder.
    const placeholder = document.createElement("span");
    placeholder.setAttribute("class", className ? `ui-icon ${className}` : "ui-icon");
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.dataset.icon = name;
    return placeholder;
  }
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", className ? `ui-icon ${className}` : "ui-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = name;
  for (const [tagName, attributes] of shapes) {
    const shape = document.createElementNS(svgNamespace, tagName);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.append(shape);
  }
  return svg;
}

/** Replaces an element's content with the named icon. */
export function setUiIcon(element, name, className = "") {
  element.replaceChildren(createUiIcon(name, className));
  return element;
}
