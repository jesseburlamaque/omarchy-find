# Omarchy Find

A fast, elegant, keyboard-driven universal file search and quick launcher for the [Omarchy](https://github.com/omarchy/omarchy) shell on Linux.

---

## About

**Omarchy Find** brings a modern, Spotlight/Raycast-inspired search overlay experience natively integrated into the Omarchy shell. Designed for speed, ergonomics, and seamless workflow, it enables you to summon a search overlay at any moment to find and access anything across your system with zero friction.

Whether you are looking for deeply nested project files, academic papers and PDFs, media collections, or config directories (such as `~/.config/hypr`, `~/.config/omarchy`, `nvim`, etc.), Omarchy Find indexes and filters your filesystem in real time using `fd`.

Beyond simple file launching, it acts as a central productivity hub:
- **Instant Access:** Open any file or folder directly with its default application (`xdg-open`).
- **File Manager Integration:** Reveal and jump directly into the enclosing directory (`Alt+Enter`).
- **Terminal Integration:** Spawn your preferred terminal directly inside the target directory (`Ctrl+T`).
- **Clipboard Utility:** Instantly copy clean absolute paths to the clipboard (`Ctrl+C`).
- **Web Search:** Type `go <terms>` to seamlessly perform an instant Google search in your default browser.

---

## Features

- **⚡ Blazing Fast Search:** Powered by `fd` with smart multi-term matching and relevance ranking (exact and prefix matches prioritized over fuzzy subsequences).
- **📂 Full-Path Awareness:** Matches both filenames and parent folder structures (e.g. typing `config` or `hypr` accurately locates `~/.config/hypr`).
- **🏷️ Type Filters:**
  - **All:** Search everything across your home directory with user files prioritized.
  - **Folders:** Non-hidden user directories in `$HOME`.
  - **System Folders:** Essential editable configuration and dotfile directories (`~/.config`, `hypr`, `omarchy`, `nvim`, `kitty`, etc.) with noise and caches excluded.
  - **Documents:** PDFs, Markdown, Word, eBooks, spreadsheets, and text files.
  - **Images, Videos & Audio:** Quick discovery for multimedia assets.
  - **Code:** Source files and scripts across all major programming languages.
  - **Recent:** Recently modified files and folders (last 30 days) shown most-recent first.
- **🔄 Instant Sorting Modes:** Switch on the fly between **Relevance**, **Most Recent**, **Oldest**, **Name (A → Z)**, and **Name (Z → A)** via single click or `Ctrl+S`.
- **🌐 Quick Web Search:** Type `go <query>` to hide local file lists and open Google search directly in your browser.
- **⌨️ Ergonomic Keyboard Navigation:** Full support for arrow keys, readline navigation (`Ctrl+N`/`Ctrl+P`), vim-style shortcuts (`Ctrl+J`/`Ctrl+K`), `Home`/`End`, and `PageUp`/`PageDown`.
- **🔍 Status Bar Widget & CLI:** Includes a bar magnifier icon widget, a launcher desktop entry, and the `omarchy-find` CLI command.
- **🎨 Native Shell Aesthetics:** Automatically follows active Omarchy themes, colors, and typography.
- **🧹 Noise Filtering:** Automatically ignores noisy build directories (`.git`, `node_modules`, `.cache`, `.venv`, electron storages, trash, etc.).

---

## Install

```sh
omarchy plugin add https://github.com/jesseburlamaque/omarchy-find.git --enable
```

Then restart the shell:

```sh
omarchy restart shell
```

---

## Usage

You can summon Omarchy Find in four convenient ways:

1. **Global Keyboard Shortcut (`Alt + Space`)** *(Recommended)*:
   Add the following line to `~/.config/hypr/bindings.lua` to open Find from anywhere:
   ```lua
   o.bind("ALT + SPACE", "Find files & folders", "omarchy-find")
   ```
2. **Status Bar Widget**: Click the magnifier icon (`󰍉`) on the Omarchy top bar.
3. **Application Launcher**: Open the Omarchy app launcher and click **Find**.
4. **CLI / Terminal**:
   - `omarchy-find` — Toggle the search overlay.
   - `omarchy-find open '{"query":"notes"}'` — Open with a pre-filled query.

### In-App Keyboard Shortcuts

| Shortcut | Description |
| -------- | ----------- |
| `Type` | Search files, folders and paths in real time |
| `go <query>` | Instant Google Search in default browser |
| `↑ / ↓` | Navigate up / down through results |
| `Ctrl+N / Ctrl+P` | Readline-style next / previous item navigation |
| `Ctrl+J / Ctrl+K` | Vim-style next / previous item navigation |
| `PageUp / PageDown` | Scroll page up / down (6 items) |
| `Home / End` | Jump to first / last result |
| `Tab` | Cycle through type filters |
| `Ctrl+S` | Cycle through sort modes (Relevance, Recent, Oldest, A-Z, Z-A) |
| `Enter` or click | Open selected file or folder with default application |
| `Alt+Enter` | Open enclosing folder in default file manager |
| `Ctrl+C` | Copy absolute file/folder path to clipboard (`wl-copy`) |
| `Ctrl+T` | Open terminal at selected item's directory |
| `Ctrl+W` / `Ctrl+Backspace` | Delete previous word in search input |
| `Ctrl+U` | Clear entire search query |
| `Esc` | Clear query if typed, or close overlay if query is empty |

---

## Enable / Disable

You can manage the plugin through the Omarchy menu:

```sh
omarchy > menu >  Enable Plugin > Omarchy Find
omarchy > menu >  Disable Plugin > Omarchy Find
```

Or use the CLI:

```sh
omarchy plugin enable jesseburlamaque.omarchy-find
omarchy plugin disable jesseburlamaque.omarchy-find
```

After enabling or disabling, restart the shell:

```sh
omarchy restart shell
```

## For Update

```sh
omarchy plugin update jesseburlamaque.omarchy-find --yes
```

## For Remove

```sh
omarchy plugin remove jesseburlamaque.omarchy-find
```

Then restart the shell:

```sh
omarchy restart shell
```

---

## Feedback & Contributions

This project is a work in progress — suggestions, bug reports, and improvements are very welcome!

---

## License

MIT
