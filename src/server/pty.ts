// Pseudo-terminals for the terminal widgets, without a native module: Node
// cannot open one, the Python 3 that ROS 2 ships with can. A small bridge
// (BRIDGE) opens it, starts the program on it as the session leader, and
// relays its standard input to the terminal and the terminal's output to its
// standard output; lines on fd 3 resize it. When the bridge goes, the
// terminal hangs up, as when a terminal window is closed.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// argv: columns, rows, then the program and its arguments. Exits with the
// program's exit code, 128 + the signal that killed it.
const BRIDGE = `
import fcntl, os, select, signal, struct, sys, termios

CONTROL = 3

def size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def send(data):
    while data:
        data = data[os.write(1, data):]

cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
master, slave = os.openpty()
size(slave, cols, rows)
attrs = termios.tcgetattr(slave)
attrs[0] |= getattr(termios, 'IUTF8', 0o40000)
termios.tcsetattr(slave, termios.TCSANOW, attrs)
pid = os.fork()
if pid == 0:
    try:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        for fd in (master, slave, CONTROL):
            os.close(fd)
        # Python ignores them, and what it ignores stays ignored after exec
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
        os.execvp(argv[0], argv)
    except BaseException as e:
        os.write(2, ('tassello: cannot run %s: %s\\n' % (argv[0], e)).encode())
    os._exit(127)

os.close(slave)
os.set_blocking(master, False)
inputs = [master, 0, CONTROL]
pending = b''
control = b''
status = None
while status is None:
    readable, writable, _ = select.select(inputs, [master] if pending else [], [], 0.5)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            break
        if data:
            send(data)
    if writable:
        try:
            pending = pending[os.write(master, pending):]
        except BlockingIOError:
            pass
    if 0 in readable:
        data = os.read(0, 65536)
        if not data:
            sys.exit(0)
        pending += data
    if CONTROL in readable:
        data = os.read(CONTROL, 4096)
        if not data:
            inputs.remove(CONTROL)
        control += data
        while b'\\n' in control:
            line, control = control.split(b'\\n', 1)
            size(master, *map(int, line.split()))
    # Gone, while what it left in the background keeps the terminal open:
    # the rest of its output, then done
    done, result = os.waitpid(pid, os.WNOHANG)
    if done:
        status = result
        try:
            data = os.read(master, 65536)
            while data:
                send(data)
                data = os.read(master, 65536)
        except OSError:
            pass

if status is None:
    status = os.waitpid(pid, 0)[1]
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

export interface PtyOptions {
  // The program, found in PATH, and its arguments
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

interface PtyEvents {
  // UTF-8 decoded, whole characters
  data: [string];
  // The program's exit code, 128 + the signal that killed it; null if the
  // bridge itself was killed (hangUp)
  exit: [number | null];
  // The bridge could not start: no python3
  error: [Error];
}

export class Pty extends EventEmitter<PtyEvents> {
  private readonly child: ChildProcess;
  private exited = false;

  constructor(options: PtyOptions) {
    super();
    // -I: none of the robot's PYTHONPATH and the like, which the program
    // still gets
    this.child = spawn(
      'python3',
      ['-I', '-c', BRIDGE, String(options.cols), String(options.rows), options.file, ...options.args],
      { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] },
    );
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => this.emit('data', chunk));
    // Writes after the program is gone
    this.child.stdin?.on('error', () => {});
    this.child.stdio[3]?.on('error', () => {});
    this.child.on('error', (e) => {
      this.exited = true;
      this.emit('error', e);
    });
    // 'close': after the last of its output
    this.child.on('close', (code) => {
      if (!this.exited) {
        this.exited = true;
        this.emit('exit', code);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  write(data: string): void {
    if (!this.exited) {
      this.child.stdin?.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) {
      (this.child.stdio[3] as NodeJS.WritableStream | null)?.write(`${cols} ${rows}\n`);
    }
  }

  // Backpressure: the program blocks on its output while paused
  pause(): void {
    this.child.stdout?.pause();
  }

  resume(): void {
    this.child.stdout?.resume();
  }

  // As a terminal window closed: the program gets SIGHUP
  hangUp(): void {
    if (!this.exited) {
      this.child.kill('SIGHUP');
    }
  }
}
