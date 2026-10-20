import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { imageType, isUploadName, listDirectory, resolveImagePath, saveUpload } from './files.ts';
import { HttpError } from './panels.ts';

test('only absolute or ~ paths to images resolve', () => {
  assert.equal(resolveImagePath('~/maps/house.PNG', '/home/robot'), '/home/robot/maps/house.PNG');
  assert.equal(resolveImagePath('/a/../b/c.jpg'), '/b/c.jpg');
  assert.throws(() => resolveImagePath('maps/house.png'), HttpError);
  assert.throws(() => resolveImagePath('/home/robot/.ssh/id_ed25519'), HttpError);
  assert.throws(() => resolveImagePath('/etc/passwd'), HttpError);
});

test('images are recognized by their content', () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageType(Buffer.from('GIF89a')), 'gif');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
  assert.equal(imageType(Buffer.from('#!/bin/bash\necho')), null);
  assert.equal(imageType(Buffer.from('<html><svg></svg></html>')), null);
});

test('directories list their folders and images, hidden ones left out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dieletrikbot-files-'));
  try {
    await mkdir(path.join(root, 'maps'));
    await mkdir(path.join(root, '.cache'));
    await writeFile(path.join(root, 'b.png'), '');
    await writeFile(path.join(root, 'a.JPG'), '');
    await writeFile(path.join(root, 'notes.txt'), '');
    await writeFile(path.join(root, 'tree.xml'), '');
    const listing = await listDirectory(root);
    assert.equal(listing.dir, root);
    assert.equal(listing.parent, path.dirname(root));
    assert.deepEqual(listing.entries, [
      { name: 'maps', kind: 'dir' },
      { name: 'a.JPG', kind: 'image' },
      { name: 'b.png', kind: 'image' },
    ]);
    assert.deepEqual((await listDirectory(root, 'behavior-tree')).entries, [
      { name: 'maps', kind: 'dir' },
      { name: 'tree.xml', kind: 'behavior-tree' },
    ]);
    await mkdir(path.join(root, 'run_1'));
    await writeFile(path.join(root, 'run_1', 'metadata.yaml'), '');
    await writeFile(path.join(root, 'run_2.mcap'), '');
    assert.deepEqual((await listDirectory(root, 'bag')).entries, [
      { name: 'maps', kind: 'dir' },
      { name: 'run_1', kind: 'bag' },
      { name: 'run_2.mcap', kind: 'bag' },
    ]);
    assert.deepEqual((await listDirectory(root, 'folder')).entries, [
      { name: 'maps', kind: 'dir' },
      { name: 'run_1', kind: 'dir' },
    ]);
    assert.equal((await listDirectory('/')).parent, null);
    await assert.rejects(listDirectory(path.join(root, 'missing')), HttpError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uploads are named after their content, images and behavior trees only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dieletrikbot-uploads-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const name = await saveUpload(path.join(root, 'images'), png);
    assert.ok(isUploadName(name), name);
    assert.equal(await saveUpload(path.join(root, 'images'), png), name);
    assert.deepEqual(await readdir(path.join(root, 'images')), [name]);
    await assert.rejects(saveUpload(path.join(root, 'images'), Buffer.from('not an image')), HttpError);
    const tree = Buffer.from('<?xml version="1.0"?>\n<!-- Nav2 -->\n<root main_tree_to_execute="MainTree"/>');
    assert.match(await saveUpload(path.join(root, 'images'), tree), /^[0-9a-f]{16}\.xml$/);
    await assert.rejects(saveUpload(path.join(root, 'images'), Buffer.from('<robot name="r"/>')), HttpError);
    assert.equal(isUploadName('../panels/x.json'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
