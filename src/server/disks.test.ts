import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mountOf, parseMountInfo, storageMounts } from './disks.ts';

const MOUNTINFO = `22 28 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw
23 28 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
24 28 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=8040000k
26 24 0:24 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs tmpfs rw
28 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
30 28 259:1 / /boot/efi rw,relatime shared:3 - vfat /dev/nvme0n1p1 rw,fmask=0077
31 28 0:26 / /tmp rw,nosuid,nodev shared:5 - tmpfs tmpfs rw
32 28 7:0 / /snap/core22/1380 ro,nodev,relatime shared:9 - squashfs /dev/loop0 ro
33 28 259:3 / /data rw,relatime shared:10 - ext4 /dev/nvme0n1p3 rw
34 28 259:3 /bags /home/robot/bags rw,relatime shared:10 - ext4 /dev/nvme0n1p3 rw
35 28 8:17 / /media/robot/USB\\040STICK ro,nosuid,nodev,relatime shared:11 - vfat /dev/sdb1 ro
36 28 0:50 / /mnt/share rw,relatime shared:12 master:1 - nfs4 server:/export rw,vers=4.2
37 28 0:27 / /run/user/1000 rw,nosuid,nodev shared:13 - tmpfs tmpfs rw
`;

test('the mount table is read, escapes and optional fields aside', () => {
  const mounts = parseMountInfo(MOUNTINFO);
  assert.equal(mounts.length, 13);
  assert.deepEqual(mounts[4], { device: '259:2', mount: '/', source: '/dev/nvme0n1p2', type: 'ext4', readOnly: false });
  assert.deepEqual(mounts[10], { device: '8:17', mount: '/media/robot/USB STICK', source: '/dev/sdb1', type: 'vfat', readOnly: true });
  assert.equal(mounts[11].type, 'nfs4');
  assert.deepEqual(parseMountInfo('garbage\n\n'), []);
});

test('the file systems shown hold files: no pseudo ones, nor RAM but /tmp, each device once', () => {
  assert.deepEqual(
    storageMounts(parseMountInfo(MOUNTINFO)).map((mount) => mount.mount),
    ['/', '/data', '/media/robot/USB STICK', '/mnt/share', '/tmp'],
  );
});

test('a path is on the deepest mount that holds it', () => {
  const mounts = parseMountInfo(MOUNTINFO);
  assert.equal(mountOf('/home/robot/bags/run_1', mounts)?.mount, '/home/robot/bags');
  assert.equal(mountOf('/home/robot/bagsy', mounts)?.mount, '/');
  assert.equal(mountOf('/data', mounts)?.mount, '/data');
  assert.equal(mountOf('/', mounts)?.mount, '/');
});
