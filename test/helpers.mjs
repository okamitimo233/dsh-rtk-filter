/**
 * Shared test fixtures. Not collected as a test file (`*.test.mjs` only).
 */

/** A fake `rtk` executable for manager tests. */
export function rtkScript(version = '1.2.0') {
  return `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' 'rtk ${version}'; exit 0 ;;
  rewrite) printf '%s' 'rtk git status'; exit 3 ;;
  *) exit 0 ;;
esac
`
}
