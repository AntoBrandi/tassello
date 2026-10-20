// What the views of the behavior tree inspector share

import type { BtNode } from '../../../shared/protocol.ts';
import {
  ArrowRightIcon,
  BoltIcon,
  CheckCircleIcon,
  DiamondIcon,
  ForkIcon,
  ParallelIcon,
  QuestionMarkIcon,
  RefreshIcon,
  TreeIcon,
} from '../../icons.tsx';

// What the node does, by its shape: → sequences, ? fallbacks, ⇉ parallels,
// ↻ retries, ◇ decorators, ⚡ actions, ✓ conditions, the tree of subtrees
function iconOf(node: Pick<BtNode, 'kind' | 'type'>) {
  switch (node.kind) {
    case 'control':
      if (/Sequence/.test(node.type)) {
        return ArrowRightIcon;
      }
      if (/Fallback/.test(node.type)) {
        return QuestionMarkIcon;
      }
      if (/Parallel/.test(node.type)) {
        return ParallelIcon;
      }
      return /Recovery|Retry/.test(node.type) ? RefreshIcon : ForkIcon;
    case 'decorator':
      return /Retry|Repeat|Loop/.test(node.type) ? RefreshIcon : DiamondIcon;
    case 'action':
      return BoltIcon;
    case 'condition':
      return CheckCircleIcon;
    case 'subtree':
      return TreeIcon;
    default:
      return null;
  }
}

// None for the nodes not in the tree file, whose kind is not known
export function KindIcon({ node, size = 14 }: { node: Pick<BtNode, 'kind' | 'type'>; size?: number }) {
  const Icon = iconOf(node);
  return Icon && <Icon className="bt-kind" width={size} height={size} />;
}

// "Control", for the tooltips and details
export function kindLabel(node: Pick<BtNode, 'kind'>): string {
  return node.kind ? node.kind.charAt(0).toUpperCase() + node.kind.slice(1) : 'Not in the tree file';
}
