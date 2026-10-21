// An action, as the ros2 action verbs show it, and more: what its servers are
// doing, every goal whoever sent it with its status and latest feedback, to
// cancel one or all; a goal to send (send_goal) and how it goes, its result
// once done; the nodes serving and using it (info); its type's definition.

import { useEffect, useState } from 'react';

import type { ActionGoal, GraphSnapshot } from '../../../shared/monitor.ts';
import { connection } from '../../connection.ts';
import { useDialogs } from '../../dialogs.tsx';
import { ActionIcon, BanIcon, CodeIcon, CopyIcon, FlagIcon, InfoIcon, SendIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { MessageForm } from './MessageForm.tsx';
import { MessageView } from './MessageView.tsx';
import { cancelCodeText, formatSeconds, GOAL_DONE, goalTone, yamlText, type Entry } from './model.ts';
import { copy, Definition, DetailsHeader, Dot, NodeList, Section, useInterface, useNow, type Tab } from './parts.tsx';

export type ActionTab = 'goals' | 'send' | 'info' | 'type';

const TABS: Tab<ActionTab>[] = [
  { id: 'goals', label: 'Goals', title: 'What its servers are doing: every goal, whoever sent it', Icon: FlagIcon },
  { id: 'send', label: 'Send', title: 'Send a goal (ros2 action send_goal)', Icon: SendIcon },
  { id: 'info', label: 'Info', title: 'The nodes serving and using it (ros2 action info)', Icon: InfoIcon },
  { id: 'type', label: 'Type', title: 'Its type’s definition (ros2 interface show)', Icon: CodeIcon },
];

// Of the page's actions, kept while it lives
const drafts = new Map<string, unknown>();

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function Payload({ title, value, what }: { title: string; value: unknown; what: string }) {
  return (
    <Section
      title={title}
      detail={
        <button
          type="button"
          className="overlay-button mon-heading-button"
          title={`Copy the ${what}, as YAML`}
          aria-label={`Copy the ${what}`}
          onClick={() => copy(yamlText(value), `the ${what}`)}
        >
          <CopyIcon width={13} height={13} />
        </button>
      }
    >
      <MessageView message={value} />
    </Section>
  );
}

// A goal: its status, and opened its goal, feedback and result
function GoalCard({
  goal,
  open,
  onToggle,
  onCancel,
  now,
}: {
  goal: ActionGoal;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
  now: number;
}) {
  const done = GOAL_DONE.has(goal.status);
  const tone = goalTone(goal.status);
  // The server's clock: a simulation's, maybe
  const age = (now - goal.acceptedAt) / 1000;
  const since = !done && age >= 0 && age < 86_400 ? `for ${formatSeconds(age)}` : clock(goal.acceptedAt);
  return (
    <li className={`mon-goal${open ? ' open' : ''}`}>
      <div className="mon-goal-row">
        <button type="button" className="mon-goal-main" aria-expanded={open} onClick={onToggle}>
          <Dot tone={tone} />
          <span className={`mon-goal-status ${tone}`}>{goal.status}</span>
          <span className="mon-goal-id" title={goal.id}>
            {goal.id.slice(0, 8)}
          </span>
          {goal.sent && <span className="mon-self">sent here</span>}
          <span className="mon-goal-when" title={new Date(goal.acceptedAt).toLocaleString()}>
            {since}
          </span>
          {goal.feedbacks > 0 && <span className="mon-goal-feedbacks">{goal.feedbacks.toLocaleString()} feedback</span>}
        </button>
        {!done && (
          <button type="button" className="overlay-button" title="Cancel this goal" aria-label="Cancel this goal" onClick={onCancel}>
            <BanIcon width={15} height={15} />
          </button>
        )}
      </div>
      {open && (
        <div className="mon-goal-body">
          <dl className="mon-facts">
            <div>
              <dt>Goal ID</dt>
              <dd>{goal.id}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{new Date(goal.acceptedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {goal.sent && <Payload title="Goal" value={goal.sent.goal} what="goal" />}
          {goal.feedback !== null ? (
            <Payload title="Latest feedback" value={goal.feedback} what="feedback" />
          ) : (
            <p className="mon-muted">No feedback seen</p>
          )}
          {goal.sent?.result != null && <Payload title="Result" value={goal.sent.result} what="result" />}
          {goal.sent?.error && <p className="mon-error">{goal.sent.error}</p>}
          {!goal.sent && done && <p className="mon-muted">Its result went to the node that sent it</p>}
        </div>
      )}
    </li>
  );
}

function useCancel(action: string, type: string): (goal: string | null) => void {
  const dialogs = useDialogs();
  return (goal) => {
    void (async () => {
      if (
        goal === null &&
        !(await dialogs.confirm({
          title: `Cancel every goal of ${action}?`,
          message: 'Those of every node, not only the dashboard’s.',
          confirmLabel: 'Cancel them',
          danger: true,
        }))
      ) {
        return;
      }
      try {
        const result = await connection.cancelGoal(action, type, goal);
        if (result.code === 0) {
          notify(goal === null ? `Canceling ${result.canceling.length} goal${result.canceling.length === 1 ? '' : 's'}` : 'Canceling the goal');
        } else {
          notify(cancelCodeText(result.code), 'error');
        }
      } catch (e) {
        notify(`Could not cancel: ${e instanceof Error ? e.message : e}`, 'error');
      }
    })();
  };
}

function GoalsView({
  action,
  type,
  goals,
  status,
}: {
  action: string;
  type: string;
  goals: ActionGoal[] | null;
  status: { state: string; message: string };
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const now = useNow(1000);
  const cancel = useCancel(action, type);
  if (status.state === 'error') {
    return <p className="mon-error">{status.message}</p>;
  }
  if (!goals) {
    return <p className="mon-muted">Reading its goals…</p>;
  }
  const running = goals.filter((g) => !GOAL_DONE.has(g.status)).length;
  return (
    <div className="mon-pane-body">
      <div className="mon-bar">
        <span className="mon-bar-text">
          {running > 0 ? `${running} running` : 'None running'}
          {goals.length > running && ` · ${goals.length - running} done`}
        </span>
        <span className="mon-spacer" />
        <button type="button" className="button danger mon-small" disabled={running === 0} onClick={() => cancel(null)}>
          <BanIcon width={13} height={13} /> Cancel all
        </button>
      </div>
      {goals.length === 0 ? (
        <p className="mon-muted">No goal yet: those its servers accept show here, whoever sends them</p>
      ) : (
        <ul className="mon-goals">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              now={now}
              open={opened === goal.id}
              onToggle={() => setOpened((current) => (current === goal.id ? null : goal.id))}
              onCancel={() => cancel(goal.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SendView({ action, type, goals }: { action: string; type: string; goals: ActionGoal[] | null }) {
  const { info, error } = useInterface(type || null);
  const key = `${action} ${type}`;
  const [value, setValue] = useState<unknown>(() => drafts.get(key));
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const cancel = useCancel(action, type);
  const now = useNow(1000);
  const part = info?.parts.find((p) => p.name === 'goal');
  if (!type) {
    return <p className="mon-muted">Its type is not known</p>;
  }
  if (error) {
    return <p className="mon-error">{error}</p>;
  }
  if (!info || !part) {
    return <p className="mon-muted">Reading its definition…</p>;
  }
  const goal = value === undefined ? part.default : value;
  const latest = sent ? goals?.find((g) => g.id === sent) : undefined;
  const send = () => {
    setSending(true);
    setFailure(null);
    connection
      .sendGoal(action, type, goal)
      .then(
        (id) => setSent(id),
        (e: unknown) => setFailure(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSending(false));
  };
  return (
    <div className="mon-pane-body">
      <MessageForm
        info={info}
        type={part.type}
        value={goal}
        initial={part.default}
        onChange={(next) => {
          drafts.set(key, next);
          setValue(next);
        }}
        disabled={sending}
      />
      <div className="mon-actions">
        <button type="button" className="button primary" disabled={sending} onClick={send}>
          <SendIcon width={14} height={14} /> {sending ? 'Sending…' : 'Send the goal'}
        </button>
        {failure && (
          <span className="mon-result failed">
            <Dot tone="failed" />
            {failure}
          </span>
        )}
      </div>
      {latest && (
        <ul className="mon-goals">
          <GoalCard goal={latest} open now={now} onToggle={() => {}} onCancel={() => cancel(latest.id)} />
        </ul>
      )}
      {sent && !latest && <p className="mon-muted">Sent: waiting for its status…</p>}
    </div>
  );
}

export function ActionDetails({
  action,
  graph,
  initialTab,
  onClose,
}: {
  action: Entry;
  graph: GraphSnapshot;
  initialTab: ActionTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ActionTab>(initialTab);
  const type = action.types[0] ?? '';
  const [goals, setGoals] = useState<ActionGoal[] | null>(null);
  const [status, setStatus] = useState({ state: 'waiting', message: '' });
  const following = (tab === 'goals' || tab === 'send') && type !== '';
  useEffect(() => {
    if (!following) {
      return;
    }
    setGoals(null);
    return connection.subscribeAction(
      { action: action.name, actionType: type },
      {
        status: (state, message) => setStatus({ state, message }),
        goals: setGoals,
      },
    );
  }, [action.name, type, following]);

  const endpoints = graph.actions.find((a) => a.name === action.name);
  let content;
  if (tab === 'goals') {
    content = <GoalsView action={action.name} type={type} goals={goals} status={status} />;
  } else if (tab === 'send') {
    content = <SendView action={action.name} type={type} goals={goals} />;
  } else if (tab === 'info') {
    content = (
      <div className="mon-pane-body">
        <Section title="Servers" detail={endpoints?.servers.length ?? 0}>
          <NodeList nodes={endpoints?.servers ?? []} self={graph.self} empty="None: goals wait for one" />
        </Section>
        <Section title="Clients" detail={endpoints?.clients.length ?? 0}>
          <NodeList nodes={endpoints?.clients ?? []} self={graph.self} empty="None" />
        </Section>
      </div>
    );
  } else {
    content = type ? <Definition type={type} /> : <p className="mon-muted">Its type is not known</p>;
  }
  return (
    <section className="mon-details" aria-label={`${action.name}: details`}>
      <DetailsHeader name={action.name} type={action.types.join(', ')} Icon={ActionIcon} tabs={TABS} tab={tab} onTab={setTab} onClose={onClose} />
      <div className="mon-pane">{content}</div>
    </section>
  );
}
