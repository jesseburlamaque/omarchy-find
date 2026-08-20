# Omarchy Find

A Spotlight-style file search for the Omarchy shell. Summon the overlay, type to search files and folders across your home, filter by type, and open results with the default app.

## Features

- **Fuzzy and full-path search** powered by `fd`, with relevance scoring and smart ranking
- **Type filters:** All, Folders (User home), System Folders (`.config`, `omarchy`, `hypr`, etc.), Documents, Images, Videos, Audio, Code and Recent — cycle with Tab or click the chips
- **Sort options:** Relevance, Most Recent, Oldest, Name (A → Z) and Name (Z → A) — switch with 1 click or `Ctrl+S`
- **Direct Google Search:** type `go <query>` to search on Google directly in your default browser
- **Rich keyboard navigation:** navigate with arrow keys or readline (`Ctrl+N`/`P`) / vim (`Ctrl+J`/`K`)
- **Quick actions:** open file/folder, reveal parent directory in file manager (`Alt+Enter`), copy path (`Ctrl+C`), open terminal (`Ctrl+T`)
- **Recent suggestions:** open with no query to see files changed in the last 30 days, most recent first
- **Bar widget:** magnifier icon that toggles the search overlay
- **CLI + launcher app:** `omarchy-find` command and a **Find** app in the launcher
- Noisy directories excluded from search (`.git`, `node_modules`, caches, trash, internal browser storages…)
- Follows the active Omarchy theme colors

This project is a work in progress — I'd be happy to receive suggestions for improvements.

## Install
```sh
omarchy plugin add https://github.com/jesseburlamaque/omarchy-find.git --enable
```

Then restart the shell:

```sh
omarchy restart shell
```

## Usage

Open with `omarchy-find`, the launcher app **Find**, or the magnifier icon on the bar.

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

## License

MIT
