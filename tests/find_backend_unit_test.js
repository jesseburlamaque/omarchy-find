#!/usr/bin/env node
// Plain-Node unit tests for the pure logic in FindBackend.js — specifically
// the optional ~/.config/omarchy-find/config.json handling (mergeUserConfig)
// and how it reaches fd's argv (buildArgv).
//
// loadQmlLibrary() strips the two Qt-specific directives Node doesn't
// understand and runs the rest of the unmodified production source in a
// fresh vm context; see tests/ai_unit_test.js for the full rationale.
//
// Run with: node tests/find_backend_unit_test.js

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function loadQmlLibrary(relPath) {
  const raw = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8")
  const stripped = raw
    .split("\n")
    .filter(line => {
      const t = line.trim()
      return !(t === ".pragma library" || t.indexOf(".import ") === 0)
    })
    .join("\n")

  const sandbox = { console: console }
  vm.createContext(sandbox)
  vm.runInContext(stripped, sandbox, { filename: relPath })
  return sandbox
}

const Backend = loadQmlLibrary("FindBackend.js")

// ---------------------------------------------------------------- harness --

let pass = 0
let fail = 0
const failures = []

function assert(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(msg)
    console.error("FAIL: " + msg)
  }
}

function eq(actual, expected, msg) {
  assert(actual === expected, msg + " (got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) + ")")
}

function deepEq(actual, expected, msg) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    msg + " (got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) + ")")
}

// Index of the "-E <pattern>" value pairs in an argv, in order.
function excludesOf(argv) {
  const out = []
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "-E") out.push(argv[i + 1])
  }
  return out
}

const HOME = "/home/tester"
const ALL = 0
const FOLDERS = 1
const SYSTEM_FOLDERS = 2

// ------------------------------------------------------- mergeUserConfig --

// Absent, empty or whitespace-only config is the normal case: built-in
// defaults, no warning, nothing to tell the user about.
{
  const cases = [undefined, null, "", "   \n  "]
  for (const raw of cases) {
    const r = Backend.mergeUserConfig(raw)
    deepEq(r.config, { excludes: [], oneFileSystem: false },
      "no config (" + JSON.stringify(raw) + ") yields built-in defaults")
    eq(r.warning, null, "no config (" + JSON.stringify(raw) + ") warns about nothing")
  }
}

// A broken file degrades to defaults with a warning — it must never throw,
// because the caller is a FileView signal handler on the search hot path.
{
  const r = Backend.mergeUserConfig("{ not json")
  deepEq(r.config, { excludes: [], oneFileSystem: false }, "invalid JSON falls back to defaults")
  assert(typeof r.warning === "string" && r.warning.indexOf("valid JSON") !== -1,
    "invalid JSON produces a warning naming the problem (got " + JSON.stringify(r.warning) + ")")
}

{
  for (const raw of ['["iCloud"]', '"iCloud"', "42", "null"]) {
    const r = Backend.mergeUserConfig(raw)
    deepEq(r.config, { excludes: [], oneFileSystem: false },
      "top-level " + raw + " is not an object — falls back to defaults")
    assert(typeof r.warning === "string" && r.warning.length > 0,
      "top-level " + raw + " produces a warning")
  }
}

// The documented happy path from issue #5.
{
  const r = Backend.mergeUserConfig('{"excludes": ["iCloud", "remote-nfs"], "oneFileSystem": false}')
  deepEq(r.config, { excludes: ["iCloud", "remote-nfs"], oneFileSystem: false },
    "a well-formed config is taken verbatim")
  eq(r.warning, null, "a well-formed config warns about nothing")
}

// Blank and duplicate entries are hand-written-list noise, not mistakes:
// dropped quietly, everything else kept in order.
{
  const r = Backend.mergeUserConfig('{"excludes": ["  iCloud  ", "", "   ", "iCloud", "Dropbox"]}')
  deepEq(r.config.excludes, ["iCloud", "Dropbox"],
    "exclude entries are trimmed, and blanks and duplicates dropped")
  eq(r.warning, null, "trimmed/duplicate entries alone do not warrant a warning")
}

// A non-string entry is a real mistake — reject the field, keep searching.
{
  const r = Backend.mergeUserConfig('{"excludes": ["iCloud", 7]}')
  deepEq(r.config.excludes, [], "a non-string exclude entry rejects the whole field")
  assert(typeof r.warning === "string" && r.warning.indexOf("excludes") !== -1,
    "a non-string exclude entry names the field in the warning (got " + JSON.stringify(r.warning) + ")")
}

{
  const r = Backend.mergeUserConfig('{"excludes": "iCloud"}')
  deepEq(r.config.excludes, [], "a string (not array) excludes value is rejected")
  assert(r.warning !== null, "a string excludes value warns")
}

// Bounded so a runaway config cannot build an unbounded argv.
{
  const many = []
  for (let i = 0; i < Backend.MAX_USER_EXCLUDES + 25; i++) many.push("dir" + i)
  const r = Backend.mergeUserConfig(JSON.stringify({ excludes: many }))
  eq(r.config.excludes.length, Backend.MAX_USER_EXCLUDES,
    "the exclude list is capped at MAX_USER_EXCLUDES")
}

// oneFileSystem is strictly boolean — "true" the string is a mistake, and
// silently treating it as true would be a surprising way to lose results.
{
  eq(Backend.mergeUserConfig('{"oneFileSystem": true}').config.oneFileSystem, true,
    "oneFileSystem: true is honoured")
  eq(Backend.mergeUserConfig('{"oneFileSystem": false}').config.oneFileSystem, false,
    "oneFileSystem: false is honoured")

  const r = Backend.mergeUserConfig('{"oneFileSystem": "true"}')
  eq(r.config.oneFileSystem, false, "a non-boolean oneFileSystem falls back to the default")
  assert(typeof r.warning === "string" && r.warning.indexOf("oneFileSystem") !== -1,
    "a non-boolean oneFileSystem names the field in the warning")
}

// One bad field must not take the other down with it.
{
  const r = Backend.mergeUserConfig('{"excludes": ["iCloud"], "oneFileSystem": 1}')
  deepEq(r.config.excludes, ["iCloud"], "a valid excludes survives an invalid oneFileSystem")
  eq(r.config.oneFileSystem, false, "the invalid oneFileSystem still falls back")
  assert(r.warning !== null, "the mixed case still warns")
}

// Forwards compatibility: a newer config on an older plugin keeps working.
{
  const r = Backend.mergeUserConfig('{"excludes": ["iCloud"], "somethingNewer": {"a": 1}}')
  deepEq(r.config, { excludes: ["iCloud"], oneFileSystem: false },
    "unknown top-level fields are ignored")
  eq(r.warning, null, "unknown top-level fields do not warn")
}

// --------------------------------------------------------------- buildArgv --

// The whole point of the defaults: a user with no config file gets byte-for-
// byte the argv the plugin has always built.
{
  for (const filterIndex of [ALL, FOLDERS, SYSTEM_FOLDERS]) {
    for (const forDirs of [true, false]) {
      const bare = Backend.buildArgv("notes", filterIndex, forDirs, HOME)
      const defaulted = Backend.buildArgv("notes", filterIndex, forDirs, HOME, Backend.defaultUserConfig())
      deepEq(defaulted, bare,
        "default config changes nothing for filter " + filterIndex + "/dirs=" + forDirs)
      assert(bare.indexOf("--one-file-system") === -1,
        "no config means no --one-file-system for filter " + filterIndex + "/dirs=" + forDirs)
      deepEq(excludesOf(bare).slice(0, Backend.EXCLUDES.length), Backend.EXCLUDES,
        "the built-in excludes still lead for filter " + filterIndex + "/dirs=" + forDirs)
    }
  }
}

// An explicitly missing/garbage userConfig argument must not break argv.
{
  const bare = Backend.buildArgv("notes", ALL, false, HOME)
  for (const bad of [null, undefined, {}, { excludes: "iCloud" }, { excludes: null }]) {
    deepEq(Backend.buildArgv("notes", ALL, false, HOME, bad), bare,
      "a userConfig of " + JSON.stringify(bad) + " degrades to the no-config argv")
  }
}

// User excludes reach fd, after the built-ins.
{
  const cfg = { excludes: ["iCloud", "remote-nfs"], oneFileSystem: false }
  const argv = Backend.buildArgv("notes", ALL, false, HOME, cfg)
  deepEq(excludesOf(argv), Backend.EXCLUDES.concat(["iCloud", "remote-nfs"]),
    "user excludes are appended after the built-in excludes")
  assert(argv.indexOf("--one-file-system") === -1,
    "oneFileSystem: false adds no flag")
}

// The System Folders filter has its own exclude set; the user's must still
// apply there, or the slow mount is only skipped on some filters.
{
  const cfg = { excludes: ["iCloud"], oneFileSystem: false }
  const argv = Backend.buildArgv("hypr", SYSTEM_FOLDERS, true, HOME, cfg)
  const ex = excludesOf(argv)
  assert(ex.indexOf("iCloud") !== -1, "user excludes apply to the System Folders filter too")
  deepEq(ex, Backend.EXCLUDES.concat(["iCloud"], Backend.SYSTEM_EXCLUDES),
    "System Folders keeps built-ins, then user excludes, then its own set")
}

// --one-file-system is passed once, and only when asked for.
{
  const argv = Backend.buildArgv("notes", ALL, false, HOME, { excludes: [], oneFileSystem: true })
  eq(argv.filter(a => a === "--one-file-system").length, 1,
    "oneFileSystem: true passes --one-file-system exactly once")
  assert(argv.indexOf("--one-file-system") < argv.indexOf("--"),
    "--one-file-system lands among the flags, before the pattern separator")
}

// Both options together, on the empty (recent items) query.
{
  const argv = Backend.buildArgv("", ALL, true, HOME, { excludes: ["iCloud"], oneFileSystem: true })
  assert(argv.indexOf("--one-file-system") !== -1, "empty query still gets --one-file-system")
  assert(excludesOf(argv).indexOf("iCloud") !== -1, "empty query still gets user excludes")
  eq(argv[argv.length - 1], HOME, "the search root is unchanged")
}

// ------------------------------------------------------------- summary ----

console.log("")
console.log(pass + " passed, " + fail + " failed")
if (fail > 0) process.exit(1)
