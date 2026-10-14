#!/usr/bin/env node
// Plain-Node unit tests for the dead-key composition in FindBackend.js (composeDeadKey).
// FindBackend.js is QML "pragma library" JavaScript, so the `.pragma library` line is stripped and the rest
// runs in a fresh vm context (same approach as tests/ai_unit_test.js).
//
// Run with: node tests/dead_keys_test.js

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const src = fs.readFileSync(path.join(__dirname, "..", "FindBackend.js"), "utf8")
  .split("\n").filter(l => !/^\s*\.pragma\s+library/.test(l)).join("\n")
const B = vm.createContext({})
vm.runInContext(src, B)

const TILDE = 0x1001253, ACUTE = 0x1001251, GRAVE = 0x1001250, CIRC = 0x1001252, DIAER = 0x1001257
const SHIFT = 0x1000020, A = 0x41, C = 0x43, X = 0x58, SPACE = 0x20, BACKSPACE = 0x1000003

// Types a sequence of [key, text] events the way Find.qml does and returns { query, pending }.
function type(events) {
  let pending = 0, query = ""
  for (const [key, text] of events) {
    const r = B.composeDeadKey(pending, key, text)
    pending = r.pending
    if (r.consumed) query += r.insert
    else if (text.length === 1 && text.charCodeAt(0) >= 32) query += text   // the normal printable path
    else if (key === BACKSPACE) query = query.slice(0, -1)
  }
  return { query, pending }
}

let n = 0
function t(name, fn) { fn(); n++; console.log("ok - " + name) }

t("tilde + a = ã", () => assert.strictEqual(type([[TILDE, ""], [A, "a"]]).query, "ã"))
t("tilde + A = Ã", () => assert.strictEqual(type([[TILDE, ""], [A, "A"]]).query, "Ã"))
t("acute + c = ç", () => assert.strictEqual(type([[ACUTE, ""], [C, "c"]]).query, "ç"))
t("acute + C = Ç", () => assert.strictEqual(type([[ACUTE, ""], [C, "C"]]).query, "Ç"))
t("acute + e = é", () => assert.strictEqual(type([[ACUTE, ""], [0x45, "e"]]).query, "é"))
t("grave + a = à", () => assert.strictEqual(type([[GRAVE, ""], [A, "a"]]).query, "à"))
t("circumflex + o = ô", () => assert.strictEqual(type([[CIRC, ""], [0x4f, "o"]]).query, "ô"))
t("diaeresis + u = ü", () => assert.strictEqual(type([[DIAER, ""], [0x55, "u"]]).query, "ü"))

t("Shift before the dead key (shifted ~ / \") still composes", () => {
  assert.strictEqual(type([[SHIFT, ""], [TILDE, ""], [SHIFT, ""], [A, "A"]]).query, "Ã")
})
t("a bare modifier between dead key and letter keeps it armed", () => {
  const r = type([[TILDE, ""], [SHIFT, ""]])
  assert.strictEqual(r.pending, TILDE)
  assert.strictEqual(r.query, "")
})
t("dead key + space inserts the symbol itself", () => {
  assert.strictEqual(type([[TILDE, ""], [SPACE, " "]]).query, "~")
  assert.strictEqual(type([[ACUTE, ""], [SPACE, " "]]).query, "'")
})
t("dead key + letter without a combination inserts both", () => assert.strictEqual(type([[TILDE, ""], [X, "x"]]).query, "~x"))
t("Backspace right after a dead key cancels it and is handled normally", () => {
  const r = B.composeDeadKey(TILDE, BACKSPACE, "\b")
  assert.deepStrictEqual({ consumed: r.consumed, pending: r.pending, insert: r.insert }, { consumed: false, pending: 0, insert: "" })
})
t("Enter / Esc / Tab cancel the dead key too", () => {
  for (const ch of ["\r", "\u001b", "\t"]) assert.strictEqual(B.composeDeadKey(ACUTE, 0, ch).pending, 0)
})
t("a second dead key re-arms instead of inserting", () => {
  const r = B.composeDeadKey(TILDE, ACUTE, "")
  assert.deepStrictEqual({ consumed: r.consumed, pending: r.pending, insert: r.insert }, { consumed: true, pending: ACUTE, insert: "" })
})
t("plain typing is untouched", () => {
  const r = B.composeDeadKey(0, A, "a")
  assert.deepStrictEqual({ consumed: r.consumed, pending: r.pending, insert: r.insert }, { consumed: false, pending: 0, insert: "" })
  assert.strictEqual(type([[A, "a"], [C, "c"]]).query, "ac")
})
t("full word: visão", () => {
  const ev = [[0x56, "v"], [0x49, "i"], [0x53, "s"], [TILDE, ""], [A, "a"], [0x4f, "o"]]
  assert.strictEqual(type(ev).query, "visão")
})

console.log("\n" + n + " dead-key tests passed")
