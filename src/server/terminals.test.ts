import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TERMINAL_WINDOW, type TerminalExit, type TerminalOutput } from '../shared/protocol.ts';
import { Terminals, type TerminalRequest, type TerminalWatcher } from './terminals.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// What a page got: its output, as the page writes it
class Page implements TerminalWatcher {
  outputs: Omit<TerminalOutput, 'type' | 'id'>[] = [];
  exits: Omit<TerminalExit, 'type' | 'id'>[] = [];
  statuses: string[] = [];
  text = '';

  onOutput = (output: Omit<TerminalOutput, 'type' | 'id'>) => {
    this.outputs.push(output);
    this.text = output.reset ? output.data : this.text + output.data;
  };

  onExit = (exit: Omit<TerminalExit, 'type' | 'id'>) => {
    this.exits.push(exit);
  };

  onStatus = (state: string, message: string) => {
    this.statuses.push(message ? `${state}: ${message}` : state);
  };

  get last() {
    return this.outputs.at(-1)!;
  }
}

function request(terminal: string, command: string, more: Partial<TerminalRequest> = {}): TerminalRequest {
  return { terminal, command, folder: '/tmp', cols: 100, rows: 30, started: null, offset: null, ...more };
}

async function until(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a terminal runs its command on a pseudo-terminal of the page’s size', async () => {
  const terminals = new Terminals(logger);
  try {
    const page = new Page();
    const view = terminals.open(request('t1', 'stty size; tty; read line; echo "got:$line"; exit 3'), page);
    await until('the size', () => page.text.includes('30 100'));
    assert.match(page.text, /\/dev\/pts\/\d+/);
    assert.deepEqual(page.statuses, ['streaming']);
    view.input('abc\r');
    await until('the exit', () => page.exits.length > 0);
    assert.match(page.text, /got:abc/);
    assert.deepEqual(page.exits, [{ started: page.last.started, exitCode: 3 }]);
  } finally {
    terminals.stopAll();
  }
});

test('a page that comes back gets what it missed, a new page the screen', async () => {
  const terminals = new Terminals(logger);
  try {
    const command = 'read a; echo "one:$a"; read b; echo "two:$b"; sleep 30';
    const first = new Page();
    const firstView = terminals.open(request('t2', command), first);
    firstView.input('x\r');
    await until('one', () => first.text.includes('one:x'));
    const { started, offset } = first.last;
    firstView.close();

    // Another page (or the same, reloaded): the screen
    const second = new Page();
    const secondView = terminals.open(request('t2', command), second);
    assert.equal(second.outputs[0].reset, true);
    assert.equal(second.outputs[0].started, started);
    assert.match(second.text, /one:x/);
    secondView.input('y\r');
    await until('two', () => second.text.includes('two:y'));
    secondView.close();

    // The first page, reconnected: what it missed only
    const back = new Page();
    terminals.open(request('t2', command, { started, offset }), back);
    await until('what it missed', () => back.text.includes('two:y'));
    assert.ok(back.outputs.every((output) => !output.reset));
    assert.ok(!back.text.includes('one:x'));
  } finally {
    terminals.stopAll();
  }
});

test('a restart runs the program anew; so does a change of command', async () => {
  const terminals = new Terminals(logger);
  try {
    const page = new Page();
    const view = terminals.open(request('t3', 'echo first; sleep 30'), page);
    await until('first', () => page.text.includes('first'));
    const { started } = page.last;
    view.restart();
    assert.equal(page.last.reset, false);
    assert.equal(page.last.offset, 0);
    assert.ok(page.last.started > started);
    await until('first again', () => page.outputs.filter((o) => o.data.includes('first')).length === 2);
    view.close();

    const changed = new Page();
    const { started: shown, offset } = page.last;
    terminals.open(request('t3', 'echo second; sleep 30', { started: shown, offset }), changed);
    await until('second', () => changed.text.includes('second'));
    assert.ok(changed.outputs[0].started > page.last.started);
  } finally {
    terminals.stopAll();
  }
});

test('a page that writes nothing holds the output back, not the program, and then gets the screen', async () => {
  const terminals = new Terminals(logger);
  try {
    const page = new Page();
    const view = terminals.open(request('t4', 'yes | head -c 3000000; echo; echo end-of-flood; sleep 30'), page);
    // A page that does not write what it gets, e.g. a hidden one
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sent = page.outputs.reduce((sum, output) => sum + output.data.length, 0);
    assert.ok(sent <= TERMINAL_WINDOW, `${sent} characters sent`);
    // The program went on: the screen has its end
    view.ack(page.last.started, page.last.offset);
    await until('the screen', () => page.last.reset && page.text.includes('end-of-flood'));
  } finally {
    terminals.stopAll();
  }
});

test('a folder that cannot be is said, and the home folder used', async () => {
  const terminals = new Terminals(logger);
  try {
    const page = new Page();
    terminals.open(request('t5', 'pwd; sleep 30', { folder: '~/no/such/folder' }), page);
    await until('pwd', () => /starting in \/\S+/.test(page.text) && page.text.split('\n').length > 2);
    assert.match(page.text, /cannot start in ~\/no\/such\/folder \(not found\)/);
  } finally {
    terminals.stopAll();
  }
});
