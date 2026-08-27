.pragma library

// AiConfig: built-in defaults + optional ~/.config/omarchy-find/ai.json overrides.
//
// Hard rule (see implementation plan §6): the config file is never created or
// rewritten by this plugin. Callers only ever hand us the raw text they read
// (or null/undefined when the file does not exist) and we hand back a
// complete, valid runtime config plus an optional short warning string.

var SUPPORTED_AGENTS = ["claude", "codex", "agy"]

// drainBaseCps / streamFlushMs tune the streaming "typewriter" reveal (see
// ai/AiBackend.js's catchUpChars()/tick()): the actual reveal rate scales
// continuously with how far behind the display is (a smooth exponential
// catch-up, not a linear cps), so these are no longer "the" reveal speed —
//   streamFlushMs: how often the display timer ticks. 16ms (60Hz) matches
//     web-chat-app smoothness; lower means more, smaller, steadier updates.
//   drainBaseCps: MINIMUM reveal rate floor (chars/sec) for when the
//     backlog is thin — keeps a slow trickle of text from crawling at an
//     imperceptible sub-character pace. Does not cap the top end at all;
//     a sudden burst still reveals proportionally faster on its own.
var DEFAULT_CONFIG = {
  agent: "claude",
  model: null,
  prefix: "ai ",
  maxAnswerRows: 6,
  drainBaseCps: 60,
  streamFlushMs: 16
}

function defaults() {
  var out = {}
  for (var k in DEFAULT_CONFIG) out[k] = DEFAULT_CONFIG[k]
  return out
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

// Returns the coerced value for a known field, or undefined if invalid.
// Callers fall back to the current default when undefined is returned.
function coerceField(key, value) {
  switch (key) {
    case "agent":
      if (typeof value === "string" && SUPPORTED_AGENTS.indexOf(value) !== -1) return value
      return undefined
    case "model":
      if (value === null) return null
      if (typeof value === "string" && value.trim().length > 0) return value.trim()
      return undefined
    case "prefix":
      if (typeof value === "string" && value.length > 0 && value.trim().length > 0) return value
      return undefined
    case "maxAnswerRows": {
      var rows = Number(value)
      if (isFinite(rows) && rows >= 1 && rows <= 40) return Math.round(rows)
      return undefined
    }
    case "drainBaseCps": { // minimum reveal-rate floor, chars/sec — see DEFAULT_CONFIG comment
      var cps = Number(value)
      if (isFinite(cps) && cps > 0 && cps <= 10000) return cps
      return undefined
    }
    case "streamFlushMs": { // display-timer tick interval, ms — see DEFAULT_CONFIG comment
      var ms = Number(value)
      if (isFinite(ms) && ms >= 8 && ms <= 1000) return Math.round(ms)
      return undefined
    }
    default:
      return undefined
  }
}

// Merge raw ai.json text (or null/undefined/empty when absent) onto the
// compiled defaults. Never throws. Always returns a fully-populated config.
//
// Returns { config, warning } where warning is a short human-readable string
// (or null). A warning never blocks startup and the source file is never
// touched, per the plan's "invalid config" rule.
function mergeConfig(rawText) {
  var config = defaults()

  var trimmed = (rawText === null || rawText === undefined) ? "" : String(rawText).trim()
  if (trimmed.length === 0) {
    return { config: config, warning: null }
  }

  var parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { config: config, warning: "ai.json is not valid JSON — using built-in defaults" }
  }

  if (!isPlainObject(parsed)) {
    return { config: config, warning: "ai.json must be a JSON object — using built-in defaults" }
  }

  var invalidAgent = Object.prototype.hasOwnProperty.call(parsed, "agent") &&
    coerceField("agent", parsed.agent) === undefined
  var invalidFields = []
  for (var key in DEFAULT_CONFIG) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue
    var coerced = coerceField(key, parsed[key])
    if (coerced === undefined) {
      invalidFields.push(key)
      continue
    }
    config[key] = coerced
  }
  // Unknown top-level fields are silently ignored for forwards compatibility.

  var warning = null
  if (invalidFields.length > 0) {
    if (invalidAgent) {
      // Dedicated wording for the unsupported-agent case (§26.12: "clear
      // error"), distinct from the generic per-field warning below — this
      // is the one misconfiguration that changes which CLI runs at all.
      warning = "ai.json: unsupported agent \"" + String(parsed.agent) +
        "\" (expected one of " + SUPPORTED_AGENTS.join(", ") + ") — using \"" + config.agent + "\""
      var otherFields = []
      for (var i = 0; i < invalidFields.length; i++) {
        if (invalidFields[i] !== "agent") otherFields.push(invalidFields[i])
      }
      if (otherFields.length > 0) {
        warning += "; also invalid: " + otherFields.join(", ")
      }
    } else {
      warning = "ai.json has an invalid value for " + invalidFields.join(", ") +
        " — using the default for " + (invalidFields.length === 1 ? "that field" : "those fields")
    }
  }
  return { config: config, warning: warning }
}
