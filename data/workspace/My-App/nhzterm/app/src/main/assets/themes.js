/* nhzterm — themes & fonts (§11)
 *
 * Shipped defaults span "serious dev" to "for-fun hacker aesthetic":
 * Dracula, Nord, Gruvbox Dark, Matrix Green. The rest of the top-25 list is
 * here as real xterm.js theme objects so the picker has substance from day one.
 */
window.NHZ_THEMES = {
  "Dracula": {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f0",
    selectionBackground: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff"
  },
  "Nord": {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
    selectionBackground: "#434c5e",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb", brightWhite: "#eceff4"
  },
  "Gruvbox Dark": {
    background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
    blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
    brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26",
    brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
    brightCyan: "#8ec07c", brightWhite: "#ebdbb2"
  },
  "Matrix Green": {
    background: "#000000", foreground: "#00ff41", cursor: "#00ff41",
    selectionBackground: "#003b00",
    black: "#000000", red: "#008f11", green: "#00ff41", yellow: "#00cc33",
    blue: "#008f11", magenta: "#00ff41", cyan: "#00cc33", white: "#00ff41",
    brightBlack: "#005f00", brightRed: "#00ff41", brightGreen: "#00ff41",
    brightYellow: "#33ff66", brightBlue: "#00cc33", brightMagenta: "#33ff66",
    brightCyan: "#66ff99", brightWhite: "#ccffcc"
  },
  "Solarized Dark": {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1",
    selectionBackground: "#073642",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75",
    brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3"
  },
  "Solarized Light": {
    background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75",
    selectionBackground: "#eee8d5",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
    brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3"
  },
  "Tokyo Night": {
    background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5",
    selectionBackground: "#33467c",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
    brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff", brightWhite: "#c0caf5"
  },
  "Catppuccin Mocha": {
    background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5", brightWhite: "#a6adc8"
  },
  "Monokai": {
    background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
    selectionBackground: "#49483e",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
    brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e",
    brightYellow: "#f4bf75", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4", brightWhite: "#f9f8f5"
  },
  "One Dark": {
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff",
    selectionBackground: "#3e4451",
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
    brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
    brightCyan: "#56b6c2", brightWhite: "#ffffff"
  },
  "Cyberpunk Neon": {
    background: "#000b1e", foreground: "#0abdc6", cursor: "#ea00d9",
    selectionBackground: "#711c91",
    black: "#000b1e", red: "#ff0055", green: "#00ff9f", yellow: "#f3e600",
    blue: "#00b8ff", magenta: "#ea00d9", cyan: "#0abdc6", white: "#d7d7d5",
    brightBlack: "#123e7c", brightRed: "#ff0055", brightGreen: "#00ff9f",
    brightYellow: "#f3e600", brightBlue: "#00b8ff", brightMagenta: "#ea00d9",
    brightCyan: "#0abdc6", brightWhite: "#ffffff"
  },
  "Rosé Pine": {
    background: "#191724", foreground: "#e0def4", cursor: "#e0def4",
    selectionBackground: "#403d52",
    black: "#26233a", red: "#eb6f92", green: "#31748f", yellow: "#f6c177",
    blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#ebbcba", white: "#e0def4",
    brightBlack: "#6e6a86", brightRed: "#eb6f92", brightGreen: "#31748f",
    brightYellow: "#f6c177", brightBlue: "#9ccfd8", brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba", brightWhite: "#e0def4"
  },
  "GitHub Dark": {
    background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff",
    selectionBackground: "#264f78",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
    brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd", brightWhite: "#f0f6fc"
  },
  "Synthwave '84": {
    background: "#262335", foreground: "#ff7edb", cursor: "#f97e72",
    selectionBackground: "#463465",
    black: "#262335", red: "#fe4450", green: "#72f1b8", yellow: "#fede5d",
    blue: "#03edf9", magenta: "#ff7edb", cyan: "#03edf9", white: "#ffffff",
    brightBlack: "#495495", brightRed: "#fe4450", brightGreen: "#72f1b8",
    brightYellow: "#fede5d", brightBlue: "#03edf9", brightMagenta: "#ff7edb",
    brightCyan: "#03edf9", brightWhite: "#ffffff"
  },
  "Kanagawa": {
    background: "#1f1f28", foreground: "#dcd7ba", cursor: "#c8c093",
    selectionBackground: "#2d4f67",
    black: "#16161d", red: "#c34043", green: "#76946a", yellow: "#c0a36e",
    blue: "#7e9cd8", magenta: "#957fb8", cyan: "#6a9589", white: "#c8c093",
    brightBlack: "#727169", brightRed: "#e82424", brightGreen: "#98bb6c",
    brightYellow: "#e6c384", brightBlue: "#7fb4ca", brightMagenta: "#938aa9",
    brightCyan: "#7aa89f", brightWhite: "#dcd7ba"
  },
  "Everforest": {
    background: "#2d353b", foreground: "#d3c6aa", cursor: "#d3c6aa",
    selectionBackground: "#475258",
    black: "#343f44", red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f",
    blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092", white: "#d3c6aa",
    brightBlack: "#859289", brightRed: "#e67e80", brightGreen: "#a7c080",
    brightYellow: "#dbbc7f", brightBlue: "#7fbbb3", brightMagenta: "#d699b6",
    brightCyan: "#83c092", brightWhite: "#d3c6aa"
  }
};

/* Fonts (§11). The stack falls back to the platform monospace when a face is
 * not bundled — Android ships very few of these, so honest fallback matters
 * more than pretending they are all present. */
window.NHZ_FONTS = [
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Iosevka", "Hack",
  "IBM Plex Mono", "Source Code Pro", "Space Mono", "Terminus", "Victor Mono",
  "Monaspace", "Inconsolata", "Ubuntu Mono", "DejaVu Sans Mono", "Consolas",
  "Menlo", "SF Mono", "Roboto Mono", "Anonymous Pro", "PT Mono",
  "Operator Mono", "Input Mono", "Recursive Mono", "Departure Mono", "Comic Mono"
];
