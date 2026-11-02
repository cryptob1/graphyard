/** Run after the mounts are established, before any agent code. Linux Landlock ABI 9
 * mediates pathname socket resolution, including sockets published after launch;
 * ABI 6's IPC scope also denies connections to host abstract sockets. Mounts alone
 * cannot enforce either boundary. Python's isolated mode avoids host startup hooks.
 */
const restrictSockets = String.raw`
import ctypes, json, os, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
def checked(result):
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result
class Ruleset(ctypes.Structure):
    _fields_ = [('fs', ctypes.c_uint64), ('net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]
try:
    if checked(libc.syscall(444, 0, 0, 1)) < 9:
        raise RuntimeError('Linux Landlock ABI 9 or newer is required')
    resolve_unix = 1 << 16
    rules = Ruleset(resolve_unix, 0, 1)
    rules_fd = checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    for path in json.loads(sys.argv[1]):
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = ctypes.create_string_buffer(struct.pack('=Qi', resolve_unix, fd))
            checked(libc.syscall(445, rules_fd, 1, ctypes.byref(rule), 0))
        finally:
            os.close(fd)
    checked(libc.prctl(38, 1, 0, 0, 0))
    checked(libc.syscall(446, rules_fd, 0))
    os.close(rules_fd)
except Exception as error:
    sys.exit('Graphyard socket confinement failed; no command started: ' + str(error))
command = sys.argv[2:]
if command[0] == '--':
    command = command[1:]
os.execvp(command[0], command)
`;

export function socketConfinementWords(writable: readonly string[], keyringSockets: readonly string[] = []): string[] {
  return ['/usr/bin/python3', '-I', '-S', '-c', restrictSockets,
    JSON.stringify([...new Set(['/tmp', '/var/tmp', ...writable, ...keyringSockets])]), '--'];
}
