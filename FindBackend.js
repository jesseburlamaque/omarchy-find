.pragma library

// Backend do omarchy-find: define os filtros por tipo, monta a linha de
// comando do fd e ranqueia os resultados em JS (estilo fzf, sem TUI).

var MAX_RESULTS = 250
var DISPLAY_LIMIT = 60
var EMPTY_QUERY_DAYS = 30

// Diretórios ruidosos que nunca interessam numa busca estilo Spotlight.
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
  ".venv",
  "venv"
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

// Traduções por locale. Para adicionar um novo idioma, basta adicionar uma
// nova entrada (ex.: LOCALES.de = { all: "Alle", ... }) e o fallback cuida do
// resto. Idiomas desconhecidos usam o inglês como língua-franca.
var LOCALES = {
  pt: {
    all: "Tudo", folders: "Pastas", docs: "Documentos", images: "Imagens",
    videos: "Vídeos", audio: "Áudio", code: "Código", recent: "Recentes",
    today: "Hoje", yesterday: "Ontem",
    searchPlaceholder: "Buscar arquivos, pastas e mais…",
    searching: "buscando…", searchingState: "Buscando…",
    result: " resultado", results: " resultados",
    noResults: "Sem resultados para \"",
    noRecent: "Nada recente por aqui",
    expand: "Expandir", collapse: "Recolher",
    footer: "↑↓ navegar · Tab trocar filtro · Enter abrir · Esc fechar"
  },
  en: {
    all: "All", folders: "Folders", docs: "Documents", images: "Images",
    videos: "Videos", audio: "Audio", code: "Code", recent: "Recent",
    today: "Today", yesterday: "Yesterday",
    searchPlaceholder: "Search files, folders and more…",
    searching: "searching…", searchingState: "Searching…",
    result: " result", results: " results",
    noResults: "No results for \"",
    noRecent: "Nothing recent here",
    expand: "Expand", collapse: "Collapse",
    footer: "↑↓ navigate · Tab switch filter · Enter open · Esc close"
  }
}

function pickBucket(locale) {
  var l = String(locale || "")
  // Tenta o locale completo (ex.: "pt_BR"), depois o prefixo ("pt"),
  // depois o inglês como fallback universal.
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
  { id: "all",     label: "All",        dirs: true,  files: true,  exts: [],          recentDays: 0 },
  { id: "folders", label: "Folders",    dirs: true,  files: false, exts: [],          recentDays: 0 },
  { id: "docs",    label: "Documents",  dirs: false, files: true,  exts: DOCS_EXTS,   recentDays: 0 },
  { id: "images",  label: "Images",     dirs: false, files: true,  exts: IMAGES_EXTS, recentDays: 0 },
  { id: "videos",  label: "Videos",     dirs: false, files: true,  exts: VIDEOS_EXTS, recentDays: 0 },
  { id: "audio",   label: "Audio",      dirs: false, files: true,  exts: AUDIO_EXTS,  recentDays: 0 },
  { id: "code",    label: "Code",       dirs: false, files: true,  exts: CODE_EXTS,   recentDays: 0 },
  { id: "recent",  label: "Recent",     dirs: true,  files: true,  exts: [],          recentDays: 14 }
]

function isSubsequence(needle, haystack) {
  if (needle.length === 0) return true
  var n = 0
  for (var h = 0; h < haystack.length && n < needle.length; h++) {
    if (haystack.charAt(h) === needle.charAt(n)) n++
  }
  return n === needle.length
}

// Regex fuzzy estilo fzf: "nota fiscal" -> "n.*o.*t.*a.* .*f.*i..." não —
// espaços viram separadores, então cada termo vira subsequência em ordem.
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

// Monta o argv do fd para um dos dois streams (dirs ou files).
// query vazia lista itens recentes (comportamento "sugestões" do Spotlight).
function buildArgv(query, filterIndex, forDirs, home) {
  var filter = FILTERS[filterIndex] || FILTERS[0]
  var argv = ["fd", "--color=never", "--max-results", String(MAX_RESULTS)]
  argv.push("--type", forDirs ? "d" : "f")
  argv.push("--hidden")
  for (var i = 0; i < EXCLUDES.length; i++) argv.push("-E", EXCLUDES[i])
  if (!forDirs) {
    for (var e = 0; e < filter.exts.length; e++) argv.push("-e", filter.exts[e])
  }
  var days = filter.recentDays || 0
  if (query.trim().length === 0 && days === 0) days = EMPTY_QUERY_DAYS
  if (days > 0) argv.push("--changed-within", days + "d")
  argv.push("--")
  var q = query.trim()
  if (q.length === 0) argv.push(".")
  else if (q.length <= 2) argv.push("--fixed-strings", q)
  else argv.push(fuzzyPattern(q))
  argv.push(home)
  return argv
}

function basename(path) {
  var idx = path.lastIndexOf("/")
  return idx === -1 ? path : path.slice(idx + 1)
}

// Parse da saída de `stat -c '%Y\t%n'`: retorna mapa { "/caminho": epochMs }.
// Caminhos com espaços funcionam (split no primeiro TAB); lixo é ignorado.
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

// Data+hora amigável seguindo o idioma: "Hoje/Today 14:32",
// "Ontem/Yesterday 09:05", "18/08 14:32" no ano corrente,
// "31/12/24 14:32" em outros anos.
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

function parseLines(text, isDir, home) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    // o fd imprime diretórios com "/" no final; remove antes de extrair o nome
    var path = lines[i].replace(/\/+$/, "")
    if (!path || path.charAt(0) !== "/") continue
    var name = basename(path)
    if (!name) continue
    out.push({
      path: path,
      name: name,
      dir: parentDir(path, home),
      isDir: isDir,
      icon: iconFor(name, isDir)
    })
  }
  return out
}

// Pontua um único termo contra o nome. Menor é melhor; -1 = sem match.
function scoreTerm(name, term) {
  if (name === term) return 0
  if (name.indexOf(term) === 0) return 1
  var idx = name.indexOf(term)
  if (idx > 0) {
    var prev = name.charAt(idx - 1)
    if (prev === " " || prev === "-" || prev === "_" || prev === ".") return 2
    return 3
  }
  if (isSubsequence(term, name)) return 4
  return -1
}

// Menor é melhor; -1 descarta o item. Query multi-termo: cada termo precisa
// casar (nome primeiro, caminho como fallback), como no fzf.
function scoreItem(item, query) {
  var name = item.name.toLowerCase()
  var path = item.path.toLowerCase()
  var terms = query.split(/\s+/)
  var total = 0
  for (var i = 0; i < terms.length; i++) {
    var s = scoreTerm(name, terms[i])
    if (s < 0) {
      if (path.indexOf(terms[i]) !== -1) s = 5
      else if (isSubsequence(terms[i], path)) s = 6
      else return -1
    }
    total += s
  }
  return total
}

function rankResults(items, query, limit) {
  var q = query.trim().toLowerCase()
  if (q.length === 0) return items.slice(0, limit)
  var scored = []
  for (var i = 0; i < items.length; i++) {
    var s = scoreItem(items[i], q)
    if (s >= 0) scored.push({ item: items[i], score: s })
  }
  scored.sort(function(a, b) {
    if (a.score !== b.score) return a.score - b.score
    if (a.item.isDir !== b.item.isDir) return a.item.isDir ? -1 : 1
    if (a.item.name.length !== b.item.name.length) return a.item.name.length - b.item.name.length
    return a.item.path < b.item.path ? -1 : (a.item.path > b.item.path ? 1 : 0)
  })
  var out = []
  for (var j = 0; j < scored.length && j < limit; j++) out.push(scored[j].item)
  return out
}
