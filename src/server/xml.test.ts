import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseXml } from './xml.ts';

test('elements and attributes, the rest skipped', () => {
  const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- A <tree> of nodes -->
<!DOCTYPE root [ <!ENTITY x "y"> ]>
<root main_tree_to_execute='Main'>
  <BehaviorTree ID="Main">
    <Sequence name="a &amp; b &lt;c&gt; &#65;&#x42;">
      text <![CDATA[ <ignored/> ]]>
      <Wait wait_duration="5"
            name="wait"/>
    </Sequence>
  </BehaviorTree>
</root>`);
  assert.equal(root.name, 'root');
  assert.deepEqual(root.attributes, { main_tree_to_execute: 'Main' });
  const sequence = root.children[0].children[0];
  assert.equal(sequence.name, 'Sequence');
  assert.equal(sequence.attributes.name, 'a & b <c> AB');
  assert.equal(sequence.line, 6);
  assert.deepEqual(sequence.children, [{ name: 'Wait', attributes: { wait_duration: '5', name: 'wait' }, children: [], line: 8 }]);
});

test('malformed documents name their line', () => {
  assert.throws(() => parseXml('<root>\n  <Sequence>\n</root>'), /Line 3: <\/root> closes <Sequence> of line 2/);
  assert.throws(() => parseXml('<root>\n<a/>'), /Line 1: <root> not closed/);
  assert.throws(() => parseXml('<root/><other/>'), /after the root element/);
  assert.throws(() => parseXml('<root a=1/>'), /Line 1: Malformed tag/);
  assert.throws(() => parseXml('<root><!-- never closed </root>'), /Comment not closed/);
  assert.throws(() => parseXml('just text'), /No XML element/);
});
