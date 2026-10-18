import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interfaceType } from './ros.ts';

test('ROS interface types, completed with their kind', () => {
  assert.equal(interfaceType('std_msgs/msg/String', 'msg'), 'std_msgs/msg/String');
  assert.equal(interfaceType(' std_msgs/String ', 'msg'), 'std_msgs/msg/String');
  assert.equal(interfaceType('std_srvs/SetBool', 'srv'), 'std_srvs/srv/SetBool');
  assert.throws(() => interfaceType('std_srvs/srv/SetBool', 'msg'), /not a ROS message type/);
  assert.throws(() => interfaceType('../etc/passwd', 'msg'));
  assert.throws(() => interfaceType('String', 'msg'));
});
