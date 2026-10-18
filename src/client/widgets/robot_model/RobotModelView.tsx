// The robot model widget's content, loaded with three.js only when a panel
// shows one (see RobotModelWidget.tsx)

import { useEffect, useRef, useState } from 'react';

import { connection } from '../../connection.ts';
import { CubeIcon, FitIcon } from '../../icons.tsx';
import type { RobotModelConfig } from './RobotModelWidget.tsx';
import { RobotViewer, type JointMotion } from './RobotViewer.ts';

const STRING = 'std_msgs/msg/String';
const JOINT_STATE = 'sensor_msgs/msg/JointState';

interface JointStateMessage {
  header: { stamp: { sec: number; nanosec: number } };
  name: string[];
  position: number[];
  velocity: number[];
}

export default function RobotModelView({ config }: { config: RobotModelConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<RobotViewer | null>(null);
  // What hides the model: waiting for it, or why it is not there
  const [problem, setProblem] = useState<{ state: string; message: string } | null>({
    state: 'waiting',
    message: 'Connecting…',
  });
  const [loading, setLoading] = useState<{ loaded: number; total: number } | null>(null);
  const [failedMeshes, setFailedMeshes] = useState<string[]>([]);
  const [jointsProblem, setJointsProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState<JointMotion[]>([]);

  useEffect(() => {
    const created = new RobotViewer(containerRef.current!, setMoving);
    viewer.current = created;
    return () => {
      created.dispose();
      viewer.current = null;
    };
  }, []);

  const descriptionTopic = config.descriptionTopic.trim();
  useEffect(() => {
    if (!descriptionTopic) {
      setProblem({ state: 'error', message: 'No robot description topic: set one in edit mode' });
      return;
    }
    setProblem({ state: 'waiting', message: 'Connecting…' });
    let loaded = '';
    let current = true;
    const unsubscribe = connection.subscribeTopic(
      { topic: descriptionTopic, maxRate: 1 },
      {
        status: (state, message) => {
          if (state !== 'streaming' && !loaded) {
            setProblem({ state, message });
          }
        },
        message: (messageType, message) => {
          const urdf = (message as { data?: unknown }).data;
          if (messageType !== STRING || typeof urdf !== 'string') {
            setProblem({ state: 'error', message: `${descriptionTopic} is a ${messageType}, not a ${STRING}` });
            return;
          }
          // The same description again, e.g. after a reconnection
          if (urdf === loaded || !viewer.current) {
            return;
          }
          loaded = urdf;
          setFailedMeshes([]);
          try {
            viewer.current
              .load(urdf, (done, total) => current && setLoading({ loaded: done, total }))
              .then((failed) => {
                if (current) {
                  setLoading(null);
                  setFailedMeshes(failed);
                }
              });
            setProblem(null);
          } catch (e) {
            setProblem({ state: 'error', message: `Invalid robot description: ${e instanceof Error ? e.message : e}` });
          }
        },
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [descriptionTopic]);

  const jointStatesTopic = config.jointStatesTopic.trim();
  useEffect(() => {
    setJointsProblem(null);
    if (!jointStatesTopic) {
      return;
    }
    return connection.subscribeTopic(
      { topic: jointStatesTopic, maxRate: 20 },
      {
        status: (state, message) => setJointsProblem(state === 'streaming' ? null : message),
        message: (messageType, message) => {
          if (messageType !== JOINT_STATE) {
            setJointsProblem(`${jointStatesTopic} is a ${messageType}, not a ${JOINT_STATE}`);
            return;
          }
          const { header, name, position, velocity } = message as JointStateMessage;
          viewer.current?.setJointStates(
            name,
            position,
            velocity.length === name.length ? velocity : undefined,
            header.stamp.sec + header.stamp.nanosec * 1e-9,
          );
        },
      },
    );
  }, [jointStatesTopic]);

  useEffect(() => viewer.current?.setShowFrames(config.showFrames), [config.showFrames]);
  useEffect(() => viewer.current?.setHighlight(config.highlightMotion), [config.highlightMotion]);

  const notes = [
    jointsProblem && !problem ? `Joints still: ${jointsProblem}` : null,
    failedMeshes.length > 0 ? `${failedMeshes.length} mesh(es) could not be loaded` : null,
  ].filter(Boolean);

  return (
    <div className="robot-model">
      <div ref={containerRef} className="robot-canvas" />
      {problem && (
        <div className={`robot-overlay ${problem.state}`}>
          <CubeIcon width={28} height={28} />
          <span>{problem.message}</span>
        </div>
      )}
      {!problem && (
        <div className="overlay-toolbar">
          <button
            type="button"
            className="overlay-button"
            title="Reset the view"
            aria-label="Reset the view"
            onClick={() => viewer.current?.resetView()}
          >
            <FitIcon width={17} height={17} />
          </button>
        </div>
      )}
      {loading && loading.loaded < loading.total && (
        <div className="robot-loading">
          Loading meshes {loading.loaded}/{loading.total}
        </div>
      )}
      <div className="robot-notes">
        {config.highlightMotion &&
          moving.map((joint) => (
            <span key={joint.name} className="robot-motion">
              {joint.velocity >= 0 ? '+' : '−'} {joint.name} {Math.abs(joint.velocity).toFixed(2)} {joint.unit}
            </span>
          ))}
        {notes.map((note) => (
          <span key={note} className="robot-note">
            {note}
          </span>
        ))}
      </div>
    </div>
  );
}
