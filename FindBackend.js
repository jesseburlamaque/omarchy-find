.pragma library

// Backend: configures filters, builds fd command, and ranks results.

var MAX_RESULTS = 250
var DISPLAY_LIMIT = 60
var EMPTY_QUERY_DAYS = 30

// Excluded noisy directories.
var EXCLUDES = [
  ".git",
  "node_modules",
  ".cache",
  "__pycache__",
  ".npm",
  ".nvm",
  ".cargo",
  ".rustup",
  ".gradle",
  ".local/share/Trash",
  ".local/share/flatpak",
  ".venv",
  "venv"
]

var SYSTEM_EXCLUDES = [
  "*Cache*",
  "Local Storage",
  "Session Storage",
  "Service Worker",
  "blob_storage",
  "Dawn*",
  "logs",
  "*Storage*",
  "History",
  "data",
  "Crashpad",
  "Dictionaries",
  "Partitions",
  "Shared Dictionary",
  "Backups",
  "google-chrome*",
  "microsoft-edge*",
  "chromium",
  "BraveSoftware",
  "mozilla",
  "dconf",
  "ibus",
  "fcitx",
  "pulse",
  "procps",
  ".*.bak.*"
]

var DOCS_EXTS = ["pdf", "doc", "docx", "odt", "ott", "rtf", "txt", "md", "markdown",
  "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "epub"]
var IMAGES_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
  "tif", "tiff", "heic", "heif", "avif", "raw", "cr2", "nef"]
var VIDEOS_EXTS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg",
  "wmv", "flv", "ts", "m2ts", "3gp"]
var AUDIO_EXTS = ["mp3", "flac", "ogg", "oga", "opus", "wav", "m4a", "aac",
  "wma", "aiff", "aif", "mid", "midi"]
var CODE_EXTS = ["c", "h", "cpp", "cxx", "cc", "hpp", "hh", "rs", "go", "py", "pyw",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "yaml", "yml", "toml",
  "lua", "sh", "bash", "zsh", "fish", "css", "scss", "sass", "less", "html", "htm",
  "xml", "java", "kt", "kts", "rb", "php", "pl", "pm", "sql", "qml", "vue", "svelte",
  "zig", "cs", "swift", "dart", "ex", "exs", "hs", "ml", "r", "jl", "nim", "v",
  "cmake", "mk", "ini", "conf", "cfg"]

// Locale translations with English fallback.
var LOCALES = {
  pt: {
    all: "Tudo", folders: "Pastas", systemFolders: "Pastas do Sistema", docs: "Documentos", images: "Imagens",
    videos: "Vídeos", audio: "Áudio", code: "Código", recent: "Recentes",
    today: "Hoje", yesterday: "Ontem",
    searchPlaceholder: "Buscar arquivos, pastas e mais…",
    searching: "buscando…", searchingState: "Buscando…",
    result: " resultado", results: " resultados",
    noResults: "Sem resultados para \"",
    noRecent: "Nada recente por aqui",
    expand: "Expandir", collapse: "Recolher",
    footer: "↑↓ navegar · Tab trocar filtro · Enter abrir · Esc fechar\nAlt+Enter abrir pasta · Ctrl+C copiar caminho · Ctrl+T abrir terminal",
    googleSearch: "Busca no Google",
    searchGoogleFor: "Buscar no Google por \"",
    googleFooter: "Enter abrir no navegador · Esc fechar"
  },
  en: {
    all: "All", folders: "Folders", systemFolders: "System Folders", docs: "Documents", images: "Images",
    videos: "Videos", audio: "Audio", code: "Code", recent: "Recent",
    today: "Today", yesterday: "Yesterday",
    searchPlaceholder: "Search files, folders and more…",
    searching: "searching…", searchingState: "Searching…",
    result: " result", results: " results",
    noResults: "No results for \"",
    noRecent: "Nothing recent here",
    expand: "Expand", collapse: "Collapse",
    footer: "↑↓ navigate · Tab switch filter · Enter open · Esc close\nAlt+Enter open folder · Ctrl+C copy path · Ctrl+T open terminal",
    googleSearch: "Google Search",
    searchGoogleFor: "Search Google for \"",
    googleFooter: "Enter open in browser · Esc close"
  }
}

function pickBucket(locale) {
  var l = String(locale || "")
  // Try full locale, then prefix, fallback to English.
  if (LOCALES[l]) return LOCALES[l]
  var prefix = l.split(/[-_]/)[0]
  if (LOCALES[prefix]) return LOCALES[prefix]
  return LOCALES.en
}

function t(key, locale) {
  var bucket = pickBucket(locale)
  if (bucket[key] !== undefined) return bucket[key]
  if (LOCALES.en[key] !== undefined) return LOCALES.en[key]
  return key
}

var FILTERS = [
  { id: "all",           label: "All",            dirs: true,  files: true,  exts: [],          recentDays: 0, hidden: true },
  { id: "folders",       label: "Folders",        dirs: true,  files: false, exts: [],          recentDays: 0, hidden: false },
  { id: "systemFolders", label: "System Folders", dirs: true,  files: false, exts: [],          recentDays: 0, systemFolders: true },
  { id: "docs",          label: "Documents",      dirs: false, files: true,  exts: DOCS_EXTS,   recentDays: 0, hidden: false },
  { id: "images",        label: "Images",         dirs: false, files: true,  exts: IMAGES_EXTS, recentDays: 0, hidden: false },
  { id: "videos",        label: "Videos",         dirs: false, files: true,  exts: VIDEOS_EXTS, recentDays: 0, hidden: false },
  { id: "audio",         label: "Audio",          dirs: false, files: true,  exts: AUDIO_EXTS,  recentDays: 0, hidden: false },
  { id: "code",          label: "Code",           dirs: false, files: true,  exts: CODE_EXTS,   recentDays: 0, hidden: false },
  { id: "recent",        label: "Recent",         dirs: true,  files: true,  exts: [],          recentDays: 14, hidden: true }
]

function isSubsequence(needle, haystack) {
  if (needle.length === 0) return true
  var n = 0
  for (var h = 0; h < haystack.length && n < needle.length; h++) {
    if (haystack.charAt(h) === needle.charAt(n)) n++
  }
  return n === needle.length
}

// Fzf-like fuzzy pattern: space-separated terms as subsequences.
function fuzzyPattern(query) {
  var terms = query.trim().split(/\s+/)
  var specials = "\\^$.[]|()?*+{}"
  var parts = []
  for (var t = 0; t < terms.length; t++) {
    var term = terms[t]
    var s = ""
    for (var i = 0; i < term.length; i++) {
      var ch = term.charAt(i)
      if (specials.indexOf(ch) !== -1) s += "\\" + ch
      else s += ch
      if (i < term.length - 1) s += ".*"
    }
    parts.push(s)
  }
  return parts.join(".*")
}

// Builds fd arguments. Empty query lists recent items.
function buildArgv(query, filterIndex, forDirs, home) {
  var filter = FILTERS[filterIndex] || FILTERS[0]
  var argv = ["fd", "--color=never", "--max-results", String(MAX_RESULTS)]
  argv.push("--type", forDirs ? "d" : "f")

  if (filter.hidden !== false) {
    argv.push("--hidden")
  }

  for (var i = 0; i < EXCLUDES.length; i++) argv.push("-E", EXCLUDES[i])

  if (filter.systemFolders) {
    argv.push("--max-depth", "3")
    for (var s = 0; s < SYSTEM_EXCLUDES.length; s++) argv.push("-E", SYSTEM_EXCLUDES[s])
  }

  if (!forDirs) {
    for (var e = 0; e < filter.exts.length; e++) argv.push("-e", filter.exts[e])
  }
  var days = filter.recentDays || 0
  if (query.trim().length === 0 && days === 0) days = EMPTY_QUERY_DAYS
  if (days > 0) argv.push("--changed-within", days + "d")

  argv.push("--full-path")
  argv.push("--")

  var q = query.trim()
  if (q.length === 0) {
    if (filter.systemFolders) {
      argv.push("/\\.config(/|$)")
    } else {
      argv.push(".")
    }
  } else {
    var escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (filter.systemFolders) {
      argv.push("/\\.config.*" + escaped)
    } else {
      argv.push(escaped)
    }
  }

  argv.push(home)
  return argv
}

function basename(path) {
  var idx = path.lastIndexOf("/")
  return idx === -1 ? path : path.slice(idx + 1)
}

// Parses stat output format: "%Y\t%n".
function parseStatLines(text) {
  var map = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var tab = lines[i].indexOf("\t")
    if (tab <= 0) continue
    var sec = Number(lines[i].slice(0, tab))
    var path = lines[i].slice(tab + 1)
    if (!isFinite(sec) || sec <= 0 || path.charAt(0) !== "/") continue
    map[path] = sec * 1000
  }
  return map
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n
}

// Formats timestamps relative to current date.
function formatMtime(msec, nowMs, locale) {
  var d = new Date(msec)
  var now = new Date(nowMs === undefined ? Date.now() : nowMs)
  var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes())
  if (d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate()) return t("today", locale) + " " + hm
  var yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (d.getFullYear() === yest.getFullYear()
      && d.getMonth() === yest.getMonth()
      && d.getDate() === yest.getDate()) return t("yesterday", locale) + " " + hm
  var dm = pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1)
  if (d.getFullYear() === now.getFullYear()) return dm + " " + hm
  return dm + "/" + String(d.getFullYear()).slice(2) + " " + hm
}

function parentDir(path, home) {
  var idx = path.lastIndexOf("/")
  var dir = idx <= 0 ? "/" : path.slice(0, idx)
  if (home && dir.indexOf(home) === 0) dir = "~" + dir.slice(home.length)
  return dir
}

function extension(name) {
  var idx = name.lastIndexOf(".")
  if (idx <= 0 || idx === name.length - 1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function contains(list, value) {
  return list.indexOf(value) !== -1
}

function iconFor(name, isDir) {
  if (isDir) return "󰉋"
  var ext = extension(name)
  if (contains(IMAGES_EXTS, ext)) return "󰋩"
  if (contains(VIDEOS_EXTS, ext)) return "󰕧"
  if (contains(AUDIO_EXTS, ext)) return "󰎈"
  if (contains(CODE_EXTS, ext)) return "󰅩"
  if (contains(DOCS_EXTS, ext)) return "󰈙"
  return "󰈔"
}

function isSystemPath(path, home) {
  var p = String(path || "")
  if (!home || p.indexOf(home) !== 0) return true
  var rel = p.slice(home.length)
  if (rel.charAt(0) === "/") rel = rel.slice(1)
  var parts = rel.split("/")
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].charAt(0) === ".") return true
  }
  return false
}

function parseLines(text, isDir, home) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    // Strip trailing slash from directories.
    var path = lines[i].replace(/\/+$/, "")
    if (!path || path.charAt(0) !== "/") continue
    var name = basename(path)
    if (!name) continue
    out.push({
      path: path,
      name: name,
      dir: parentDir(path, home),
      isDir: isDir,
      isSystem: isSystemPath(path, home),
      icon: iconFor(name, isDir)
    })
  }
  return out
}

// Scores term against filename: lower is better, -1 is no match.
function scoreTerm(name, term) {
  if (name === term) return 0
  if (name.indexOf(term) === 0) return 1
  var idx = name.indexOf(term)
  if (idx > 0) {
    var prev = name.charAt(idx - 1)
    if (prev === " " || prev === "-" || prev === "_" || prev === "." || prev === "/") return 2
    return 3
  }
  return -1
}

// Scores item against query: matches all terms, fallback to path.
function scoreItem(item, query) {
  var name = item.name.toLowerCase()
  var path = item.path.toLowerCase()
  var terms = query.trim().toLowerCase().split(/\s+/)
  var total = 0
  for (var i = 0; i < terms.length; i++) {
    var term = terms[i]
    var s = scoreTerm(name, term)
    if (s < 0) {
      if (path.indexOf("/" + term) !== -1 || path.indexOf("/." + term) !== -1) s = 4
      else if (path.indexOf(term) !== -1) s = 5
      else return -1
    }
    total += s
  }
  return total
}

function rankResults(items, query, limit, home) {
  var q = query.trim().toLowerCase()
  if (q.length === 0) {
    var copy = items.slice()
    copy.sort(function(a, b) {
      var aSys = a.isSystem !== undefined ? a.isSystem : isSystemPath(a.path, home)
      var bSys = b.isSystem !== undefined ? b.isSystem : isSystemPath(b.path, home)
      if (aSys !== bSys) return aSys ? 1 : -1
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)
    })
    return copy.slice(0, limit)
  }
  var scored = []
  for (var i = 0; i < items.length; i++) {
    var s = scoreItem(items[i], q)
    if (s >= 0) {
      var isSys = items[i].isSystem !== undefined ? items[i].isSystem : isSystemPath(items[i].path, home)
      scored.push({ item: items[i], score: s, isSystem: isSys })
    }
  }
  scored.sort(function(a, b) {
    // 1. Better query relevance score comes first! (Exact match beats fuzzy)
    if (a.score !== b.score) return a.score - b.score
    // 2. For items with equal score, prefer user files/folders over system/hidden files
    if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1
    // 3. Directories before files
    if (a.item.isDir !== b.item.isDir) return a.item.isDir ? -1 : 1
    // 4. Shorter name length
    if (a.item.name.length !== b.item.name.length) return a.item.name.length - b.item.name.length
    // 5. Alphabetical path
    return a.item.path < b.item.path ? -1 : (a.item.path > b.item.path ? 1 : 0)
  })
  var out = []
  for (var j = 0; j < scored.length && j < limit; j++) out.push(scored[j].item)
  return out
}
