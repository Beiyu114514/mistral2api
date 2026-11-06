// The package's OpenCode 1.x plugins, as OpenCode 1.x and magpie's host
// load them: its plugin functions and nothing else (1.x refuses a package
// whose exports include anything but plugins). OpenCode 2.x support is
// not wired yet.
export { VibePlugin } from "./index.mjs"
