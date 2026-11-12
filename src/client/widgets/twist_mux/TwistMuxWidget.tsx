// The Twist Mux inspector: a twist_mux node as the multiplexer it is (see
// MuxDiagram.tsx), live. Its inputs, the highest priority first, with their
// topics, timeouts and rates; its locks, locked or free, and the priority
// below which they mask the inputs; the input that has the priority, joined
// to the output by the mux's arm; the output, its rate, its latest command
// and where it came from; and the messages moving along the wires, those that
// pass on to the output, the others stopping at the mux. What twist_mux does
// is worked out on the robot, as twist_mux works it out, and checked against
// its output (see src/server/twist_mux.ts).

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { TwistMuxUpdate } from '../../../shared/protocol.ts';
import { connection, useConnectionStatus } from '../../connection.ts';
import { TwistMuxIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { isHiddenNode } from '../parameters/model.ts';
import { RelayBar, useMuxControls } from './MuxControls.tsx';
import { MuxDiagram } from './MuxDiagram.tsx';
import { muxCandidates, summary, typesText, typesTitle } from './model.ts';

interface TwistMuxConfig {
  node: string;
  animate: boolean;
  controls: boolean;
}

// When nothing else does, the ages of the messages shown
const TICK_MS = 1000;
const DIAGNOSTIC_LEVELS = ['OK', 'Warning', 'Error', 'Stale'];

// The graph's nodes, its twist_muxes first; null until it comes
function useNodes(enabled: boolean): string[] | null {
  const [nodes, setNodes] = useState<string[] | null>(null);
  useEffect(() => (enabled ? connection.subscribeGraph((graph) => setNodes(graph.nodes)) : undefined), [enabled]);
  return nodes;
}

// Of the node property: the graph's twist_muxes, then its other nodes (but
// the hidden ones, as ros2 node list)
function useNodeOptions(): { value: string; label: string }[] {
  const nodes = (useNodes(true) ?? []).filter((node) => !isHiddenNode(node));
  const muxes = muxCandidates(nodes);
  return [...muxes, ...nodes.filter((node) => !muxes.includes(node))].map((node) => ({ value: node, label: node }));
}

const reducedMotion = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      reducedMotion?.addEventListener('change', listener);
      return () => reducedMotion?.removeEventListener('change', listener);
    },
    () => reducedMotion?.matches ?? false,
  );
}

function useTicker(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

function TwistMuxWidget({ config, updateConfig }: WidgetProps<TwistMuxConfig>) {
  const configured = config.node.trim();
  const nodes = useNodes(!configured);
  const candidates = nodes ? muxCandidates(nodes) : [];
  // Auto: the graph's twist_mux; until there is one, the usual name, waited for
  const node = configured || candidates[0] || '/twist_mux';
  const [state, setState] = useState<TwistMuxUpdate | null>(null);
  useEffect(() => {
    setState(null);
    return connection.subscribeTwistMux(node, setState);
  }, [node]);
  const connected = useConnectionStatus() === 'open';
  const controls = useMuxControls(node);
  // Missing in panels saved before it: on
  const showControls = config.controls !== false;
  const reduced = usePrefersReducedMotion();
  useTicker(TICK_MS);
  const now = connection.serverNow();

  let body;
  if (!state) {
    body = <p className="mux-message">{connected ? 'Connecting…' : 'Not connected to the robot'}</p>;
  } else if (!state.configFrom) {
    body = (
      <p className={`mux-message${state.found ? '' : ' error'}`}>
        {state.found
          ? state.problems[0] ?? `Reading the configuration of ${state.node}…`
          : `${state.node} is not in the ROS graph: is twist_mux running? Its node is chosen in edit mode.`}
      </p>
    );
  } else {
    body = (
      <MuxDiagram
        state={state}
        now={now}
        animate={config.animate && !reduced}
        controls={showControls && state.found ? controls : null}
      />
    );
  }
  const line = state?.configFrom ? summary(state, now) : null;
  // Of the node running
  const diagnostics = state?.found ? state.diagnostics : null;
  const level = diagnostics ? (diagnostics.stale ? 3 : Math.min(3, Math.max(0, diagnostics.level))) : null;

  return (
    <div className="mux">
      <div className="mux-toolbar">
        <TwistMuxIcon width={16} height={16} className="mux-toolbar-icon" />
        {!configured && candidates.length > 1 ? (
          <select
            className="mux-node-select"
            value={node}
            aria-label="twist_mux node"
            onChange={(e) => updateConfig({ node: e.target.value })}
          >
            {candidates.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        ) : (
          <span className="mux-node" title={configured ? node : `${node}: the graph’s twist_mux`}>
            {node}
          </span>
        )}
        {state && (state.inputType || state.outputType) && (
          <span className="mux-pill" title={typesTitle(state.inputType, state.outputType)}>
            {typesText(state.inputType, state.outputType)}
          </span>
        )}
        <span className="mux-spacer" />
        {diagnostics && level !== null && (
          <span
            className={`mux-diag level-${level}`}
            title={`twist_mux’s diagnostics: ${DIAGNOSTIC_LEVELS[level]}${diagnostics.message ? `, ${diagnostics.message}` : ''}${diagnostics.priority !== null ? `. Current priority ${diagnostics.priority}` : ''}`}
          >
            <span className="mux-diag-dot" aria-hidden="true" />
            {DIAGNOSTIC_LEVELS[level]}
          </span>
        )}
      </div>
      {showControls && state?.found && state.relay && <RelayBar relay={state.relay} controls={controls} />}
      <div className="mux-body">{body}</div>
      {line && (
        <div className={`mux-status ${line.tone}`} title={line.text}>
          <span className="mux-status-dot" aria-hidden="true" />
          <span className="mux-status-text">{line.text}</span>
        </div>
      )}
    </div>
  );
}

export const twistMuxWidget = defineWidget<TwistMuxConfig>({
  type: 'twist-mux',
  name: 'Twist Mux',
  description:
    'A twist_mux as a multiplexer: which input passes, its locks, and the messages flowing through it. Locks its locks, and switches its joystick relay’s priority and turbo.',
  icon: TwistMuxIcon,
  defaultSize: { w: 10, h: 7 },
  minSize: { w: 4, h: 3 },
  component: TwistMuxWidget,
  properties: [
    {
      key: 'node',
      label: 'twist_mux node',
      kind: 'select',
      default: '',
      options: [{ value: '', label: 'Auto: the graph’s twist_mux' }],
      useOptions: useNodeOptions,
      help: 'Auto: the node named twist_mux, else one whose name has mux in it',
    },
    {
      key: 'animate',
      label: 'Animate the messages',
      kind: 'boolean',
      default: true,
      help: 'Each message moving along its wire, on to the output if it passes. Off, or with reduced motion: the wires only',
    },
    {
      key: 'controls',
      label: 'Controls',
      kind: 'boolean',
      default: true,
      help: 'For operators: a button on each lock, to lock or release it, and the joystick relay’s priority (Autonomous or Manual) and turbo steps, if one feeds the mux',
    },
  ],
});
