// What the nodes of BT.CPP's behavior trees are: their kinds, and their
// models (the TreeNodesModel of their XML, which Groot reads): their ports.
// BT.CPP's own nodes, and how a tree's file names the others' kinds. For the
// behavior tree widgets, the inspector (src/server/behavior_tree_file.ts)
// and the editor.

import type { BtNodeKind } from './protocol.ts';

export interface BtPortModel {
  name: string;
  direction: 'input' | 'output' | 'inout';
  // As BT.CPP names it: double, std::string, nav_msgs::msg::Path...
  type: string;
  default: string | null;
  description: string;
}

export interface BtNodeModel {
  // Its registration ID: the XML tag of its nodes
  id: string;
  kind: BtNodeKind;
  ports: BtPortModel[];
  description: string;
}

// The forms naming their type with an ID attribute: <Action ID="ComputePathToPose"/>
export const EXPLICIT: Record<string, BtNodeKind> = {
  Action: 'action',
  Condition: 'condition',
  Control: 'control',
  Decorator: 'decorator',
  SubTree: 'subtree',
  // BT.CPP 3's
  SubTreePlus: 'subtree',
};

// Those of TreeNodesModel, by their tag
const MODEL_KINDS: Record<string, BtNodeKind> = {
  Action: 'action',
  Condition: 'condition',
  Control: 'control',
  Decorator: 'decorator',
  SubTree: 'subtree',
};

const DIRECTIONS: Record<string, BtPortModel['direction']> = {
  input_port: 'input',
  output_port: 'output',
  inout_port: 'inout',
};

// An element of a TreeNodesModel, and the text in it: the descriptions
export interface ModelElement {
  name: string;
  attributes: Record<string, string>;
  children: ModelElement[];
  text: string;
}

// The models of the TreeNodesModel elements among the children of <root>
export function readModels(root: ModelElement): BtNodeModel[] {
  const models: BtNodeModel[] = [];
  for (const model of root.children.filter((child) => child.name === 'TreeNodesModel')) {
    for (const node of model.children) {
      const kind = MODEL_KINDS[node.name];
      if (!kind || !node.attributes.ID) {
        continue;
      }
      const ports: BtPortModel[] = [];
      for (const port of node.children) {
        const direction = DIRECTIONS[port.name];
        if (direction && port.attributes.name) {
          ports.push({
            name: port.attributes.name,
            direction,
            type: port.attributes.type ?? '',
            default: port.attributes.default ?? null,
            description: (port.attributes.description ?? port.text).trim(),
          });
        }
      }
      models.push({ id: node.attributes.ID, kind, ports, description: (node.attributes.description ?? '').trim() });
    }
  }
  return models;
}

const port = (
  name: string,
  type: string,
  description: string,
  defaultValue: string | null = null,
  direction: BtPortModel['direction'] = 'input',
): BtPortModel => ({ name, direction, type, default: defaultValue, description });

// BT.CPP's own nodes, of its format 3 and 4 (ROS 2 Humble's and Jazzy's on)
// or of one of them
interface Builtin extends BtNodeModel {
  format?: 3 | 4;
}

const builtin = (id: string, kind: BtNodeKind, description: string, ports: BtPortModel[] = [], format?: 3 | 4): Builtin => ({
  id,
  kind,
  ports,
  description,
  format,
});

const switchPorts = (cases: number) => [
  port('variable', 'std::string', 'The value compared to the cases'),
  ...Array.from({ length: cases }, (_, i) => port(`case_${i + 1}`, 'std::string', `Ticks child ${i + 1} if equal`)),
];

const loop = (type: string, cppType: string) =>
  builtin(
    `Loop${type}`,
    'decorator',
    'Ticks its child once for each value of a queue, popped from it',
    [
      port('queue', `std::shared_ptr<std::deque<${cppType}>>`, 'The queue of values'),
      port('if_empty', 'NodeStatus', 'What it returns when the queue is empty', 'SUCCESS'),
      port('value', cppType, 'The value popped', null, 'output'),
    ],
    4,
  );

const BUILTINS: Builtin[] = [
  builtin('Sequence', 'control', 'Ticks its children in order while they succeed; restarts from the first after a failure'),
  builtin('ReactiveSequence', 'control', 'As Sequence, but ticks again from the first child each time: conditions are checked while an action runs'),
  builtin('SequenceWithMemory', 'control', 'As Sequence, but resumes from the child that failed', [], 4),
  builtin('SequenceStar', 'control', 'As Sequence, but resumes from the child that failed', [], 3),
  builtin('Fallback', 'control', 'Ticks its children in order until one succeeds'),
  builtin('ReactiveFallback', 'control', 'As Fallback, but ticks again from the first child each time'),
  builtin(
    'Parallel',
    'control',
    'Ticks all its children at once, until enough succeed or fail',
    [
      port('success_count', 'int', 'Successes needed to succeed; -1: all', '-1'),
      port('failure_count', 'int', 'Failures needed to fail; -1: all', '1'),
    ],
    4,
  ),
  builtin(
    'Parallel',
    'control',
    'Ticks all its children at once, until enough succeed or fail',
    [
      port('success_threshold', 'int', 'Successes needed to succeed; -1: all'),
      port('failure_threshold', 'int', 'Failures needed to fail; -1: all', '1'),
    ],
    3,
  ),
  builtin(
    'ParallelAll',
    'control',
    'Ticks all its children at once until they are all done',
    [port('max_failures', 'int', 'Failures that make it fail; -1: all', '1')],
    4,
  ),
  builtin('IfThenElse', 'control', 'Ticks its second child if its first succeeds, else its third'),
  builtin('WhileDoElse', 'control', 'Reactive: ticks its second child while its first succeeds, else its third'),
  ...[2, 3, 4, 5, 6].map((cases) =>
    builtin(`Switch${cases}`, 'control', `Ticks the child of the case equal to the variable, else the last (default) of its ${cases + 1}`, switchPorts(cases)),
  ),
  builtin('Inverter', 'decorator', 'Succeeds when its child fails, and fails when it succeeds'),
  builtin('ForceSuccess', 'decorator', 'Succeeds when its child is done, however it ends'),
  builtin('ForceFailure', 'decorator', 'Fails when its child is done, however it ends'),
  builtin('Repeat', 'decorator', 'Ticks its child again each time it succeeds, num_cycles times', [
    port('num_cycles', 'int', 'Times to repeat; -1: forever'),
  ]),
  builtin('RetryUntilSuccessful', 'decorator', 'Ticks its child again each time it fails, up to num_attempts times', [
    port('num_attempts', 'int', 'Attempts; -1: forever'),
  ]),
  builtin('KeepRunningUntilFailure', 'decorator', 'Ticks its child again each time it succeeds, until it fails'),
  builtin('Delay', 'decorator', 'Ticks its child after a delay', [port('delay_msec', 'unsigned int', 'The delay, ms')]),
  builtin('Timeout', 'decorator', 'Halts its child, and fails, if it runs longer than msec', [port('msec', 'unsigned int', 'The time allowed, ms')]),
  builtin('RunOnce', 'decorator', 'Ticks its child once only; then returns what it returned, or skips', [
    port('then_skip', 'bool', 'Skips once done, else returns its result again', 'true'),
  ], 4),
  builtin('Precondition', 'decorator', 'Ticks its child if the script is true, else returns else', [
    port('if', 'std::string', 'The condition, a script'),
    port('else', 'NodeStatus', 'What it returns if the condition is false', 'FAILURE'),
  ], 4),
  builtin('SkipUnlessUpdated', 'decorator', 'Skips its child unless the blackboard entry changed since its last tick', [
    port('entry', 'std::string', 'The blackboard entry'),
  ], 4),
  builtin('WaitValueUpdate', 'decorator', 'Runs until the blackboard entry changes, then ticks its child', [
    port('entry', 'std::string', 'The blackboard entry'),
  ], 4),
  loop('Int', 'int'),
  loop('Double', 'double'),
  loop('String', 'std::string'),
  loop('Bool', 'bool'),
  ...['Int', 'Double', 'String'].map((type) =>
    builtin(`BlackboardCheck${type}`, 'decorator', 'Ticks its child if the two values are equal, else returns return_on_mismatch', [
      port('value_A', 'std::string', 'A value, or a blackboard entry'),
      port('value_B', 'std::string', 'A value, or a blackboard entry'),
      port('return_on_mismatch', 'NodeStatus', 'What it returns if they differ', 'FAILURE'),
    ], 3),
  ),
  builtin('AlwaysSuccess', 'action', 'Succeeds'),
  builtin('AlwaysFailure', 'action', 'Fails'),
  builtin('Script', 'action', 'Runs a script on the blackboard', [port('code', 'std::string', 'The script, e.g. counter += 1')], 4),
  builtin('SetBlackboard', 'action', 'Writes a value into a blackboard entry', [
    port('value', 'std::string', 'The value, or another entry'),
    port('output_key', 'std::string', 'The entry written', null, 'inout'),
  ]),
  builtin('UnsetBlackboard', 'action', 'Removes a blackboard entry', [port('key', 'std::string', 'The entry')], 4),
  builtin('Sleep', 'action', 'Runs for a while, then succeeds', [port('msec', 'unsigned int', 'How long, ms')], 4),
  builtin('ScriptCondition', 'condition', 'Succeeds if the script is true', [port('code', 'std::string', 'The condition, a script')], 4),
  builtin('WasEntryUpdated', 'condition', 'Succeeds if the blackboard entry changed since its last tick', [
    port('entry', 'std::string', 'The blackboard entry'),
  ], 4),
];

// BT.CPP's own nodes in a format: 4 for files saying BTCPP_format="4", else 3
export function builtinModels(format: 3 | 4): BtNodeModel[] {
  return BUILTINS.filter((model) => !model.format || model.format === format).map(({ format: _, ...model }) => model);
}

// BT.CPP's own nodes, 3 and 4, and Nav2's main ones, in case its models
// (nav2_tree_nodes.xml) are not installed
export const KNOWN_KINDS = new Map<string, BtNodeKind>([
  ...BUILTINS.map((model) => [model.id, model.kind] as const),
  ...[
    'Sequence', 'SequenceStar', 'SequenceWithMemory', 'ReactiveSequence', 'Fallback', 'ReactiveFallback',
    'Parallel', 'ParallelAll', 'IfThenElse', 'WhileDoElse', 'ManualSelector', 'TryCatch', 'AsyncSequence', 'AsyncFallback',
    'PipelineSequence', 'RecoveryNode', 'RoundRobin', 'NonblockingSequence', 'PersistentSequence',
    'PauseResumeController',
  ].map((type) => [type, 'control'] as const),
  ...[
    'RetryUntilSuccesful',
    'RateController', 'DistanceController', 'SpeedController', 'GoalUpdater', 'PathLongerOnApproach',
    'SingleTrigger', 'GoalUpdatedController',
  ].map((type) => [type, 'decorator'] as const),
  ...[
    'GoalReached', 'GoalUpdated', 'GloballyUpdatedGoal',
    'InitialPoseReceived', 'IsStuck', 'TransformAvailable', 'DistanceTraveled', 'TimeExpired',
    'IsBatteryLow', 'IsBatteryCharging', 'IsPathValid', 'PathExpiringTimer', 'AreErrorCodesPresent',
    'WouldAControllerRecoveryHelp', 'WouldAPlannerRecoveryHelp', 'WouldASmootherRecoveryHelp',
  ].map((type) => [type, 'condition'] as const),
]);

const CONDITION_NAME = /^(Is|Are|Has|Was|Would|Can|Check)[A-Z]|Condition/;

// A node's kind, when no model says: by its children, and its name
export function guessKind(type: string, children: number): BtNodeKind {
  const known = KNOWN_KINDS.get(type);
  if (known) {
    return known;
  }
  if (children > 1) {
    return 'control';
  }
  if (children === 1) {
    return 'decorator';
  }
  return CONDITION_NAME.test(type) ? 'condition' : 'action';
}
