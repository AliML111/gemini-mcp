const inheritedVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER', 'LOGNAME',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'XDG_RUNTIME_DIR',
]);

export function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([name, value]) => inheritedVariables.has(name.toUpperCase()) && !value.startsWith('()')));
}
