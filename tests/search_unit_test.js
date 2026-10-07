#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const source = fs.readFileSync(path.join(__dirname, "..", "FindBackend.js"), "utf8")
  .replace(/^\.pragma library\s*/, "")
const backend = { console }
vm.createContext(backend)
vm.runInContext(source, backend)

let passed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
  passed++
}

// Following symlinks lets links such as Steam/Proton's dosdevices/z: -> /
// turn a home search into a scan of the whole filesystem.
for (let filter = 0; filter < backend.FILTERS.length; filter++) {
  for (const query of ["", "project notes"]) {
    for (const forDirs of [true, false]) {
      const argv = backend.buildArgv(query, filter, forDirs, "/home/test")
      assert(argv[0] === "fd", "search runs fd")
      assert(!argv.includes("--follow"), `filter ${filter} never follows symlinks`)
    }
  }
}

console.log(`${passed} search backend tests passed`)
