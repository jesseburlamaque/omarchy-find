# Omarchy Find

A Spotlight-style file search for the Omarchy shell. Summon the overlay, type to search files and folders across your home, filter by type, and open results with the default app.

## Features

- **Fuzzy search** powered by `fd`, with fzf-style multi-term ranking
- **Type filters:** All, Folders, Documents, Images, Videos, Audio, Code and Recent — cycle with Tab or click the chips
- **Recent suggestions:** open with no query to see files changed in the last 30 days, most recent first
- **Friendly dates** like `Today 14:32` and `Yesterday 09:05`, following the system locale (pt/en)
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

By default the magnifier icon is placed in the **right** section of the bar. If it does not land where you want, drag it there with the bar's built-in gesture, or run:

```sh
omarchy bar move jesseburlamaque.omarchy-find --section right --index 0
```

(Adjust the section/index as needed depending on your other widgets.)

### CLI and launcher app

The `omarchy-find` command and the **Find** launcher app come with the bundled install script:

```sh
git clone https://github.com/jesseburlamaque/omarchy-find.git
cd omarchy-find
./install.sh
```

The script copies the plugin to `~/.config/omarchy/plugins/`, installs the CLI into `~/.local/bin`, registers the desktop entry, and enables the plugin.

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

## Remove

```sh
omarchy plugin remove jesseburlamaque.omarchy-find
```

If you installed through `install.sh`, run `./install.sh --disable` instead so the CLI and the launcher app are removed as well.

Then restart the shell:

```sh
omarchy restart shell
```

## Usage

Open with `omarchy-find`, the launcher app **Find**, or the magnifier icon on the bar.

- **Type** to search — results update as you type
- **↑ / ↓** navigate the results (PageUp/PageDown, Home/End also work)
- **Tab / Shift+Tab** cycle the type filters
- **Enter** or click opens the selected file or folder
- **Esc** clears the query, or closes the overlay if the query is empty

### CLI

```sh
omarchy-find                           # toggle (default)
omarchy-find open '{"query":"notas"}'  # open with a pre-filled query
omarchy-find close                     # close the overlay
```

## License

MIT
