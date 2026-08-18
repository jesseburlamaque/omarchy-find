# Omarchy Find

A Spotlight-style file search for the Omarchy shell. Summon the overlay, type to search files and folders across your home, filter by type, and open results with the default app.

## Features

- **Fuzzy search** powered by `fd`, with fzf-style multi-term ranking
- **Type filters:** All, Folders, Documents, Images, Videos, Audio, Code and Recent — cycle with Tab or click the chips
- **Recent suggestions:** open with no query to see files changed in the last 30 days, most recent first
- **Enter or click to open** the selected file or folder with the default app (`xdg-open`)
- **Bar widget:** magnifier icon that toggles the search overlay
- **CLI + launcher app:** `omarchy-find` command and a **Find** app in the launcher
- Noisy directories excluded from search (`.git`, `node_modules`, caches, trash…)
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

| Action | What it does |
| ------ | ------------ |
| Type | Search — results update as you type |
| ↑ / ↓ | Navigate the results |
| PageUp / PageDown, Home / End | Navigate faster through the results |
| Tab / Shift+Tab | Cycle the type filters |
| Enter or click | Open the selected file or folder |
| Esc | Clear the query, or close the overlay if the query is empty |

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

If you installed through `install.sh`, run `./install.sh --disable` instead so the CLI and the launcher app are removed as well.

Then restart the shell:

```sh
omarchy restart shell
```

## License

MIT
