// Actions for the monitor widgets: ros2 action send_goal, and what an
// action's servers are doing, whoever sent them their goals: every goal of
// the status topic (<action>/_action/status), with the latest feedback of
// each (<action>/_action/feedback). The goals the dashboard sends have their
// result too. Goals are canceled through the cancel service, one or all of
// them, whoever sent them.
//
// One follower per action, shared by its pages. It outlives them while the
// goals they sent run, and for LINGER_MS after: a page opened later finds
// them, their results included.

import { randomBytes } from 'node:crypto';

import rclnodejs from 'rclnodejs';

import type { ActionGoal, CancelResult, GoalStatus } from '../shared/monitor.ts';
import type { StreamState } from './frame_stream.ts';
import type { Interfaces } from './interfaces.ts';
import { missingCodeHint } from './message_code.ts';
import { echoJson, parseType } from './message_format.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

const STATUS_TYPE = 'action_msgs/msg/GoalStatusArray';
const CANCEL_TYPE = 'action_msgs/srv/CancelGoal';
// action_msgs/msg/GoalStatus's values, in order
const STATUSES: GoalStatus[] = ['unknown', 'accepted', 'executing', 'canceling', 'succeeded', 'canceled', 'aborted'];
const DONE = new Set<GoalStatus>(['succeeded', 'canceled', 'aborted']);
// Kept, the latest accepted
const MAX_GOALS = 20;
// Of the goals and feedback sent, the results
const TRUNCATE = 256;
const RESULT_TRUNCATE = 10_000;
const UPDATE_PERIOD_MS = 200;
const LINGER_MS = 10 * 60_000;
const SERVER_TIMEOUT_MS = 5000;

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

export interface ActionWatcher {
  onStatus: (state: StreamState, message: string) => void;
  onGoals: (goals: ActionGoal[]) => void;
}

interface Uuid {
  uuid: ArrayLike<number>;
}

interface Stamp {
  sec: number;
  nanosec: number;
}

// action_msgs/msg/GoalStatusArray
interface Statuses {
  status_list: { goal_info: { goal_id: Uuid; stamp: Stamp }; status: number }[];
}

interface GoalHandle {
  readonly accepted: boolean;
  readonly status: number;
  getResult(): Promise<unknown>;
}

interface ActionClient {
  waitForServer(timeout?: number): Promise<boolean>;
  sendGoal(goal: unknown, feedback?: unknown, goalUuid?: Uuid): Promise<GoalHandle>;
  destroy(): void;
}

// 8-4-4-4-12 hex digits
export function uuidText(uuid: ArrayLike<number>): string {
  const hex = Array.from(uuid, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidBytes(text: string): number[] {
  const hex = text.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`"${text}" is not a goal's UUID`);
  }
  return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function milliseconds(stamp: Stamp): number {
  return stamp.sec * 1000 + stamp.nanosec / 1e6;
}

class FollowedAction {
  readonly watchers = new Set<ActionWatcher>();
  // Of the dashboard's goals, running
  running = 0;
  lingerTimer: NodeJS.Timeout | null = null;
  private readonly node: rclnodejs.Node;
  private readonly interfaces: Interfaces;
  private readonly logger: Logger;
  private readonly action: string;
  private readonly type: string;
  private readonly goals = new Map<string, ActionGoal>();
  private readonly subscriptions: rclnodejs.Subscription[] = [];
  private client: ActionClient | null = null;
  private cancelClient: rclnodejs.Client<never> | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private updatedAt = 0;
  private state: StreamState = 'waiting';
  private message = '';

  constructor(node: rclnodejs.Node, interfaces: Interfaces, logger: Logger, action: string, type: string) {
    this.node = node;
    this.interfaces = interfaces;
    this.logger = logger;
    this.action = action;
    this.type = type;
    try {
      this.subscriptions.push(
        this.node.createSubscription(
          STATUS_TYPE,
          `${action}/_action/status`,
          {
            // The servers' own: their latest statuses, latched
            qos: new rclnodejs.QoS(
              HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
              1,
              ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
              DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL,
            ),
          },
          (message: unknown) => this.onStatuses(message as Statuses),
        ),
        this.node.createSubscription(
          // @ts-expect-error: the type is a runtime string, not one of the literal types
          `${type}_FeedbackMessage`,
          `${action}/_action/feedback`,
          {},
          (message: unknown) => this.onFeedback(message as { goal_id: Uuid; feedback: unknown }),
        ),
      );
      this.setState('streaming', '');
    } catch (e) {
      this.setState('error', `Cannot follow ${action}: ${missingCodeHint(errorMessage(e))}`);
    }
  }

  add(watcher: ActionWatcher): void {
    this.watchers.add(watcher);
    watcher.onStatus(this.state, this.message);
    watcher.onGoals(this.list());
  }

  // Resolves with the goal's UUID once accepted
  async send(goal: unknown): Promise<string> {
    const message = this.interfaces.message(`${this.type}_Goal`, goal);
    this.client ??= new rclnodejs.ActionClient(
      this.node,
      // @ts-expect-error: as above
      this.type,
      this.action,
    ) as unknown as ActionClient;
    if (!(await this.client.waitForServer(SERVER_TIMEOUT_MS))) {
      throw new Error(`No server of ${this.action}`);
    }
    const bytes = Array.from(randomBytes(16));
    const id = uuidText(bytes);
    const handle = await this.client.sendGoal(message, undefined, { uuid: bytes });
    if (!handle.accepted) {
      throw new Error(`${this.action} rejected the goal`);
    }
    const now = Date.now();
    const sent = { goal: echoJson(message, TRUNCATE), at: now, result: null as unknown, error: null as string | null };
    const known = this.goals.get(id);
    this.goals.set(id, {
      id,
      status: known?.status ?? 'accepted',
      acceptedAt: known?.acceptedAt ?? now,
      feedback: known?.feedback ?? null,
      feedbacks: known?.feedbacks ?? 0,
      updatedAt: now,
      sent,
    });
    this.running++;
    this.changed();
    handle
      .getResult()
      .then(
        (result) => {
          sent.result = echoJson(result, RESULT_TRUNCATE);
          this.update(id, STATUSES[handle.status] ?? 'unknown');
        },
        (e: unknown) => {
          sent.error = `No result: ${errorMessage(e)}`;
          this.update(id, null);
        },
      )
      .finally(() => {
        this.running--;
        this.onIdle?.();
      });
    return id;
  }

  // Cancels the goal, or all of them (null)
  async cancel(goal: string | null): Promise<CancelResult> {
    this.cancelClient ??= this.node.createClient(CANCEL_TYPE, `${this.action}/_action/cancel_goal`) as unknown as rclnodejs.Client<never>;
    const client = this.cancelClient as unknown as {
      waitForService(timeout: number): Promise<boolean>;
      sendRequestAsync(request: unknown, options: { timeout: number }): Promise<{ return_code: number; goals_canceling: { goal_id: Uuid }[] }>;
    };
    if (!(await client.waitForService(SERVER_TIMEOUT_MS))) {
      throw new Error(`No server of ${this.action}`);
    }
    const response = await client.sendRequestAsync(
      {
        goal_info: {
          goal_id: { uuid: goal === null ? new Array(16).fill(0) : uuidBytes(goal) },
          stamp: { sec: 0, nanosec: 0 },
        },
      },
      { timeout: SERVER_TIMEOUT_MS },
    );
    return {
      code: response.return_code,
      canceling: Array.from(response.goals_canceling, (info) => uuidText(info.goal_id.uuid)),
    };
  }

  // Called when its last page went and no goal of the dashboard's runs
  onIdle: (() => void) | null = null;

  destroy(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
    }
    for (const subscription of this.subscriptions) {
      this.node.destroySubscription(subscription);
    }
    if (this.cancelClient) {
      this.node.destroyClient(this.cancelClient);
    }
    this.client?.destroy();
  }

  private onStatuses(message: Statuses): void {
    const now = Date.now();
    for (const { goal_info, status } of message.status_list) {
      const id = uuidText(goal_info.goal_id.uuid);
      const known = this.goals.get(id);
      const value = STATUSES[status] ?? 'unknown';
      if (!known) {
        this.goals.set(id, {
          id,
          status: value,
          acceptedAt: milliseconds(goal_info.stamp),
          feedback: null,
          feedbacks: 0,
          updatedAt: now,
          sent: null,
        });
      } else if (known.status !== value && !(DONE.has(known.status) && known.sent?.result)) {
        known.status = value;
        known.acceptedAt = milliseconds(goal_info.stamp);
        known.updatedAt = now;
      } else {
        known.acceptedAt = milliseconds(goal_info.stamp);
      }
    }
    this.changed();
  }

  private onFeedback(message: { goal_id: Uuid; feedback: unknown }): void {
    const id = uuidText(message.goal_id.uuid);
    const now = Date.now();
    let goal = this.goals.get(id);
    if (!goal) {
      // Before its status
      goal = { id, status: 'executing', acceptedAt: now, feedback: null, feedbacks: 0, updatedAt: now, sent: null };
      this.goals.set(id, goal);
    }
    goal.feedback = echoJson(message.feedback, TRUNCATE);
    goal.feedbacks++;
    goal.updatedAt = now;
    this.changed();
  }

  private update(id: string, status: GoalStatus | null): void {
    const goal = this.goals.get(id);
    if (goal) {
      if (status) {
        goal.status = status;
      }
      goal.updatedAt = Date.now();
      this.changed();
    }
  }

  // The latest accepted first
  private list(): ActionGoal[] {
    return [...this.goals.values()].sort((a, b) => b.acceptedAt - a.acceptedAt).slice(0, MAX_GOALS);
  }

  // To the pages, at most every UPDATE_PERIOD_MS
  private changed(): void {
    // Those beyond the latest MAX_GOALS go, but those still running
    if (this.goals.size > MAX_GOALS) {
      const kept = new Set(this.list().map((g) => g.id));
      for (const [id, goal] of this.goals) {
        if (!kept.has(id) && DONE.has(goal.status)) {
          this.goals.delete(id);
        }
      }
    }
    if (this.updateTimer) {
      return;
    }
    const send = () => {
      this.updateTimer = null;
      this.updatedAt = Date.now();
      const goals = this.list();
      for (const watcher of this.watchers) {
        watcher.onGoals(goals);
      }
    };
    const wait = this.updatedAt + UPDATE_PERIOD_MS - Date.now();
    if (wait > 0) {
      this.updateTimer = setTimeout(send, wait);
    } else {
      send();
    }
  }

  private setState(state: StreamState, message: string): void {
    if (state === 'error') {
      this.logger.warn(message);
    }
    this.state = state;
    this.message = message;
    for (const watcher of this.watchers) {
      watcher.onStatus(state, message);
    }
  }
}

export class Actions {
  private readonly node: rclnodejs.Node;
  private readonly interfaces: Interfaces;
  private readonly logger: Logger;
  private readonly followed = new Map<string, FollowedAction>();

  constructor(node: rclnodejs.Node, interfaces: Interfaces, logger: Logger) {
    this.node = node;
    this.interfaces = interfaces;
    this.logger = logger;
  }

  // The action's goals, now and whenever they change, until the returned
  // function is called
  watch(action: string, type: string, watcher: ActionWatcher): () => void {
    const followed = this.follow(action, type);
    followed.add(watcher);
    return () => {
      followed.watchers.delete(watcher);
      this.release(followed);
    };
  }

  // ros2 action send_goal: resolves with the goal's UUID once accepted
  send(action: string, type: string, goal: unknown): Promise<string> {
    const followed = this.follow(action, type);
    return followed.send(goal).finally(() => this.release(followed));
  }

  cancel(action: string, type: string, goal: string | null): Promise<CancelResult> {
    const followed = this.follow(action, type);
    return followed.cancel(goal).finally(() => this.release(followed));
  }

  stopAll(): void {
    for (const followed of this.followed.values()) {
      followed.destroy();
    }
    this.followed.clear();
  }

  private follow(action: string, type: string): FollowedAction {
    const name = absoluteTopic(action);
    if (parseType(type).kind !== 'action') {
      throw new Error(`${type} is not an action type (package/action/Name)`);
    }
    const key = `${name} ${type}`;
    let followed = this.followed.get(key);
    if (!followed) {
      const created = new FollowedAction(this.node, this.interfaces, this.logger, name, type);
      created.onIdle = () => this.release(created);
      this.followed.set(key, created);
      followed = created;
    }
    if (followed.lingerTimer) {
      clearTimeout(followed.lingerTimer);
      followed.lingerTimer = null;
    }
    return followed;
  }

  // Once nothing needs it: for LINGER_MS more
  private release(followed: FollowedAction): void {
    if (followed.watchers.size > 0 || followed.running > 0 || followed.lingerTimer) {
      return;
    }
    followed.lingerTimer = setTimeout(() => {
      for (const [key, f] of this.followed) {
        if (f === followed) {
          this.followed.delete(key);
        }
      }
      followed.destroy();
    }, LINGER_MS);
  }
}
