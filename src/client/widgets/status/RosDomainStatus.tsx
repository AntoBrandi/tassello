// The ROS domain (ROS_DOMAIN_ID) the panel's widgets reach: the panel's own,
// or the server's (see src/server/domains.ts), as the page's connection was
// told by the server.

import { connection, useConnectionStatus } from '../../connection.ts';
import { NodesIcon } from '../../icons.tsx';
import { defineStatusWidget, type StatusWidgetProps } from '../types.ts';
import { domainReading } from './model.ts';
import { StatusReadout } from './StatusReadout.tsx';

interface RosDomainStatusConfig {
  label: string;
  markOther: boolean;
}

function RosDomainStatus({ config }: StatusWidgetProps<RosDomainStatusConfig>) {
  // The domain comes with the connection: it changes when the page connects again
  const status = useConnectionStatus();
  const reading = domainReading(status === 'open', connection.domainId, connection.serverDomainId, config.markOther);
  return (
    <StatusReadout
      icon={<NodesIcon width={16} height={16} />}
      value={reading.value}
      label={config.label.trim() || undefined}
      tone={reading.tone}
      title={reading.title}
      narrow="value"
    />
  );
}

export const rosDomainStatusWidget = defineStatusWidget<RosDomainStatusConfig>({
  type: 'ros-domain-status',
  name: 'ROS domain',
  description: 'The ROS_DOMAIN_ID the panel’s widgets reach: its own, or the server’s.',
  icon: NodesIcon,
  defaultWidth: 2,
  minWidth: 1,
  component: RosDomainStatus,
  properties: [
    { key: 'label', label: 'Label', kind: 'string', default: 'ROS domain', help: 'Next to the number, when the widget is wide enough' },
    {
      key: 'markOther',
      label: 'Mark another domain',
      kind: 'boolean',
      default: false,
      help: 'In yellow when the panel is not on the server’s domain',
    },
  ],
});
