import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { expectedFiles, missingCodeHint, missingPackages } from './message_code.ts';

test('the files rclnodejs makes of a package’s interfaces, from its ament index entry', () => {
  const index = ['action/Dock.action', 'action/Dock.idl', 'msg/State.msg', 'msg/State.idl', 'msg-common/Extra.msg', 'srv/Set.srv', ''].join('\n');
  assert.deepEqual(expectedFiles('dock_msgs', index), [
    'dock_msgs__action__Dock.js',
    'dock_msgs__msg__State.js',
    'dock_msgs__msg__Extra.js',
    'dock_msgs__srv__Set.js',
  ]);
  assert.deepEqual(expectedFiles('dock_msgs', index, (name) => name === 'State'), [
    'dock_msgs__action__Dock.js',
    'dock_msgs__msg__Extra.js',
    'dock_msgs__srv__Set.js',
  ]);
});

async function prefix(root: string, name: string, packages: Record<string, string[]>): Promise<string> {
  const dir = path.join(root, name);
  const index = path.join(dir, 'share', 'ament_index', 'resource_index', 'rosidl_interfaces');
  await fs.mkdir(index, { recursive: true });
  for (const [pkg, files] of Object.entries(packages)) {
    await fs.writeFile(path.join(index, pkg), files.join('\n') + '\n');
  }
  return dir;
}

test('the packages sourced whose code is missing, or misses interfaces', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tassello-test-'));
  try {
    const ros = await prefix(root, 'ros', { std_msgs: ['msg/String.msg'], old_msgs: ['msg/A.msg'] });
    // A robot's own, over ROS's: its old_msgs has a new interface
    const robot = await prefix(root, 'robot', { dock_msgs: ['action/Dock.action'], old_msgs: ['msg/A.msg', 'msg/B.msg'] });
    const generated = path.join(root, 'generated');
    await fs.mkdir(path.join(generated, 'std_msgs'), { recursive: true });
    await fs.writeFile(path.join(generated, 'std_msgs', 'std_msgs__msg__String.js'), '');
    await fs.mkdir(path.join(generated, 'old_msgs'));
    await fs.writeFile(path.join(generated, 'old_msgs', 'old_msgs__msg__A.js'), '');

    assert.deepEqual(await missingPackages([robot, ros, path.join(root, 'none')], generated), [
      { name: 'dock_msgs', prefix: robot },
      { name: 'old_msgs', prefix: robot },
    ]);
    // ROS's own old_msgs alone is complete
    assert.deepEqual(await missingPackages([ros], generated), []);
    // rclnodejs's blocklist: never made
    assert.deepEqual(await missingPackages([robot], generated, [{ pkgName: 'dock_.*' }, { pkgName: 'old_msgs', interfaceName: 'B' }]), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('what to do when rclnodejs has no code of an interface', () => {
  assert.match(
    missingCodeHint('The message required does not exist: dock_msgs, action, Dock_FeedbackMessage at /x/generated/'),
    /restart it with their workspace sourced, or run npx generate-ros-messages in /,
  );
  assert.equal(missingCodeHint('Something else'), 'Something else');
});
