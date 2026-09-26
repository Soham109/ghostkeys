export type AppLayer = {
  id: string;
  name: string;
  glyph: "grid" | "pen" | "wave" | "brackets";
  tint: string;
  bindings: Record<string, string>;
};

/** Per-app layers. Generic app types with neutral glyphs, no real logos. */
export const APPS: AppLayer[] = [
  {
    id: "sheet",
    name: "Spreadsheet",
    glyph: "grid",
    tint: "#3FD08A",
    bindings: { "left-palm": "Paste values", "right-palm": "Fill down", "left-grille": "Previous sheet", "right-grille": "Next sheet", "top-strip": "Sum selection" },
  },
  {
    id: "design",
    name: "Design tool",
    glyph: "pen",
    tint: "#B685FF",
    bindings: { "left-palm": "Pen tool", "right-palm": "Zoom to fit", "left-grille": "Undo", "right-grille": "Redo", "top-strip": "Toggle rulers" },
  },
  {
    id: "music",
    name: "Music player",
    glyph: "wave",
    tint: "#FF7A59",
    bindings: { "left-palm": "Play or pause", "right-palm": "Next track", "left-grille": "Volume down", "right-grille": "Volume up", "top-strip": "Like this song" },
  },
  {
    id: "code",
    name: "Code editor",
    glyph: "brackets",
    tint: "#4FB8FF",
    bindings: { "left-palm": "Run tests", "right-palm": "Go to definition", "left-grille": "Previous error", "right-grille": "Next error", "top-strip": "Command palette" },
  },
];
